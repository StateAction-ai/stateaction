# Mobile sign-in, session cookies and capture ownership (SA-17)

Status, 2026-11-02: **integrated with the published SA-15 backend**. The app's
own Dart client, cookie jar, controller, owner ledger, gate and policy run
against the real Next production server, Better Auth and a restricted
Postgres (local, uncached, in CI) and against the root QA HTTPS origin over
Tailscale. They have **not** run with real Google sign-in, a signed build,
iOS or a physical phone. See [Remaining gates](#remaining-gates).

## Sign-in paths

Both paths use the **same Better Auth instance, session and role system**:

| Path                                                       | Client call                                                                        | Enabled by                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Local email/password (seeded pilot users, no mail service) | `POST /api/auth/sign-in/email`                                                     | `LOCAL_PASSWORD_AUTH=true` in `.env` (opt-in; default off) |
| Google (native `google_sign_in` 7.2.0)                     | `POST /api/auth/sign-in/social` with `{provider:"google", idToken:{token, nonce}}` | always shown; requires real client IDs                     |

After either exchange the client calls `GET /api/v1/me`. Enrollment, roles and
access status come **only** from that server response; the sign-in response
body (which contains a token) is discarded unread. A failed `/me` after sign-in
signs the new session out instead of guessing. There is no custom JWT service,
client-side role, or anonymous bypass. `NO_AUTH_MODE=true` remains a separate,
explicit, network-free capture harness and never substitutes for sign-in.

`/api/v1/me` is bound to the **published `http.me.v1` contract** inside
`http.success-envelope.v1`, validated by the shared Dart adapter
(`packages/contracts/dart`, `stateaction_contracts`) before any field is read
(`lib/src/core/contracts/published_contracts.dart`, `server_identity.dart`).
Flutter cannot bundle assets from outside `apps/mobile`, so
`tool/sync_published_contracts.dart` embeds exact copies of the published
schema files and catalog entries in `published_contracts.g.dart`;
`test/src/core/contracts/published_contracts_test.dart` fails on any byte
drift and runs every shared `http.me.v1`/`http.success-envelope.v1`
conformance fixture through both the registry and `ServerIdentity`.
Enforced: byte bounds (1 MiB envelope; `data` measured as its compact
encoding against 16 KiB), strict UTF-8/JSON (no BOM), closed objects, request
UUID, opaque `authUserId` pattern, status enum, unique roles in canonical
order, active ⇒ ≥1 role, pending/disabled ⇒ none, and a **required** RFC 3339
UTC `session.expiresAt`. Any violation fails closed as "unexpected identity
response" (never as revocation). Network authority ends at that server expiry;
there is no missing-expiry case.

## Configuration

`.env` (ignored; see `.env.example`):

- `DEV_BACKEND_ORIGIN` / `PROD_BACKEND_ORIGIN`: exact `scheme://host[:port]`,
  no path. Better Auth is `<origin>/api/auth`, the API `<origin>/api/v1`. The
  local development origin is `https://tim-work-pc.taila68f99.ts.net:8444`;
  a hosted build uses its Render HTTPS origin. Plain HTTP is accepted only for
  `127.0.0.1`, `localhost`, `::1` and the emulator alias `10.0.2.2`. A missing or
  unsafe origin stops startup with a configuration error.
- `LOCAL_PASSWORD_AUTH`: opt-in development form. Keep `false` for builds that
  must offer Google only. Hosted/provider policy is decided per build; this flag
  never turns on implicitly.

No credential, cookie or password is placed in `.env`, Flutter assets, logs,
Nx caches or Git.

## Session cookies

`SessionCookieJar` is bound to the **exact backend origin** (scheme, host and
port). Cookies ignore ports, and the Tailscale host serves unrelated services
on 443 and 8443, so a host-keyed jar would leak the session; this one never
sends cookies to another origin.

- Every response's `Set-Cookie` values are applied, including error and
  sign-out responses: rotation/re-issue replaces, `Max-Age=0` or a past
  `Expires` deletes, `Max-Age`/`Expires` set expiry, and path scoping applies.
- Host-only: a `Domain` other than the exact host is rejected. `Secure`
  cookies are rejected on an HTTP origin; `__Secure-`/`__Host-` prefix rules
  are enforced.
- Persistence is only through `OsSecretStore` (`flutter_secure_storage`:
  Android Keystore AES-GCM / iOS Keychain), as one record tagged with the
  origin. A record for another origin is deleted on load. Tests use
  `MemorySecretStore`.
- Requests carry `X-StateAction-Client: android|ios`, and POSTs carry
  `Origin: <backend origin>` (Better Auth rejects cookie-bearing mutations
  without it; its own `baseURL` origin is always trusted). No request ever
  carries `Authorization`; `Api.sendRequest` strips one if passed.
- The auth client performs no logging; `StoredCookie`/`ServerIdentity`
  `toString()` redact values and user ids.

`better_auth_flutter` was removed: its jar keyed cookies by host only, and its
static singletons could not be tested against a fixture.

## Session states and offline eligibility

`AuthSessionController` states:

| State                                                                    | Capture                     | Networking/uploads |
| ------------------------------------------------------------------------ | --------------------------- | ------------------ |
| `AuthActive` with active `collector`                                     | yes, owner = server user id | yes, own data only |
| `AuthActive` pending/disabled/non-collector                              | no                          | no                 |
| `AuthOfflineEligible` (server unreachable, or 401 with `reauthRequired`) | yes, for the eligible owner | **paused**         |
| `AuthUnverified` (cookies, server unreachable, no eligibility)           | no                          | no                 |
| `AuthSignedOut`                                                          | no                          | no                 |

Offline eligibility (`OfflineEligibilityStore`, secure storage, origin-bound)
is written only when `/me` shows an active collector. It is **cleared** on
explicit logout and whenever the server reports the account pending,
disabled or without the collector role (known revocation). A 401 is treated
as session end, not revocation: networking pauses, eligibility stays. It is
valid for seven days after the last server verification
(`OfflineEligibility.maxOfflineAge`, matching the session lifetime). This is a
provisional pilot policy, not a server-enforced value.

Explicit logout pauses networking first, requests `POST /api/auth/sign-out`,
then clears cookies and eligibility regardless. If the server could not be
reached, the user is told revocation is **unconfirmed**. Logout no longer
clears the upload database, KV store or secure store wholesale; captures,
journals, receipts and recorder settings are preserved.

### Concurrency and call-time checks

- Every sign-in and logout starts a new **auth epoch**. A `/me` refresh or
  sign-in whose epoch is stale when its response arrives is discarded, so a
  late response cannot resurrect a logged-out session, reinstall eligibility
  or replace a newer account (A→B switch).
- The jar has a **generation** incremented by every clear. Requests capture it
  first; a late `Set-Cookie` or 401 from an older generation is ignored
  (cannot reinstall cookies or wipe the newer session). Logout and account
  switch drop cookies locally _before_ the server sign-out call, which uses a
  snapshot of the old cookie.
- Secure-store writes for cookies and eligibility are serialized, so a clear
  issued after a write is always applied after it.
- Owner answers are evaluated **at the moment of use** (`captureOwnerAt(now)`,
  `networkOwnerAt(now)`): offline eligibility stops authorizing Start after
  its window even without a refresh, an active session stops networking at
  its `sessionExpiresAt` and capture seven days after the last verification,
  and a verification time in the future (clock rollback) fails closed.

## Immutable capture ownership

`CaptureOwnerLedger` is an app-private, write-ahead JSON journal
(`<app support>/capture_ownership/ledger.v1.json`, atomic temp+rename). No API
rewrites an owner; conflicting writes raise `OwnerConflict`.

1. On the intentional Start, the recorder calls its host `RecordingStartGate`
   (`packages/stera_recorder`) **before** the native call. `CaptureOwnerGate`
   persists an owner intent for the verified capture owner, or denies Start
   ("Sign in as an active collector to record.") so native is never invoked.
2. After native Start returns the output directory, the gate binds the
   directory to the intent's owner. A native failure aborts the intent.
3. If the app dies between Start and binding, or native reports no directory,
   the intent stays pending and the capture is **ownerless**.

Access (`CaptureAccessPolicy`, `OwnerFence`):

- Same owner: listed, previewed, resumed and uploaded (uploads only while
  `AuthActive`).
- Another account: hidden from the upload list, excluded from orphan sweeps,
  never queued, resumed, adopted or deleted.
- Ownerless (pre-ownership data, auth-free harness captures, natively driven
  starts, crash window, lost/unknown ledger): never auto-adopted or deleted.
  The upload page's recover action asks an `AuthActive` collector to claim
  them explicitly; claimed entries record `provenance: legacy_recovery`.
  Offline eligibility cannot claim.
- Picked (non-capture) videos are stamped for the verified network owner
  before their upload row is created; with no owner, nothing is queued.

Upload fence: the Dart upload queue skips rows that the current verified
network owner does not own. When the session leaves `AuthActive` (expiry,
logout, account switch), the in-flight upload is paused after its current
chunk batch with multipart state preserved, and is resumed automatically only
when the same owner is verified again.

## Native boundary (honest limits)

- Clearing Flutter state does **not** revoke presigned part URLs already
  issued. A chunk batch in flight can finish after logout; no new parts start.
- The iOS background `URLSession` windowed uploader is **not** owner-fenced
  natively. That fencing belongs to the native upload ticket (SA-57). Until
  then `UploadsService.nativeUploadOwnerFenced` is `false` and `uploadFile`
  refuses to start a native upload (recordings stay on the device). Android
  has no upload path in this app yet (`uploadFile` fails on non-iOS); the
  legacy `/upload/*` routes do not exist on the new backend (SA-19/SA-57).
  No build of this change claims a working or owner-safe upload.
- Natively driven starts (e.g. native arm-start) bypass the Dart gate. Their
  captures are ownerless and go to explicit recovery (fail closed).
- The owner is not yet written inside the MCAP/capture metadata; that belongs
  to the capture-format work.

## Validation

- `apps/mobile/test/src/modules/auth/session/`: cookie jar/origin unit tests
  and end-to-end controller/ledger/gate/policy flows over real loopback HTTP
  against `fake_better_auth_server.dart` (sign-in, `/me` roles, rotation,
  other-port isolation, expiry, offline restart, stale eligibility, disabled,
  online/offline logout, account switch, same-owner resume, legacy recovery,
  bearer rejection).
- `apps/mobile/test/src/modules/auth/local_password_sign_in_form_test.dart`:
  the real form through `AuthProvider` to the fixture.
- `apps/mobile/test/src/modules/capture_ownership/`: ledger durability,
  immutability, path resolution, corrupt-ledger fail-closed and gate cases.
- `packages/stera_recorder/test/recording_start_gate_test.dart`: gate runs
  before native Start; denial never reaches native; native failure aborts.
- Emulator simulation: see `docs/validation/sa-17-mobile-auth.json`.
- **Real backend** (`apps/mobile/test_backend/`, Nx project
  `mobile-auth-backend-e2e`, target `mobile-backend-e2e`, uncached, run in
  the CI Android job): `run_real_backend.mjs` starts a uniquely named
  throwaway Postgres, migrates and seeds it with the published catalog
  migrator, serves the production `next build` with `next start` (Next
  connects only as `stateaction_app`), puts a loopback TCP relay in front for
  offline simulation and exposes token-protected operator SQL actions. Then
  `real_backend_auth_test.dart` runs the app's own client code over real HTTP
  (each sign-in sends its own test-only `x-forwarded-for` from
  `client_address.dart`, so the real per-address sign-in limit is never waited
  out; one dedicated test fixes one address and proves the limit rejects and
  recovers after the server's own window):
  wrong/correct password, `/me` roles and expiry equal to the session row,
  staff/customer/pending/disabled refused before native Start, real
  `Set-Cookie` refresh-window re-issue (Max-Age/Expires), server-side expiry
  and revocation (cookies cleared by the real 401, offline capture kept,
  A re-auth), operator access disable, offline restart and unconfirmed
  offline logout, confirmed online logout removing the session row, A→B
  switch on one device (foreign isolation, no recovery of owned captures,
  previous session revoked at the sign-in boundary, source bytes and the
  on-disk ledger unchanged) and `Authorization` rejection. The harness never
  spoofs client addresses; it waits out Better Auth's real sign-in rate limit.
  Remote mode (`SA17_BACKEND_MODE=remote`) runs a single-collector subset
  against an existing backend such as the QA HTTPS origin and asserts
  `__Secure-` Secure/HttpOnly cookies.

The loopback fixture (`fake_better_auth_server.dart`) remains a deterministic
test double for race and unit cases only.

## Remaining gates

1. Done for local password: real backend locally and in CI, plus the root QA
   origin `https://tim-work-pc.taila68f99.ts.net:8444` (single collector,
   remote mode). Not hosted Render.
2. Signed Android build → native Google ID token → `sign-in/social`, with
   platform/server audience and nonce verification.
3. Real-device login/expiry/account-switch with retained journals and rotated
   cookies (root-coordinated, personal profile only, intentional Start).
4. Native owner-aware upload pause/cancel (SA-57) and iOS.
5. Hosted Render origin/cookie behavior (`__Secure-` cookies over HTTPS).
