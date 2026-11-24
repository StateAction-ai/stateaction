package open.fpvlabs.stera.upload

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicLong

/**
 * True while at least one activity of this app is started and visible. UIDT jobs and
 * foreground services may only be started from a visible user action, so the bridge
 * refuses `resume` otherwise (fail closed: unknown means not visible).
 *
 * Lifecycle callbacks only see transitions after registration, so an activity that
 * was already started when the plugin attached (cached engine, late attach,
 * re-attach after a configuration change) is [seed]ed from its live window state.
 */
class VisibilityTracker(
    private val startedProbe: (Activity) -> Boolean = ::windowLooksStarted,
) : Application.ActivityLifecycleCallbacks {
    private val started: MutableSet<Activity> = java.util.Collections.synchronizedSet(
        java.util.Collections.newSetFromMap(java.util.WeakHashMap<Activity, Boolean>()),
    )
    val visible: Boolean get() = started.isNotEmpty()

    /**
     * Counts [activity] when its live window shows it is already started (idempotent). It never removes one:
     * a "not visible yet" window during onStart must not erase what the callbacks already saw.
     */
    fun seed(activity: Activity) {
        if (startedProbe(activity)) started.add(activity)
    }

    override fun onActivityStarted(activity: Activity) { started.add(activity) }
    override fun onActivityStopped(activity: Activity) { started.remove(activity) }
    override fun onActivityDestroyed(activity: Activity) { started.remove(activity) }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

    companion object {
        /** A stopped activity's decor view is made invisible by the framework; a started one is attached and visible. */
        fun windowLooksStarted(activity: Activity): Boolean {
            if (activity.isFinishing || activity.isDestroyed) return false
            val decor = activity.window?.peekDecorView() ?: return false
            return decor.isAttachedToWindow && decor.windowVisibility == android.view.View.VISIBLE
        }
    }
}

/**
 * Channel `ai.stateaction/native_upload` (schemaVersion 1). Every method other
 * than `capabilities` is refused with `feature_gated` unless the build enabled
 * native upload. Calls run on a worker thread (the journal fsyncs) and reply on
 * the platform thread. Nothing here logs cookies, signed URLs or plans.
 */
class NativeUploadMethodChannelHandler(
    messenger: BinaryMessenger,
    private val context: Context,
    private val visibility: VisibilityTracker,
    private val runtimeFactory: (Context) -> UploadRuntime = { UploadRuntime.get(it) },
    private val executor: ExecutorService = Executors.newSingleThreadExecutor(),
    /** Dedicated single thread for logout / capture-pause durability so a stalled normal call can never delay it. */
    private val priority: ExecutorService = Executors.newSingleThreadExecutor(),
    /** The already-built runtime without touching disk (an active transfer implies it exists), or null. */
    private val peekRuntime: () -> UploadRuntime? = { UploadRuntime.peek() },
) : MethodChannel.MethodCallHandler {
    private val channel = MethodChannel(messenger, CHANNEL)
    private val main = Handler(Looper.getMainLooper())

    /** Set once the runtime was built off the platform thread (it reads files); null until then. */
    @Volatile private var builtRuntime: UploadRuntime? = null

    /**
     * The runtime if it already exists in this process (built by the priority thread, or earlier by a job / worker).
     * A transfer can only be running when it exists, so a null result means there is nothing in memory to fence.
     */
    private val warmRuntime: UploadRuntime? get() = builtRuntime ?: peekRuntime()?.also { builtRuntime = it }
    private val warm = CountDownLatch(1)

    /** Counts valid unbind / capture-pause receipts on the platform thread; normal binds/enqueues that predate one are stale. */
    private val invalidationReceipts = AtomicLong(0)
    private val callFence = CallFence(invalidationReceipts) { runtimeFactory(context).gate.fenceSeq() }

    init {
        channel.setMethodCallHandler(this)
        try {
            priority.execute {
                try {
                    val rt = runtimeFactory(context)
                    builtRuntime = rt
                    // An unfinished invalidation from before a restart is completed before anything else may run.
                    if (rt.enabled) try { rt.recoverIfPending() } catch (e: Exception) { /* stays fenced */ }
                } catch (e: Exception) {
                    // The first call surfaces the failure.
                } finally {
                    warm.countDown()
                }
            }
        } catch (e: RejectedExecutionException) {
            warm.countDown()
        }
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
        executor.shutdown()
        priority.shutdown()
    }

    private class Failure(val code: String, message: String) : Exception(message)

    private class ErrorReply(val code: String, val message: String?)

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        // Priority path: validated here on the platform thread, fenced in memory at once, then made durable on the
        // dedicated thread. The ack is sent only after the durable boundary; a failure is reported, the fence stays.
        when (call.method) {
            "unbindOwner" -> return priorityUnbind(call, result)
            "setCaptureActive" -> return priorityCapture(call, result)
        }
        val receipt = callFence.next()
        runOn(executor, result) {
            warm.await()
            handle(call, receipt)
        }
    }

    private fun runOn(pool: ExecutorService, result: MethodChannel.Result, body: () -> Map<String, Any?>) {
        try {
            pool.execute {
                val out: Any = try {
                    body()
                } catch (e: Failure) {
                    ErrorReply(e.code, e.message)
                } catch (e: BridgeArgs.Invalid) {
                    ErrorReply("bad_args", e.message)
                } catch (e: PlanException) {
                    ErrorReply(e.code, e.message)
                } catch (e: Exception) {
                    // Never forward exception text: it could carry a path or a URL.
                    ErrorReply("native_error", e.javaClass.simpleName)
                }
                main.post {
                    if (out is ErrorReply) result.error(out.code, out.message, null) else result.success(out)
                }
            }
        } catch (e: RejectedExecutionException) {
            result.error("unsupported", "native upload bridge disposed", null)
        }
    }

    private fun priorityUnbind(call: MethodCall, result: MethodChannel.Result) {
        val fenceRevision: Long
        try {
            val m = BridgeArgs.root(call.arguments)
            fenceRevision = if (m["fenceRevision"] == null) 0L else BridgeArgs.dec(m, "fenceRevision")
        } catch (e: BridgeArgs.Invalid) {
            return result.error("bad_args", e.message, null)
        }
        invalidationReceipts.incrementAndGet()
        // Only an already-built runtime can be fenced without touching the disk; otherwise the priority thread
        // (which also builds it) does both steps in order, and normal binds/enqueues are refused as superseded.
        val early = warmRuntime?.takeIf { it.enabled }?.invalidateOwnerNow(fenceRevision)
        runOn(priority, result) {
            val rt = runtimeFactory(context)
            if (!rt.enabled) throw Failure("feature_gated", "native upload is not enabled in this build")
            val seq = early ?: rt.invalidateOwnerNow(fenceRevision)
            rt.completeUnbind(seq, fenceRevision)
            ok()
        }
    }

    private fun priorityCapture(call: MethodCall, result: MethodChannel.Result) {
        val active: Boolean
        try {
            active = BridgeArgs.bool(BridgeArgs.root(call.arguments), "active")
        } catch (e: BridgeArgs.Invalid) {
            return result.error("bad_args", e.message, null)
        }
        val rtNow = warmRuntime?.takeIf { it.enabled }
        // active=true means a capture is in progress: transfer is paused while it is.
        val pauseSeq = if (active) rtNow?.pauseCaptureNow() else null
        val releaseSeq = if (!active) rtNow?.captureSeq() else null
        runOn(priority, result) {
            val rt = runtimeFactory(context)
            if (!rt.enabled) throw Failure("feature_gated", "native upload is not enabled in this build")
            if (active) rt.completeCapturePaused(pauseSeq ?: rt.pauseCaptureNow())
            else rt.releaseCapture(releaseSeq ?: rt.captureSeq())
            ok()
        }
    }

    private fun handle(call: MethodCall, receipt: Long): Map<String, Any?> {
        if (call.method == "capabilities") return capabilities()
        val rt = runtimeFactory(context)
        if (!rt.enabled) throw Failure("feature_gated", "native upload is not enabled in this build")
        val m = BridgeArgs.root(call.arguments)
        return when (call.method) {
            "bindOwner" -> {
                // A logout/unbind received after this call arrived makes it stale: it may not install anything.
                // The exact gate-sequence snapshot taken by admit() is what the runtime and gate re-check.
                val seq = admit(receipt, "superseded")
                val r = rt.bindOwner(
                    BridgeArgs.ownerId(m), BridgeArgs.str(m, "backendOrigin"),
                    BridgeArgs.dec(m, "sessionRevision"), BridgeArgs.cookies(m), seq,
                )
                ok("accepted" to r.ok, "reason" to r.code, "ownerGeneration" to r.value.toString())
            }
            "verifyOwner" -> { admit(receipt, "owner_changed"); verifyOwner(rt, BridgeArgs.ownerId(m)) }
            "exportSession" -> exportSession(rt)
            "setPolicy" -> {
                // Owner-scoped: a call that arrived before a logout/unbind, or names another owner, is refused.
                val seq = admit(receipt, "owner_changed")
                val gen = if (m["ownerGeneration"] == null) null else BridgeArgs.dec(m, "ownerGeneration")
                val g = try {
                    rt.setPolicy(BridgeArgs.ownerId(m), BridgeArgs.bool(m, "requireUnmetered"), BridgeArgs.bool(m, "requireCharging"), gen, seq)
                } catch (e: PolicyRejectedException) {
                    throw Failure(e.code, "policy write refused")
                }
                ok(
                    "requireUnmetered" to g.policy.requireUnmetered,
                    "requireCharging" to g.policy.requireCharging,
                    "ownerGeneration" to g.generation.toString(),
                )
            }
            "enqueue" -> {
                val r = rt.enqueue(BridgeArgs.enqueue(m), admit(receipt, "owner_changed"))
                if (!r.ok) throw Failure(r.code ?: "enqueue_refused", "enqueue refused")
                ok("task" to BridgeArgs.snapshot(r.task!!))
            }
            "resume" -> { admit(receipt, "owner_changed"); resume(rt, BridgeArgs.optStr(m, "taskKey", 64)) }
            "pause" -> { rt.pause(BridgeArgs.optStr(m, "taskKey", 64)); ok() }
            "cancel" -> ok("cancelled" to rt.cancel(BridgeArgs.str(m, "taskKey", 64)))
            "status" -> {
                val g = rt.gate.read()
                statusView(g, BridgeArgs.ownerId(m)) { rt.tasksFor(it) } +
                    ("policyBlockReason" to g.policy.blockReason(AndroidEnvProbe(context) { null }.snapshot()))
            }
            else -> throw Failure("not_implemented", "unknown method")
        }
    }

    private fun admit(receipt: Long, code: String): Long = try {
        callFence.admit(receipt)
    } catch (e: SupersededException) {
        throw Failure(code, "an owner invalidation arrived first")
    }

    private fun ok(vararg pairs: Pair<String, Any?>): Map<String, Any?> =
        mapOf<String, Any?>("schemaVersion" to BridgeArgs.SCHEMA_VERSION) + pairs.toMap()

    private fun capabilities(): Map<String, Any?> {
        val rt = runtimeFactory(context)
        return ok(
            "apiLevel" to Build.VERSION.SDK_INT,
            "scheduler" to SchedulerKind.forApi(Build.VERSION.SDK_INT),
            "gateEnabled" to rt.enabled,
            "notificationsGranted" to UploadNotifications(context).permitted(),
            "visible" to visibility.visible,
            "limits" to mapOf(
                "partBytes" to Limits.PART_BYTES.toString(),
                "maxConcurrentPuts" to Limits.MAX_CONCURRENT_PUTS,
                "maxTempChunks" to Limits.MAX_TEMP_CHUNKS,
            ),
        )
    }

    /** Confirms the stored session is the frozen owner's Better Auth principal (an active collector). */
    private fun verifyOwner(rt: UploadRuntime, ownerId: String): Map<String, Any?> {
        val g = rt.gate.read()
        val origin = g.backendOrigin
        if (g.ownerId != ownerId || origin == null) return ok("verified" to false, "reason" to "owner_not_bound")
        return try {
            rt.withControlToken { cancel ->
                val me = ControlClient(origin, ownerId, rt.jar, AndroidHttpTransport(null), cancel).me()
                cancel.check()
                when {
                    rt.gate.read().generation != g.generation -> ok("verified" to false, "reason" to "owner_changed")
                    me.userId != ownerId -> ok("verified" to false, "reason" to "principal_mismatch")
                    !me.activeCollector -> ok("verified" to false, "reason" to "not_active_collector")
                    else -> ok("verified" to true, "reason" to null)
                }
            }
        } catch (e: CancelledException) {
            ok("verified" to false, "reason" to "owner_changed")
        } catch (e: ControlException) {
            ok("verified" to false, "reason" to e.kind.name.lowercase())
        }
    }

    /**
     * Private-channel export so Dart can adopt a newer native cookie rotation.
     * Cookie values cross only this in-process channel; nothing is logged.
     */
    private fun exportSession(rt: UploadRuntime): Map<String, Any?> {
        val g = rt.gate.read()
        val b = rt.jar.bundle()
        if (b == null || g.ownerId != b.ownerId || g.backendOrigin != b.origin) return ok("present" to false)
        return ok(
            "present" to true, "ownerId" to b.ownerId, "backendOrigin" to b.origin,
            "sessionRevision" to b.revision.toString(),
            "cookies" to b.cookies.map {
                mapOf("name" to it.name, "value" to it.value, "path" to it.path, "secure" to it.secure, "expiresAtMs" to it.expiresAtMs)
            },
        )
    }

    private fun resume(rt: UploadRuntime, taskKey: String?): Map<String, Any?> {
        // UIDT and foreground starts are legal only from a visible user action.
        if (!visibility.visible) throw Failure("not_visible", "resume requires a visible user action")
        val g = rt.gate.read()
        if (g.ownerId == null) throw Failure("owner_not_bound", "no owner is bound")
        val rearmed = rt.prepareResume(taskKey)
        val s = UploadScheduler.schedule(context, rt)
        return ok("rearmed" to rearmed, "scheduled" to s.scheduled, "scheduler" to s.scheduler, "reason" to s.reason)
    }

    companion object {
        const val CHANNEL = "ai.stateaction/native_upload"
    }
}

/** Only the bound owner's tasks are ever visible: another supplied owner id gets none. */
internal fun statusView(g: GateState, owner: String, tasksOf: (String) -> List<TaskRecord>): Map<String, Any?> {
    val tasks = if (g.ownerId != null && g.ownerId == owner) tasksOf(owner) else emptyList()
    return mapOf(
        "schemaVersion" to BridgeArgs.SCHEMA_VERSION,
        "ownerGeneration" to g.generation.toString(),
        "boundOwnerId" to g.ownerId,
        "policy" to mapOf(
            "requireUnmetered" to g.policy.requireUnmetered,
            "requireCharging" to g.policy.requireCharging,
            "capturePaused" to g.policy.capturePaused,
        ),
        "tasks" to tasks.map { BridgeArgs.snapshot(it) },
    )
}
