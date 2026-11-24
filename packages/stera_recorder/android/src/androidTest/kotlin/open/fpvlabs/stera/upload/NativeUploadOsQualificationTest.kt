package open.fpvlabs.stera.upload

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.StandardMethodCodec
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import open.fpvlabs.stera.source_integrity.FdIdentity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** A plain visible activity: UIDT jobs and foreground services may start only from a visible app. */
class Sa57VisibleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

/**
 * SA-57 emulator qualification harness for the REAL OS scheduler path: the actual [UploadRuntime],
 * [UploadScheduler] (API 34+ UIDT / API 33 WorkManager), the OS job service, Keystore vault, confined
 * source reads and `HttpURLConnection` against a real API and bounded S3 supplied by the host driver.
 *
 * It is skipped unless the host pushed `<filesDir>/sa57/sa57-scenario.json` (app-private, never in the repo; it holds a
 * session cookie). Each phase is one `am instrument -e class ...#phase` invocation so the driver can kill the
 * process, toggle network/charging on the emulator, or stop the VM's services between phases.
 *
 * Results (no cookies, no URLs) go to `<filesDir>/sa57/sa57-result-<phase>.json`. Emulator output is NOT
 * physical-device, reboot, Doze or R2 evidence, and this class never touches a work profile.
 */
@RunWith(AndroidJUnit4::class)
class NativeUploadOsQualificationTest {
    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context get() = instr.targetContext
    /** App-private (the scenario holds a session cookie): the host driver writes it with `run-as --user 0`, mode 0600. */
    private val external: File get() = File(ctx.filesDir, "sa57").apply { mkdirs() }
    private val application get() = ctx.applicationContext as Application
    private val visibility = VisibilityTracker()
    private var bridge: NativeUploadMethodChannelHandler? = null
    private var channelHandler: BinaryMessenger.BinaryMessageHandler? = null
    private val messenger = object : BinaryMessenger {
        override fun setMessageHandler(channel: String, handler: BinaryMessenger.BinaryMessageHandler?) {
            assertEquals(NativeUploadMethodChannelHandler.CHANNEL, channel)
            channelHandler = handler
        }
        override fun send(channel: String, message: ByteBuffer?) = error("unexpected outbound message")
        override fun send(channel: String, message: ByteBuffer?, callback: BinaryMessenger.BinaryReply?) =
            error("unexpected outbound message")
    }

    private fun bridgeCall(method: String, vararg args: Pair<String, Any?>): Map<*, *> {
        val codec = StandardMethodCodec.INSTANCE
        val request = codec.encodeMethodCall(MethodCall(method, mapOf("schemaVersion" to 1, *args))).apply { flip() }
        val reply = CompletableFuture<ByteBuffer>()
        instr.runOnMainSync {
            if (bridge == null) {
                application.registerActivityLifecycleCallbacks(visibility)
                bridge = NativeUploadMethodChannelHandler(messenger, ctx, visibility)
            }
            channelHandler!!.onMessage(request) { envelope -> reply.complete(envelope) }
        }
        val envelope = reply.get(30, TimeUnit.SECONDS).apply { flip() }
        return codec.decodeEnvelope(envelope) as Map<*, *>
    }

    @After fun closeBridge() {
        if (bridge != null) instr.runOnMainSync {
            bridge!!.dispose()
            application.unregisterActivityLifecycleCallbacks(visibility)
        }
    }

    private fun scenario(): JSONObject {
        val f = File(external, "sa57-scenario.json")
        assumeTrue("no scenario pushed by the host driver", f.isFile)
        assumeTrue("needs API 33+", Build.VERSION.SDK_INT >= 33)
        return JSONObject(f.readText())
    }

    private fun runtime(): UploadRuntime {
        val rt = UploadRuntime.get(ctx)
        assertTrue("native upload gate must be enabled in the test manifest", rt.enabled)
        return rt
    }

    private fun sourceFile(sc: JSONObject) = File(File(ctx.filesDir, "sa57-sources"), sc.getJSONObject("source").getString("name"))

    /** Deterministic bytes, identical to `scripts/mobile/sa57_source.py`. */
    private fun materialize(sc: JSONObject): File {
        val spec = sc.getJSONObject("source")
        val f = sourceFile(sc)
        val size = spec.getLong("sizeBytes")
        if (f.isFile && f.length() == size) return f
        f.parentFile!!.mkdirs()
        var state = fnv64(spec.getString("seed"))
        val md = MessageDigest.getInstance("SHA-256")
        f.outputStream().buffered().use { out ->
            val buf = ByteArray(8)
            var written = 0L
            while (written < size) {
                state += -0x61c8864680b583ebL // splitmix64 increment 0x9E3779B97F4A7C15
                var z = state
                z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
                z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
                z = z xor (z ushr 31)
                for (i in 0 until 8) buf[i] = (z ushr (8 * i)).toByte()
                val n = minOf(8L, size - written).toInt()
                out.write(buf, 0, n)
                md.update(buf, 0, n)
                written += n
            }
        }
        assertEquals("host and device must derive the same bytes", spec.getString("sha256"), md.digest().joinToString("") { "%02x".format(it) })
        return f
    }

    private fun fnv64(s: String): Long {
        var h = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
        for (b in s.toByteArray()) { h = h xor (b.toLong() and 0xff); h *= 0x100000001b3L }
        return h
    }

    private fun identityOf(f: File): FdIdentity {
        val st = Os.stat(f.path)
        return FdIdentity(
            st.st_dev, st.st_ino, st.st_size,
            st.st_mtim.tv_sec * 1_000_000_000L + st.st_mtim.tv_nsec,
            st.st_ctim.tv_sec * 1_000_000_000L + st.st_ctim.tv_nsec,
        )
    }

    private fun cookies(sc: JSONObject): List<Map<String, Any?>> {
        val a = sc.getJSONArray("cookies")
        return (0 until a.length()).map {
            val c = a.getJSONObject(it)
            mapOf(
                "name" to c.getString("name"), "value" to c.getString("value"),
                "path" to c.optString("path", "/"), "secure" to c.optBoolean("secure", false),
                "expiresAtMs" to if (c.isNull("expiresAtMs")) null else c.getLong("expiresAtMs"),
            )
        }
    }

    private fun showActivity() {
        val i = Intent(ctx, Sa57VisibleActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instr.startActivitySync(i)
        instr.waitForIdleSync()
        instr.runOnMainSync { visibility.seed(activity) }
    }

    private fun waitFor(timeoutMs: Long, what: String, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(500)
        }
        throw AssertionError("timed out waiting for $what")
    }

    private fun tasks(rt: UploadRuntime, owner: String) = rt.tasksFor(owner)

    private fun report(phase: String, rt: UploadRuntime, owner: String, extra: Map<String, Any?> = emptyMap()) {
        val arr = JSONArray()
        for (t in tasks(rt, owner)) {
            arr.put(JSONObject().put("state", t.state.wire).put("reason", t.reason ?: JSONObject.NULL).put("landed", t.landedCount)
                .put("reported", t.parts.count { it.state == PartState.REPORTED }).put("parts", t.plan.partCount)
                .put("epoch", t.plan.transportEpoch).put("needsVisibleResume", t.needsVisibleResume))
        }
        val g = rt.gate.read()
        val o = JSONObject().put("phase", phase).put("apiLevel", Build.VERSION.SDK_INT)
            .put("scheduler", SchedulerKind.forApi(Build.VERSION.SDK_INT)).put("tasks", arr)
            .put("generation", g.generation).put("capturePaused", g.policy.capturePaused)
            .put("expiryRenewals", rt.engine.stats.expiryRenewals.get()).put("rejectedRenewals", rt.engine.stats.rejectedRenewals.get())
            .put("puts", rt.engine.stats.puts.get())
            .put("pid", android.os.Process.myPid()).put("atMs", System.currentTimeMillis())
        for ((k, v) in extra) o.put(k, v ?: JSONObject.NULL)
        File(external, "sa57-result-$phase.json").writeText(o.toString())
    }

    private fun owner(sc: JSONObject) = sc.getString("ownerId")
    private fun timeout(sc: JSONObject) = sc.optLong("timeoutMs", 180_000)

    /** Binds the owner/session, materializes the source, enqueues the server plan and starts the OS job. */
    @Test fun start() {
        val sc = scenario()
        val rt = runtime()
        val bound = bind(sc, owner(sc), sc)
        assertEquals("bind: ${bound["reason"]}", true, bound["accepted"])
        assertEquals(true, bridgeCall("verifyOwner", "ownerId" to owner(sc))["verified"])
        bridgeCall("setPolicy", "ownerId" to owner(sc), "ownerGeneration" to bound["ownerGeneration"],
            "requireUnmetered" to sc.optBoolean("requireUnmetered"), "requireCharging" to sc.optBoolean("requireCharging"))
        val src = materialize(sc)
        val spec = sc.getJSONObject("source")
        bridgeCall("enqueue", "ownerId" to owner(sc), "ownerGeneration" to bound["ownerGeneration"], "planJson" to sc.getString("planJson"),
            "source" to mapOf("root" to src.parentFile!!.canonicalPath, "relativePath" to src.name, "sha256" to spec.getString("sha256"),
                "identity" to identityOf(src).toJson()))
        val sched = resume()
        val landedAtLeast = sc.optInt("startUntilLanded", 1)
        waitFor(timeout(sc), "$landedAtLeast parts landed") { tasks(rt, owner(sc)).any { it.landedCount >= landedAtLeast || it.state == TaskState.UPLOADED } }
        report("start", rt, owner(sc), mapOf("scheduled" to sched["scheduler"]))
        if (sc.optBoolean("pauseAfterCheckpoint")) capturePause()
        if (sc.optBoolean("logoutAfterCheckpoint")) logout()
        if (sc.optBoolean("interruptAfterCheckpoint")) {
            waitFor(timeout(sc), "host death signal") { File(external, "kill-at-checkpoint").isFile }
            android.os.Process.killProcess(android.os.Process.myPid())
            throw AssertionError("process survived SIGKILL")
        }
    }

    private fun bind(sc: JSONObject, owner: String, session: JSONObject) = bridgeCall(
        "bindOwner", "ownerId" to owner, "backendOrigin" to sc.getString("origin"),
        "sessionRevision" to sc.optLong("sessionRevision", 1).toString(), "cookies" to cookies(session),
    )

    private fun resume(): Map<*, *> {
        showActivity()
        val reply = bridgeCall("resume")
        assertEquals("schedule: ${reply["reason"]}", true, reply["scheduled"])
        return reply
    }

    /** A visible user Resume, then wait for the server-verified end state. */
    @Test fun resumeToCompletion() {
        val sc = scenario()
        val rt = runtime()
        if (tasks(rt, owner(sc)).any { it.state != TaskState.UPLOADED }) resume()
        waitFor(timeout(sc), "uploaded") { tasks(rt, owner(sc)).all { it.state == TaskState.UPLOADED } }
        report("resumeToCompletion", rt, owner(sc))
    }

    /** Waits for any state the host driver expects (e.g. waiting_policy, backoff, needs_orchestrator, blocked_owner). */
    @Test fun expectState() {
        val sc = scenario()
        val rt = runtime()
        val want = sc.getString("expectState").split('|')
        waitFor(timeout(sc), "state in $want") { tasks(rt, owner(sc)).any { it.state.wire in want } }
        report("expectState", rt, owner(sc), mapOf("want" to want))
    }

    @Test fun capturePause() {
        val sc = scenario()
        val rt = runtime()
        bridgeCall("setCaptureActive", "active" to true)
        waitFor(timeout(sc), "run stopped by capture pause") { !rt.isRunBusy() }
        val landed = tasks(rt, owner(sc)).maxOfOrNull { it.landedCount } ?: 0
        Thread.sleep(sc.optLong("pauseObserveMs", 15_000))
        val after = tasks(rt, owner(sc)).maxOfOrNull { it.landedCount } ?: 0
        assertEquals("no part landed while capture was active", landed, after)
        report("capturePause", rt, owner(sc), mapOf("landed" to landed))
    }

    @Test fun capturePauseRelease() {
        val sc = scenario()
        val rt = runtime()
        bridgeCall("setCaptureActive", "active" to false)
        if (tasks(rt, owner(sc)).any { it.state != TaskState.UPLOADED }) resume()
        waitFor(timeout(sc), "uploaded after capture ended") { tasks(rt, owner(sc)).all { it.state == TaskState.UPLOADED } }
        report("capturePauseRelease", rt, owner(sc))
    }

    /** Logout: the old owner's work is retained (blocked_owner), the vault is wiped, no further PUT may run. */
    @Test fun logout() {
        val sc = scenario()
        val rt = runtime()
        val genBefore = rt.gate.read().generation
        bridgeCall("unbindOwner")
        assertNotEquals(genBefore, rt.gate.read().generation)
        assertTrue("vault wiped", rt.jar.bundle() == null)
        waitFor(timeout(sc), "run stopped") { !rt.isRunBusy() }
        val t = tasks(rt, owner(sc))
        assertTrue("old owner's incomplete task retained, never adopted", t.isNotEmpty() && t.all { it.ownerId == owner(sc) && it.state == TaskState.BLOCKED_OWNER })
        report("logout", rt, owner(sc), mapOf("landed" to (t.maxOfOrNull { it.landedCount } ?: 0)))
    }

    /** Another account binds: the first owner's task stays blocked and is invisible to the new owner. */
    @Test fun otherOwnerBinds() {
        val sc = scenario()
        val rt = runtime()
        val other = sc.getString("otherOwnerId")
        val r = bind(sc, other, sc.getJSONObject("otherSession"))
        assertEquals(true, r["accepted"])
        assertEquals("new owner sees none of the old owner's tasks", emptyList<Any>(), bridgeCall("status", "ownerId" to other)["tasks"])
        assertEquals("old owner cannot be queried after the switch", emptyList<Any>(), bridgeCall("status", "ownerId" to owner(sc))["tasks"])
        assertEquals(false, bridgeCall("verifyOwner", "ownerId" to owner(sc))["verified"])
        assertTrue(rt.tasksFor(owner(sc)).none { it.state == TaskState.RUNNING || it.state == TaskState.QUEUED })
        report("otherOwnerBinds", rt, owner(sc))
    }

    @Test fun finalReport() {
        val sc = scenario()
        val rt = runtime()
        report("finalReport", rt, owner(sc), mapOf("jobBusy" to rt.isRunBusy()))
    }
}
