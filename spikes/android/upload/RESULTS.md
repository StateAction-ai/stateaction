# Android auth/background upload spike results

SA-62 · 2026-10-31 · **Partial feasibility evidence; production qualification remains open.** See [run instructions and scope](README.md).

| Check | Result and evidence |
| --- | --- |
| Local Node protocol test | **PASS**. One integrated test covers 11 named control/recovery scenarios with three real local-file PUTs, 134,217,761 verified bytes and full SHA-256 equality. [Machine-readable result](control-test-result.json) |
| Cookie control | **PASS in local simulation**. Every control request rotates the synthetic session; every separate Set-Cookie header is consumed. No Dart runtime or provider credential is involved. This does not qualify actual Better Auth cookies |
| Ownership / epoch | **PASS in local simulation**. Another account sees 404; changed-content replay conflicts; stale epoch fails; confirmed retirement permits a new epoch; uploaded transports cannot reopen |
| URL / recovery | **PASS in local simulation**. Deliberately expired URL renews; two PUTs run concurrently; lost receipts recover through three simulated provider pages; lost completion response recovers after same-owner login and preserves exactly one completion |
| Native app + test APK | **PASS build** with JDK 21, Gradle 8.14, AGP 8.12.1, Android SDK 35; package `ai.stateaction.spike.upload`, min API 34. [Build hashes/result](build-result.json) |
| Android lint | **PASS, zero errors**. Warnings concern the debug harness's hardcoded text/theme/icon, target/dependency version suggestions and synchronous preference persistence. This is not a release-quality UI |
| Native engine on emulator | **PASS**, API35 emulator. The actual Java engine and Android Keystore vault transferred **134,230,073 bytes** with SHA-256 `efb8dcc75aec0417b3663f09fd2ba21dc93d2511d9f84c6df46fa669345466be`, renewed an expired URL and retried one injected part-2 HTTP503. Maximum observed 2 active PUTs / 3 chunks / 134,230,073 temporary bytes. Exactly one fixture completion. [Direct native evidence](native-instrumentation-result.json) |
| UIDT → HOME on emulator | **PASS**, separate fresh source/run. Started from the visible activity; JobScheduler reported `userInitiatedApproved: true (started as UIJ: true)`. Sent HOME after native UIDT entered uploading; completed with an expired-URL renewal and one API completion. Same byte/hash and bounds as above. **Charging policy explicitly overridden off**, unmetered-only retained. [UIDT evidence](emulator-uidt-result.json) |
| Native engine / UIDT on physical phone | **Pending root-coordinated execution at this report revision**. No agent installed or launched on the shared phone. A compiled native prototype is not a measured device pass |
| Real Google → Better Auth | **Pending**. Harness uses explicit synthetic accounts, not a Google token or Better Auth server. Existing app configuration fields do not authorize this new package/signature |
| MinIO / R2 semantics | **Pending**. Provider-shaped file I/O is a simulation. No SDK/provider completion, provider pagination, credential or cloud egress was tested |
| Pre-34 WorkManager | **Not implemented**. This API34+ spike explicitly excludes the fallback |

The direct instrumentation and UIDT tests are deliberately separate; the former invokes the engine directly and labels itself **not UIDT proof**. The emulator HOME test does not prove physical lock/Doze, process death/manual recovery, Task Manager stop, charging/network constraint changes, more than 1,000 actual parts or a two-hour run. No peak-RSS/battery/heat claim is made. The test emulator and local fixture process were stopped after receipt collection.

Prototype corrections found during implementation: serialize rotating control requests while keeping UI status reads outside that network lock; cache only the nonsecret verified owner ID rather than invoke Keystore on every I/O buffer; retry a rejected PUT even when it fails while writing its request body before HTTP status is read; retain system-stop state without overwriting explicit user pause; distinguish `direct_instrumentation` and `uidt` execution in evidence. APK/build hashes identify the final revision; the earlier direct-engine run predates the owner-cache/execution-label refinement and its runner explicitly records its direct mode.

The decision is **GO for Android API34+ native UIDT/control integration**, conditional on the remaining real-auth/provider/physical gates. Attach safe phone receipts, command/device/build details and OS interruption observations before claiming physical reliability. Google/Better Auth and real-provider gates remain separate and may require configuration rather than additional scheduler research.

No production collector code changed; no real account was authenticated; no paid cloud/GPU job or remote deployment was started. Local fixture data and APK/cache outputs are excluded from version control.
