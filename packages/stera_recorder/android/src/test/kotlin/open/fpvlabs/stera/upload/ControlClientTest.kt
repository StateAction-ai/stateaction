package open.fpvlabs.stera.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ControlClientTest {
    private val clock = FakeClock()

    private fun bundle(rev: Long, owner: String = OWNER, vararg c: StoredCookie) =
        SessionBundle(owner, ORIGIN, rev, c.toList().ifEmpty { listOf(StoredCookie("a", "1", "/", true, null)) })

    @Test fun originMustBeHttpsUnlessExplicitEmulatorLoopback() {
        assertEquals("https://tim-work-pc.taila68f99.ts.net:8444", OriginPolicy.normalize("https://Tim-Work-PC.taila68f99.ts.net:8444/", false))
        assertEquals("https://api.test", OriginPolicy.normalize("https://api.test:443", false))
        for (bad in listOf("http://api.test", "http://127.0.0.1:3024", "ftp://x", "https://u:p@x.test", "https://x.test/path", "https://x.test?q=1", "")) {
            assertThrows(bad, PlanException::class.java) { OriginPolicy.normalize(bad, false) }
        }
        assertEquals("http://10.0.2.2:3024", OriginPolicy.normalize("http://10.0.2.2:3024", true))
        assertThrows(PlanException::class.java) { OriginPolicy.normalize("http://api.test", true) }
    }

    private fun lease(jar: SessionJar, owner: String = OWNER) = jar.lease(owner, ORIGIN)!!

    @Test fun anOlderCookieBundleNeverOverwritesANewerNativeRotation() {
        val store = MemorySessionStore()
        val jar = SessionJar(store, clock)
        assertTrue(jar.replaceIfNewer(bundle(1)))
        assertTrue(jar.ingest(lease(jar), listOf("a=2; Path=/; Secure")))
        assertEquals(2L, store.bundle!!.revision)
        assertFalse("stale Dart push is refused", jar.replaceIfNewer(bundle(1)))
        assertFalse("equal revision with different content is refused", jar.replaceIfNewer(bundle(2, c = arrayOf(StoredCookie("a", "other", "/", true, null)))))
        assertEquals("2", store.bundle!!.cookies.single().value)
        assertTrue(jar.replaceIfNewer(bundle(3, c = arrayOf(StoredCookie("a", "9", "/", true, null)))))
        // A different owner always replaces (a new binding), never merges.
        assertTrue(jar.replaceIfNewer(bundle(1, OTHER)))
        assertEquals(OTHER, store.bundle!!.ownerId)
    }

    @Test fun bindOutcomesDistinguishReplaceIdenticalStaleAndConflict() {
        val jar = SessionJar(MemorySessionStore(), clock)
        assertEquals(SessionJar.Bind.REPLACE, jar.assess(bundle(2)))
        jar.replaceIfNewer(bundle(2))
        assertEquals(SessionJar.Bind.IDENTICAL, jar.assess(bundle(2)))
        assertEquals(SessionJar.Bind.STALE, jar.assess(bundle(1)))
        assertEquals(SessionJar.Bind.CONFLICT, jar.assess(bundle(2, c = arrayOf(StoredCookie("a", "x", "/", true, null)))))
        assertEquals(SessionJar.Bind.REPLACE, jar.assess(bundle(3)))
        assertEquals(SessionJar.Bind.REPLACE, jar.assess(bundle(1, OTHER)))
    }

    @Test fun cookiesGoOnlyToTheExactOriginAndOwnerAndSecureOnlyOverHttps() {
        val jar = SessionJar(MemorySessionStore(bundle(1, c = arrayOf(StoredCookie("__Secure-s", "v", "/api", true, null)))), clock)
        val l = lease(jar)
        assertEquals("__Secure-s=v", jar.cookieHeader(l, "/api/v1/me"))
        assertNull(jar.cookieHeader(l, "/other"))
        assertNull("another origin has no lease", jar.lease(OWNER, "https://other.test"))
        assertNull("another owner has no lease", jar.lease(OTHER, ORIGIN))
        val expired = SessionJar(MemorySessionStore(bundle(1, c = arrayOf(StoredCookie("a", "v", "/", false, clock.now - 1)))), clock)
        assertNull(expired.cookieHeader(lease(expired), "/api"))
    }

    @Test fun setCookieHandlingMatchesTheDartJarRules() {
        val store = MemorySessionStore(bundle(1, c = arrayOf(StoredCookie("keep", "k", "/", true, null), StoredCookie("gone", "g", "/", true, null))))
        val jar = SessionJar(store, clock)
        val l = lease(jar)
        assertFalse("Domain-only header changes nothing", jar.ingest(l, listOf("keep=x; Domain=api.test; Path=/")))
        assertFalse("__Secure- without Secure refused", jar.ingest(l, listOf("__Secure-n=v; Path=/")))
        assertEquals(1L, store.bundle!!.revision)
        assertTrue(jar.ingest(l, listOf("gone=; Max-Age=0; Path=/", "keep=k2; Max-Age=60; Path=/; Secure")))
        val cookies = store.bundle!!.cookies
        assertEquals(listOf("keep"), cookies.map { it.name })
        assertEquals("k2", cookies.single().value)
        assertEquals(clock.now + 60_000, cookies.single().expiresAtMs)
    }

    @Test fun aDomainCookieIsSkippedAloneAndTheRotatedSessionStillApplies() {
        val store = MemorySessionStore(bundle(1, c = arrayOf(StoredCookie("session", "old", "/", true, null))))
        val jar = SessionJar(store, clock)
        // The first cookie carries Domain (skipped); the rotated session after it must still be stored.
        assertTrue(jar.ingest(lease(jar), listOf("tracker=t; Domain=api.test; Path=/; Secure", "session=rotated; Path=/; Secure")))
        val cookies = store.bundle!!.cookies.associate { it.name to it.value }
        assertEquals(mapOf("session" to "rotated"), cookies)
        assertEquals(2L, store.bundle!!.revision)
    }

    @Test fun aLateResponseAfterLogoutOrAnOwnerSwitchCannotWriteAuthRotation() {
        val store = MemorySessionStore()
        val jar = SessionJar(store, clock)
        jar.replaceIfNewer(bundle(1))
        val oldA = lease(jar)
        // Logout: nothing to write into.
        jar.clear()
        assertFalse(jar.ingest(oldA, listOf("a=late; Path=/; Secure")))
        assertNull(store.bundle)
        // A -> B -> A: the new A session is a different epoch; the old A request must not touch it.
        jar.replaceIfNewer(bundle(1))
        val staleA = lease(jar)
        jar.replaceIfNewer(bundle(1, OTHER))
        jar.replaceIfNewer(bundle(1))
        assertEquals(OWNER, store.bundle!!.ownerId)
        assertNull("old A request reads no cookie from the newer A session", jar.cookieHeader(staleA, "/api"))
        assertFalse(jar.ingest(staleA, listOf("a=evil; Path=/; Secure")))
        assertEquals("1", store.bundle!!.cookies.single().value)
        assertEquals(1L, store.bundle!!.revision)
    }

    @Test fun aNewerRevisionOfTheSameSessionWinsOverALateResponse() {
        val store = MemorySessionStore()
        val jar = SessionJar(store, clock)
        jar.replaceIfNewer(bundle(1))
        val l = lease(jar)
        jar.replaceIfNewer(bundle(2, c = arrayOf(StoredCookie("a", "dart-newer", "/", true, null))))
        assertFalse(jar.ingest(l, listOf("a=late; Path=/; Secure")))
        assertEquals("dart-newer", store.bundle!!.cookies.single().value)
    }

    @Test fun anOwnerSwitchDuringARequestNeitherSendsTheForeignCookieNorTakesItsRotation() {
        val r = Rig(java.nio.file.Files.createTempDirectory("sa57").toFile(), 250)
        r.bindOwner()
        val client = ControlClient(ORIGIN, OWNER, r.jar, r.backend, CancelToken(), PART)
        // B binds while A's request is in flight, and the response rotates a cookie.
        r.backend.duringControl = { r.jar.replaceIfNewer(SessionBundle(OTHER, ORIGIN, 1, listOf(StoredCookie("__Secure-better-auth.session_token", "b-token", "/", true, null)))) }
        r.backend.responseSetCookies = listOf("__Secure-better-auth.session_token=a-rotated; Path=/; Secure")
        client.me()
        assertEquals("b-token", r.session.bundle!!.cookies.single().value)
        assertEquals(OTHER, r.session.bundle!!.ownerId)
        // A's next request is refused locally: B's credential is never sent for A.
        r.backend.duringControl = {}
        r.backend.responseSetCookies = emptyList()
        val before = r.backend.calls.size
        val e = assertThrows(ControlException::class.java) { client.getPlan(FILE_ID) }
        assertEquals(ControlKind.STALE_SESSION, e.kind)
        assertEquals(before, r.backend.calls.size)
        assertTrue(r.backend.controlHeaders.none { it["cookie"]?.contains("b-token") == true })
    }

    @Test fun anOldARequestCannotUseOrWriteANewerAAfterBSession() {
        val r = Rig(java.nio.file.Files.createTempDirectory("sa57").toFile(), 250)
        r.bindOwner()
        val client = ControlClient(ORIGIN, OWNER, r.jar, r.backend, CancelToken(), PART)
        client.me() // pins the first A session
        r.jar.replaceIfNewer(SessionBundle(OTHER, ORIGIN, 1, listOf(StoredCookie("__Secure-better-auth.session_token", "b", "/", true, null))))
        r.jar.replaceIfNewer(SessionBundle(OWNER, ORIGIN, 1, listOf(StoredCookie("__Secure-better-auth.session_token", "a2", "/", true, null))))
        val before = r.backend.calls.size
        assertEquals(ControlKind.STALE_SESSION, assertThrows(ControlException::class.java) { client.getPlan(FILE_ID) }.kind)
        assertEquals(before, r.backend.calls.size)
        // A fresh client for the new A session works and its cookie is a2.
        ControlClient(ORIGIN, OWNER, r.jar, r.backend, CancelToken(), PART).me()
        assertEquals("__Secure-better-auth.session_token=a2", r.backend.controlHeaders.last()["cookie"])
    }

    @Test fun cleartextProviderUrlsAreLoopbackOnly() {
        val p = testPlan(250)
        fun ok(url: String) = SignedPart.parseAll(signBody(p, url), p, listOf(2), true).size == 1
        fun bad(url: String) = assertThrows(url, PlanException::class.java) { SignedPart.parseAll(signBody(p, url), p, listOf(2), true) }
        assertTrue(ok("http://10.0.2.2:9000/x?sig=1"))
        assertTrue(ok("http://localhost:9000/x?sig=1"))
        assertTrue(ok("http://127.0.0.1/x"))
        bad("http://evil.example/x?sig=1")
        bad("http://127.0.0.1@evil.example/x")
        bad("http://evil.example:80/10.0.2.2")
        bad("ftp://10.0.2.2/x")
        assertThrows(PlanException::class.java) { SignedPart.parseAll(signBody(p, "http://10.0.2.2:9000/x"), p, listOf(2), false) }
    }

    private fun signBody(p: UploadPlan, url: String): org.json.JSONObject {
        val part = org.json.JSONObject().put("partNumber", 2).put("method", "PUT").put("url", url)
            .put("headers", org.json.JSONObject().put("content-length", p.partLength(2).toString()))
            .put("offsetBytes", p.partOffset(2).toString()).put("lengthBytes", p.partLength(2).toString())
            .put("expiresAt", Rfc3339.format(clock.now + 3_600_000))
        return org.json.JSONObject().put("transportEpoch", p.transportEpoch).put("parts", org.json.JSONArray().put(part))
    }

    @Test fun errorsMapToStableKindsWithoutSecrets() {
        val r = Rig(java.nio.file.Files.createTempDirectory("sa57").toFile(), 250)
        r.bindOwner()
        val client = ControlClient(ORIGIN, OWNER, r.jar, r.backend, CancelToken(), PART)
        assertEquals(OWNER, client.me().userId)
        assertEquals(r.plan.fileId, client.getPlan(FILE_ID).fileId)
        r.backend.meStatus = 401
        assertEquals(ControlKind.AUTH, assertThrows(ControlException::class.java) { client.me() }.kind)
        r.backend.serverEpoch = 2
        val conflict = assertThrows(ControlException::class.java) { client.reconcile(FILE_ID, 1) }
        assertEquals(ControlKind.CONFLICT, conflict.kind)
        assertFalse(conflict.message!!.contains("http"))
        assertThrows(ControlException::class.java) { client.getPlan("../../etc") }
    }

    @Test fun signRefusesPartsOutsideTheRequest() {
        val r = Rig(java.nio.file.Files.createTempDirectory("sa57").toFile(), 250)
        r.bindOwner()
        val client = ControlClient(ORIGIN, OWNER, r.jar, r.backend, CancelToken(), PART)
        val signed = client.sign(r.plan, listOf(1, 3), false)
        assertEquals(listOf(1, 3), signed.map { it.partNumber })
        assertEquals(50L, signed[1].lengthBytes)
    }
}
