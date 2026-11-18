package open.fpvlabs.stera.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.NetworkRequest
import android.os.Build
import android.net.NetworkCapabilities
import androidx.annotation.RequiresApi
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Which OS mechanism carries the transfer on this device. */
object SchedulerKind {
    const val UIDT = "uidt"
    const val WORKMANAGER = "workmanager"
    const val UNSUPPORTED = "unsupported"

    /**
     * API 34+: user-initiated data-transfer job (JobScheduler). API 33: foreground
     * WorkManager. Below 33 the SA-18 source identity (nanosecond file times) is
     * unavailable, so native upload is unsupported rather than weakened.
     */
    fun forApi(api: Int): String = when {
        api >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> UIDT
        api >= Build.VERSION_CODES.TIRAMISU -> WORKMANAGER
        else -> UNSUPPORTED
    }
}

class ScheduleResult(val scheduled: Boolean, val scheduler: String, val reason: String?)

/**
 * Runs [build] (JobInfo construction AND `JobScheduler.schedule`, returning its result code) so that every
 * failure, including a builder one, leaves a durable needs-visible-Resume via [markNeedsResume] instead of
 * escaping. [JobScheduler.RESULT_SUCCESS] is 1.
 */
internal fun guardedUidtSchedule(markNeedsResume: (String) -> Unit, build: () -> Int): ScheduleResult {
    return try {
        if (build() == 1) ScheduleResult(true, SchedulerKind.UIDT, null)
        else {
            markNeedsResume("background_start_denied")
            ScheduleResult(false, SchedulerKind.UIDT, "background_start_denied")
        }
    } catch (e: SecurityException) {
        markNeedsResume("uidt_permission_missing")
        ScheduleResult(false, SchedulerKind.UIDT, "uidt_permission_missing")
    } catch (e: RuntimeException) {
        markNeedsResume("uidt_job_invalid")
        ScheduleResult(false, SchedulerKind.UIDT, "uidt_job_invalid")
    }
}

object UploadScheduler {
    const val JOB_ID = 570057
    const val WORK_NAME = "stateaction.native_upload"

    /**
     * Must be called from a visible user action (the bridge checks). A refused
     * UIDT start or an unusable foreground start leaves a durable
     * needs-visible-Resume instead of retrying illegally.
     */
    fun schedule(context: Context, runtime: UploadRuntime): ScheduleResult {
        val kind = SchedulerKind.forApi(Build.VERSION.SDK_INT)
        if (kind == SchedulerKind.UNSUPPORTED) return ScheduleResult(false, kind, "unsupported_api")
        val policy = runtime.gate.read().policy
        if (policy.capturePaused) return ScheduleResult(false, kind, "capture_paused")
        if (!runtime.hasRunnable()) return ScheduleResult(false, kind, "nothing_to_upload")
        if (!UploadNotifications(context).permitted()) return ScheduleResult(false, kind, "notification_permission_required")
        return if (kind == SchedulerKind.UIDT && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            scheduleUidt(context, runtime, policy)
        } else {
            scheduleWork(context, policy)
        }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun scheduleUidt(context: Context, runtime: UploadRuntime, policy: TransferPolicy): ScheduleResult {
        // Building the JobInfo can itself throw (invalid combination, missing service): it belongs inside the
        // same durable needs-visible-Resume handling as the schedule call.
        return guardedUidtSchedule({ runtime.markNeedsVisibleResume(it) }) {
            val js = context.getSystemService(JobScheduler::class.java)
            val net = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            if (policy.requireUnmetered) net.addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            val remaining = runtime.journal.all().filter { it.state.runnable }
                .sumOf { t -> t.plan.sizeBytes - t.parts.count { it.etag != null } * Limits.PART_BYTES }.coerceAtLeast(1L)
            val info = JobInfo.Builder(JOB_ID, ComponentName(context, UploadJobService::class.java))
                .setUserInitiated(true)
                .setRequiredNetwork(net.build())
                .setRequiresCharging(policy.requireCharging)
                .setEstimatedNetworkBytes(0, remaining)
                .setPersisted(true)
                .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                .build()
            // Re-scheduling the same id replaces the pending/running job; a replaced run that is still winding
            // down makes the new job see the run lock held, which asks the OS to retry (see runLoop).
            js.schedule(info)
        }
    }

    private fun scheduleWork(context: Context, policy: TransferPolicy): ScheduleResult {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (policy.requireUnmetered) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(policy.requireCharging)
            .build()
        val request = OneTimeWorkRequest.Builder(UploadWorker::class.java)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        // APPEND_OR_REPLACE, not REPLACE: a still-running older worker is never cancelled mid-handoff and the new
        // one starts only after it finishes (so it cannot find the run lock held and quit "successfully").
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        return ScheduleResult(true, SchedulerKind.WORKMANAGER, null)
    }

    fun cancel(context: Context) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                context.getSystemService(JobScheduler::class.java).cancel(JOB_ID)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
            }
        } catch (e: RuntimeException) {
            // Best effort: the engine's own gate check already stops every effect.
        }
    }
}

class UploadNotifications(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    fun permitted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun channel() {
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Recording uploads", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private fun openApp(): PendingIntent {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent().setPackage(context.packageName)
        launch.putExtra(EXTRA_RESUME, true)
        return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun running(task: TaskRecord?): Notification {
        channel()
        val pause = PendingIntent.getBroadcast(
            context, 1, Intent(context, UploadControlReceiver::class.java).setAction(UploadControlReceiver.ACTION_PAUSE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val total = task?.plan?.partCount ?: 0
        val done = task?.landedCount ?: 0
        return Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Uploading recording")
            .setContentText(if (total > 0) "$done of $total parts" else "Preparing upload")
            .setProgress(total, done, total == 0)
            .setOngoing(true)
            .setContentIntent(openApp())
            .addAction(Notification.Action.Builder(null, "Pause", pause).build())
            .build()
    }

    fun progress(task: TaskRecord) {
        if (!permitted()) return
        if (task.state == TaskState.RUNNING || task.state == TaskState.QUEUED) manager.notify(NOTICE_ID, running(task))
    }

    /** A durable, user-visible prompt: the OS would not let us start in the background. */
    fun needsResume() {
        if (!permitted()) return
        channel()
        manager.notify(
            RESUME_ID,
            Notification.Builder(context, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("Upload paused").setContentText("Open StateAction and tap Resume to continue uploading.")
                .setContentIntent(openApp()).setAutoCancel(true).build(),
        )
    }

    companion object {
        const val CHANNEL = "stateaction_native_upload"
        const val NOTICE_ID = 570057
        const val RESUME_ID = 570058
        const val EXTRA_RESUME = "ai.stateaction.native_upload.resume"
    }
}

/** Notification "Pause" action: stops the active run gracefully; the next start needs a visible Resume. */
class UploadControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_PAUSE) return
        val rt = UploadRuntime.get(context)
        if (rt.enabled) rt.pause(null)
    }

    companion object {
        const val ACTION_PAUSE = "ai.stateaction.native_upload.PAUSE"
    }
}

/** What the OS entry points need from the runtime; a seam so the loop's policy is testable on the JVM. */
internal interface RunPort {
    fun runNext(cancel: CancelToken): RunOutcome?
    fun hasRunnable(): Boolean
    fun needsResume()
    fun failSafe(reason: String)
}

internal class RuntimeRunPort(
    private val rt: UploadRuntime,
    private val network: android.net.Network?,
) : RunPort {
    override fun runNext(cancel: CancelToken): RunOutcome? = rt.runNext(network, AndroidHttpTransport(network), cancel)
    override fun hasRunnable(): Boolean = rt.hasRunnable()
    override fun needsResume() = rt.notifications.needsResume()
    override fun failSafe(reason: String) = rt.failSafe(reason)
}

/**
 * Runs queued tasks one at a time until none is eligible; returns whether the OS should retry later.
 * A run that finds the run lock held by an older job never "succeeds" while work remains (that would strand
 * the queue); it asks the OS to retry. An unexpected exception leaves a durable safe state and a visible prompt.
 */
internal fun runLoop(port: RunPort, cancel: CancelToken): Boolean {
    var retry = false
    var guardCount = 0
    try {
        while (!cancel.cancelled && guardCount++ < 1000) {
            val outcome = port.runNext(cancel)
            if (outcome == null) {
                // Nothing eligible, or another run holds the lock: only the latter leaves runnable work behind.
                if (port.hasRunnable()) retry = true
                break
            }
            if (outcome.unsettled) {
                port.failSafe(outcome.reason ?: "engine_error")
                break
            }
            when (outcome.state) {
                TaskState.BACKOFF, TaskState.WAITING_POLICY -> { retry = true; break }
                TaskState.NEEDS_VISIBLE_RESUME -> port.needsResume()
                else -> Unit
            }
        }
    } catch (e: Throwable) {
        // Never a silent RUNNING: persist a safe state if the journal allows it and tell the user.
        try { port.failSafe("engine_error") } catch (x: Throwable) { /* the prompt is best effort */ }
        retry = false
    }
    return retry
}

/** API 34+ user-initiated data-transfer job. Scheduled only from a visible action. */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class UploadJobService : JobService() {
    @Volatile private var cancel: CancelToken? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val rt = UploadRuntime.get(this)
        if (!rt.enabled || !rt.hasRunnable()) return false
        val token = CancelToken()
        cancel = token
        val first = rt.nextRunnable()
        setNotification(
            params, UploadNotifications.NOTICE_ID, rt.notifications.running(first),
            JobService.JOB_END_NOTIFICATION_POLICY_DETACH,
        )
        Thread({
            var retry = false
            try {
                retry = runLoop(RuntimeRunPort(rt, params.network), token)
            } finally {
                jobFinished(params, retry)
            }
        }, "native-upload").start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        // Constraint lost, thermal, quota or user Stop: halt effects now; the journal already holds the state.
        cancel?.cancel("system_stop")
        return params.stopReason != JobParameters.STOP_REASON_CANCELLED_BY_APP
    }
}

/** API 33 foreground WorkManager fallback. A foreground start the OS refuses becomes a visible-Resume prompt. */
class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    @Volatile private var cancel: CancelToken? = null

    override fun doWork(): Result {
        val rt = UploadRuntime.get(applicationContext)
        if (!rt.enabled || !rt.hasRunnable()) return Result.success()
        try {
            val info = ForegroundInfo(
                UploadNotifications.NOTICE_ID, rt.notifications.running(rt.nextRunnable()),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
            setForegroundAsync(info).get()
        } catch (e: Exception) {
            // Typically ForegroundServiceStartNotAllowedException: a constraint woke us in the background.
            rt.markNeedsVisibleResume("background_start_denied")
            return Result.success()
        }
        val token = CancelToken()
        cancel = token
        return if (runLoop(RuntimeRunPort(rt, null), token)) Result.retry() else Result.success()
    }

    override fun onStopped() {
        // Constraint lost, quota, the 6 h/24 h dataSync timeout or app cancel: stop effects; state is journaled.
        cancel?.cancel("system_stop")
    }
}
