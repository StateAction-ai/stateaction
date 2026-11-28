# SA-78 private R2 qualification

The production Next build ran on loopback with a disposable PostgreSQL database and the existing private stage bucket. The fixtures were synthetic. The initial runs exercised product code at `b2d37577918790508b6984ad65cb0c31c00514cc`. Local runs used Node 24.22.2. The receipts below report SHA-256 digests, counts and HTTP status codes.

## Android upload and recovery

Android reported API 37 and identified user 0 as the personal full user. The installed `ai.stateaction.collector.dev` APK was version `0.0.1` (code 1), reported APK signing scheme v2, and had SHA-256 `1d71c44664ef27a8abae7544ed5c77112bacaa77a4c185cbc71d15101a5e4076`. Its bundled settings contained `NO_AUTH_MODE=true`, which disables authenticated upload and owner switching. The native engine uses JobScheduler's user-initiated data transfer (UIDT) on API 34 and later when the authenticated upload path is enabled.

The capture-only app omits the authentication and upload services and rejects network calls at its API entry point. The native runner requires a Better Auth cookie and an admitted owner. There is no supported dev token or upload path in the installed collector. The separate [SA-57 emulator harness](android-native-upload.md#emulator-os-qualification-harness) injects a fixture session into a dedicated instrumentation package. Its prior runs cover the Kotlin bridge, native scheduling, process death, owner fencing, expiry-response handling and the uploaded digest against the bounded local backend. This follow-up inspected the harness and did not run a new Android test.

The physical criteria remain open. The separate [QA debug build](android-qa-sign-in.md) can sign in as a seeded development collector before a take. A take from the capture-only package stays in that package’s private storage. AC1 needs on-device multipart upload, interrupted PUT recovery, owner switching, renewal while suspended, final R2 SHA-256 equality and Tailscale reachability when used. AC4 needs the signed device to run transfer scheduling, notifications and permissions, owner fencing, landed-part recovery and source preservation through lock, network and charging changes, process death, relaunch and reboot. AC4 calls for the local backend first, then private R2. A local capture still needs the user's Start tap.

## Browser and broker

The Cloudflare API read back this one rule on the private `stateaction-stage` bucket. The managed public domain was disabled and there were zero custom domains.

| Rule field               | Value                    |
| ------------------------ | ------------------------ |
| Rule ID                  | `sa78-stage-playback`    |
| Allowed origin           | `http://127.0.0.1:24178` |
| Allowed methods          | `GET`                    |
| Allowed request headers  | `range`, `if-match`      |
| Exposed response headers | `ETag`, `Content-Range`  |
| Preflight max age        | 60 seconds               |

The preflight from the allowed origin returned 204 with that exact origin. A preflight from an unrelated origin returned 403 with no allow-origin header. Headless Chrome 155 with SwiftShader WebGL opened the authorized clip and rendered the viewer canvas in 15.4 seconds. R2 served the viewer's full GET directly with HTTP 200 and the exact allow-origin header. The 60,486-byte synthetic RRD had SHA-256 `e4f63094341fe3acc5514eccf189d3524a9eac146a4490c2fb7818109277b3b3`. The highest JavaScript heap sample was 57,819,047 bytes. That number covers the sampled JS heap and omits browser process, GPU and WASM memory.

A separate signed Range request from Chrome returned 206. JavaScript could read the ETag, `Content-Range: bytes 0-3/60486`, and four payload bytes matching the RRD magic `RRF2`. Chrome reported 529 encoded bytes for that request. HTTP requests with matching and mismatched `If-Match` returned 206 and 412. An expired 60-second broker URL returned 403, and a fresh broker URL returned 206. The unrelated and revoked viewers both received broker 404 in Chrome.

The earlier bounded-storage Rerun suite passed 7/7 and decoded 10 H.264 frames from the 64×48 fixture on seek.

### Sealed recording playback and browser memory

The review recipe fixture uploaded a 48-second, 960×540 H.264 MP4 at 24 frames per second through multipart transport. Acceptance verified all 13,312,728 bytes before Chrome opened the real staff review page. The MP4 SHA-256 was `b50e18bc947437adf0045339ff3c5901163e20093c627c825edef782077f86d4`. The recording MP4 and the 60,486-byte RRD were in the same accepted inventory, SHA-256 `ededef37465ec2a838ea4f76e70c45af4ca7dbcbe4a8b9f7456245df609bab98`.

Headless Linux Chrome 155.0.8059.84 received 206 from R2 on all five MP4 requests. The forward seek requested `bytes=11108352-` and the backward seek requested `bytes=1474560-`. Chrome received 1,032,464 MP4 body bytes across startup, playback and the two seeks, including requests it cancelled. Navigation to metadata took 1,943 ms and navigation to first presented frame took 2,058 ms. The test used a cold browser cache and applied a 512 KiB/s limit with 40 ms latency to R2 only.

For fidelity, the driver sampled the actual compositor output when Chrome presented each requested frame. It compared a 96×54 RGB crop with an independent FFmpeg decode at the same timestamp and with a different-time control. A loopback calibration established the reference conversion to RGB before resizing. The stage comparisons met the same limits throughout the run: mean absolute RGB error at most 9 levels, at least 92% of channel samples within 16 levels, and the different-time error at least 7 levels larger.

| Action       | Presented time | Mean RGB error | Within 16 levels | Different-time error |
| ------------ | -------------: | -------------: | ---------------: | -------------------: |
| Play         |         0.75 s |          2.825 |           95.30% |               15.876 |
| Seek forward |        40.25 s |          3.944 |           93.06% |               19.899 |
| Seek back    |         5.25 s |          2.197 |           96.23% |               13.058 |

Browser-tree proportional set size (PSS) rose from 246,378 KiB at a blank tab to a sampled peak of 320,457 KiB over 23 samples at 200 ms. The peak included all 14 Chrome processes, including the renderer and compositor processes. PSS shares mapped pages proportionally. This measure excludes kernel and GPU device memory. The Linux headless run used software video decoding.

The same browser also issued a direct signed Range probe for the sealed RRD. It received HTTP 206, four bytes of `RRF2`, and `Content-Range: bytes 0-3/60486`. The native video player used Range for MP4 playback. The embedded Rerun viewer still loads the full RRD before playback. The fixture verified cleanup of all 12 owned stage keys. Android Chrome measurements remain open.

## API restart, worker outputs and pagination

The source and worker completion requests were still in flight when the test killed the Next process. The test held the final catalog state write in the disposable database after R2 had committed each object. Both clients disconnected, both rows stayed `completing`, and the restarted process returned 409 while the persisted claims were live. After the claims expired, the restart driver asserted that reconciliation returned `completed` for both files, the persisted key, upload ID and epoch matched their earlier values, full-object hashes matched the synthetic bytes, and no multipart upload remained at either key. The original PUT URLs returned 404 and both hashes stayed unchanged. The receipt logs hashed final identifiers and payloads. The before-and-after assertions are in the local driver, whose SHA-256 is `08ef9295488170b41ffb09fc97b9d06ad8d535e0c1502281794596c71acfb939`.

| Upload        | Parts | Bytes | Payload SHA-256                                                    |
| ------------- | ----: | ----: | ------------------------------------------------------------------ |
| Source        |     1 | 4,096 | `cd9190c5c103c03c05f1b4a879cd5cffbb25710583ca873c1c8e239824096466` |
| Worker output |     1 | 2,048 | `2bb1cd7eab4014363e4d6d49285123546ee222543ad48091cb80537648ddd48a` |

A real stage upload accepted 1,001 one-byte parts. The provider returned pages of 1,000 and 1, and the production adapter returned the same ordered part numbers, sizes and ETags as the upload receipts. Receipt SHA-256: `90f2f4e536ff66b1fdb8eb11a123dc30dc708a631b195de544929acbf4d68950`. The test aborted the upload and checked that no object or upload remained. It measured listing pagination independently of the existing two-part harness.

In a separate worker run, the output-close and result routes sealed and verified seven files totaling 4,846 bytes. The job reached `succeeded` with one clip after execution evidence was recorded. A stale part URL returned 404 and the object SHA-256 stayed `d039c3fbe58a3450feb9eb321dae1bf219ea07433f82b9797089efa76b100b71`. The original worker capability returned 401 on a new reservation after the job entered result_pending. The sealed inventory SHA-256 was `1f289b447141f04583154429fd8b153103e023240361233d31b44a27a0361601`.

The restart probe verified cleanup of both exact keys. Its extra close call returned 500 in a recovery fixture that had no result manifest. The separate acceptance run supplied a manifest and verified sealing. The acceptance test case passed, then an R2 timeout failed its teardown. An exact-key cleanup pass subsequently verified all ten objects and uploads absent. Two earlier interrupted attempts also timed out during cleanup before their key ledgers were in place. Their cleanup remains unverified.

The worker run with both restart and result sealing in one job returned HTTP 503 `provider_unavailable` on reconciliation after the claim expired. It verified cleanup of all four keys it had created. A separate source rerun ended with a client `TypeError` in its reconciliation phase and verified cleanup of its single key. Neither rerun produced a passing end-to-end receipt. The successful restart and worker sealing checks above came from separate local API runs using stage R2.

A subsequent fresh-connection probe made 60 signed HEAD requests to a synthetic stage object. One request hit an SDK `TimeoutError` with `ETIMEDOUT` after 527 ms. Production mapped this class of provider failure to HTTP 503 and used a single attempt for the reconciliation HEAD. The original 503 receipt lacks its low-level error, so it cannot identify the precise network event. A separate worker setup attempt produced the SDK's explicit 1,000 ms connection timeout. A fresh stage connection in a diagnostic trace succeeded after 2,071 ms. The fix allows up to five seconds to establish a connection within the caller's existing request timeout. Exact-key HEAD, multipart-upload listing and part listing can make two SDK attempts. Multipart create, complete and abort continue to use single-attempt calls. A regression test dropped the first HEAD and ListParts connections and observed successful second requests. It observed exactly one multipart create attempt when that connection failed. The six-test provider file passed 20 consecutive runs, and all 14 transport unit tests passed.

On the fixed build, the complete worker scenario passed against the bounded local store and private R2 stage. The API restarted during completion and returned 409 while the persisted claim was live. The test expired that claim in the disposable database and injected an `ETIMEDOUT` before the first HEAD completed. The next HEAD returned 200. Reconciliation returned `completed` at the original key, upload ID and epoch 1, with zero multipart uploads remaining. On stage, the 44-byte object SHA-256 was `89f9a6c559ed51e15e389de5e68edeccac1d0995a91173261a96a6cce0a41c28`.

The same stage job sealed seven files totaling 4,846 bytes and reached `succeeded` with one clip. The inventory SHA-256 was `ac6f3291ba5b890aebb299bc57958bae246ba1b75fd41a0389918ffb22f89513`. A stale PUT returned 404, the content SHA-256 stayed the same, and the spent capability returned 401. The test verified cleanup of all ten owned stage keys. The test runner selected IPv4 after the workstation’s IPv6 route to R2 returned `ENETUNREACH`.

## Merge status

The Android and browser criteria remain open. The combined worker qualification used the local API and a synthetic worker with the real stage bucket. The draft has no landing receipt. The landing command requires a ready PR with every criterion checked.
