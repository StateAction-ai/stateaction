# Android native background-upload spike

SA-62 · 2026-10-31 · Isolated package `ai.stateaction.spike.upload`, Android **14/API 34+**. This does not replace or modify the Stera collector. No paid resource, GPU, R2 or production account is involved.

This is a **native Android transport prototype and a local simulated control/provider fixture**. The fixture deliberately uses synthetic identities and file-backed provider-shaped PUTs. It is not Better Auth, Google sign-in, S3/MinIO or R2. Its successful SHA-256 check proves local byte preservation, not production provider completion semantics. Do not publish this cleartext-local debug app.

## What is implemented

| Boundary | Prototype behavior |
| --- | --- |
| Native control client | Calls JSON control endpoints without Dart; serializes auth calls; saves every separate rotated `Set-Cookie` header in an AES-GCM Android Keystore-backed vault. Cookie/session data is absent from the upload journal |
| Ownership / identity | A local immutable source has an original synthetic owner, client recording/upload IDs, whole-file SHA-256 and byte length. Another fixture account cannot adopt or display that journal. Same-owner login can resume |
| Transfer | Frozen 64 MiB ranges, two concurrent PUT workers, at most three temporary chunk files/192 MiB, 128 KiB extraction/stream buffers. A 128 MiB + 12,345-byte deterministic source exercises three parts. No unbounded source buffer |
| Recovery | Atomic durable source/part/attempt journal; fully reconciles the fixture's simulated paginated parts before uploading; persists bounded retry counts/not-before times; the control API alone completes. Epoch mismatch stops, rather than adopting a new transport |
| OS entry | A visible Upload/Resume button schedules `JobScheduler` UIDT, publishes progress/pause notification, requires unmetered network and charging by default, and uses the job's selected `Network` for control and data connections |
| Stop | Pause/logout disconnect active provider connections and disable the job; journals/source survive. System stop records its reason and permits OS retry. Task Manager kill can bypass callbacks, so next launch reconciles durable receipts |
| URL expiry | The first native PUT deliberately starts 2.5 seconds after signing against a two-second fixture URL; the retry obtains a fresh signed URL without Flutter/Dart |

The synthetic source is arbitrary bytes, **not a valid MCAP**. Source sealing, recording inventory, Render workflow dispatch, full app UI, actual account enrollment and cloud processing are outside this harness. This spike is limited to the native file/control transport boundary.

## Run local tests and build

Requires Node 22.18+, Android SDK 35, JDK 21 and Gradle 8.14. Existing tool paths come from the repository's `scripts/env.sh`. The build uses a separate writable Gradle home and the existing dependency cache read-only; it does not invoke the Flutter build or edit its cache.

```bash
cd spikes/android/upload
npm test
bash build.sh
```

The app APK is `app/build/outputs/apk/debug/app-debug.apk`; the optional direct-engine instrumentation APK is `app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`. Build/cache outputs are ignored. `control-test-result.json` records the local protocol-test evidence. No npm dependencies are needed.

`npm test` verifies separate cookie rotation, owner isolation, immutable registration replay/conflict, expired URL renewal, two concurrent PUTs, recovered lost receipts, three simulated listing pages, exact content SHA-256, a lost completion response followed by same-owner login/reconciliation, one completion, forbidden reopening, epoch restart/rejection and logout. This is a Node control test; it does **not** execute the native engine or prove Android scheduling.

## Root-coordinated phone / emulator run

Only install after the capture spike has released the shared phone. Read the root AGENTS.md first: identify profiles, verify personal user0 for this Pixel, and never install/run in any company/work profile. All examples explicitly target personal user0; reverify IDs on another device. This app has a separate package ID; never reinstall, force-stop or clear the production collector. Use `adb -s SERIAL` for every command. Wireless ADB requires preserving Wi-Fi; inject network faults at the local fixture before considering real network changes.

Start a dedicated fresh fixture directory and retain it through resume testing:

```bash
SPIKE_DATA_DIR=/tmp/stateaction-android-upload-physical SPIKE_CHUNK_DELAY_MS=8 npm run fixture
```

In another terminal, install and forward the fixture port. The commands deliberately target the spike only:

```bash
adb -s SERIAL reverse tcp:8787 tcp:8787
adb -s SERIAL install --user 0 -r app/build/outputs/apk/debug/app-debug.apk
adb -s SERIAL shell pm grant --user 0 ai.stateaction.spike.upload android.permission.POST_NOTIFICATIONS
adb -s SERIAL shell am start --user 0 -n ai.stateaction.spike.upload/.MainActivity --ez spikeAuto true --es fixtureUrl http://127.0.0.1:8787
adb -s SERIAL shell run-as ai.stateaction.spike.upload cat no_backup/upload-journal.json
```

`spikeAuto` explicitly logs into **synthetic-a**, prepares the deterministic file and schedules from the visible activity. It does not obtain a Google token. Wait for journal `state=uploading` before sending HOME/locking. Do not hide the app before its visible UIDT scheduling call. The policy defaults require charging and an unmetered network; the two labeled checkboxes are explicit overrides. The first expired PUT may surface as an I/O error before HTTP status arrives; either retry route renews its URL.

If the phone is unplugged, the operator can explicitly test the **app policy override**, without changing Android battery state:

```bash
adb -s SERIAL shell am start --user 0 -n ai.stateaction.spike.upload/.MainActivity --ez spikeAuto true --ez requireCharging false --es fixtureUrl http://127.0.0.1:8787
```

This unchecks the visible charging policy and persists that override for the spike. Default unmetered-only remains enabled. Record the override in results; it cannot qualify the charging constraint. `--ez unmeteredOnly false` similarly represents an explicit app override, not a system/network setting change.

For fault injection, restart only the local fixture with the **same** data directory; do not change phone Wi-Fi/airplane mode. These optional environment flags persist their once-only counters in `state.json`:

| Environment variable | Injected condition |
| --- | --- |
| `SPIKE_URL_TTL_MS=2000` | Default short signing TTL; native first-attempt delay forces expiry |
| `SPIKE_CHUNK_DELAY_MS=8` | Throttle each provider body chunk so the upload remains observable after HOME |
| `SPIKE_FAIL_PART_ONCE=2` | One retryable 503 for part 2; the native bounded provider retry renews its URL |
| `SPIKE_LOSE_RECEIPT_RESPONSE_ONCE=1` | Persist the accepted receipt then drop the control response; app goes to attention, same-owner login + Resume reconciles retained bytes |
| `SPIKE_LOSE_COMPLETE_RESPONSE_ONCE=1` | Persist one byte-verified completion then drop its response; same-owner login + Resume recovers uploaded state without a new transport |

For example, add `SPIKE_FAIL_PART_ONCE=2` to the fixture start command. Do not combine every fault in the first run: retain a normal baseline, then one fault at a time. Native control-plane outages require explicit Resume in this prototype; neither automatic Google reauthentication nor a provider-independent repair service is implemented.

After completion, retain the safe journal, fixture `state.json` and command/device/build metadata. They contain IDs/counters/hashes but not auth cookies or signed URLs. Confirm `state=uploaded`, fixture `api_completions=1`, matching SHA-256 and observed maxima no greater than 2 PUTs / 3 chunks / 201,326,592 scratch bytes. HTTP health exposes only safe counters at `/health`. The synthetic source is preserved after successful completion.

For a **separate clean direct-engine test**, install the instrumentation APK and run:

```bash
adb -s SERIAL install --user 0 -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s SERIAL shell am instrument --user 0 -w -e fixtureUrl http://127.0.0.1:8787 ai.stateaction.spike.upload.test/ai.stateaction.spike.upload.SpikeInstrumentation
```

Instrumentation performs native auth/cookie/owner checks and invokes the native engine directly. It is explicitly **not** UIDT/background/Doze proof. Keep the fixture directory consistent with the app journal; changing the fixture to an empty directory while retaining a remote `fileId` correctly produces `not_found`. A deliberate fresh run must clear only this spike's data after retaining prior evidence; never erase pending collector sources.

## Required remaining gates

| Gate | Evidence still required |
| --- | --- |
| Real Google → Better Auth | Register this exact package/signing certificate and server audience, use a real Google token/nonce, verified provider exchange and actual `/me`, secure production session rotation/revocation. Existing Stera config fields alone do not configure this new package |
| Physical UIDT | Real phone notification and job inspection, home/lock, system stop/process kill/manual reopen, constraints loss/recovery, charging/network change and account switch while PUTs are active. Wireless ADB survival is not upload survival |
| Production cookie adapter | Production HTTPS/origin/cookie-domain/expiry semantics and actual pinned Better Auth contract. The local fixture intentionally omits `Secure` for localhost and is not an auth implementation to ship |
| Provider | Same API against MinIO first, then separately approved small R2 canary, actual ListParts pagination/lengths/ETags and uncertain completion. The local simulation is not provider qualification |
| Retry completeness | Persisted backoff works for provider HTTP/network failures; control-plane transient errors currently stop in attention and require explicit Resume. No automatic unbounded auth/retry loop |
| Pre-34 | WorkManager foreground-service fallback is **unimplemented**; `minSdk=34` makes this explicit. Scope it only if actual supported devices require it |
| Volume | 1,000+ actual provider parts, two-hour capture/upload, real MCAP/sidecar inventory and low-disk/power-loss tests. This three-part source cannot qualify those cases |

Current qualification is recorded in `RESULTS.md`; a successful build is not a physical-device pass. No source-file cleanup occurs automatically.

References: [Android UIDT](https://developer.android.com/develop/background-work/background-tasks/uidt), [Better Auth native Google ID-token flow](https://better-auth.com/docs/authentication/google#sign-in-with-google-with-id-token). Official Android and Better Auth documentation was checked through Context7 and primary documentation on 2026-10-31.
