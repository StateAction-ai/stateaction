# Mobile sign-in, session cookies and capture ownership (SA-17)

Status, 2026-11-01: **independent client preparation**. The mobile client, its
cookie jar and the owner fence run against an ephemeral loopback fixture and the
Android emulator. They have **not** run against the real SA-15 backend, real
Google sign-in, a signed build, iOS or a physical phone. See
[Remaining gates](#remaining-gates).

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

`/api/v1/me` parsing (`server_identity.dart`) is a **provisional client
boundary** mirroring the draft SA-15 envelope
`{data:{user:{id,email,name}, access:{status, roles}, session:{expiresAt}}}`.
Published `main` has no `http.me.v1` schema yet; replace the parser with the
shared contract after SA-15 merges. `authUserId` is opaque (not a UUID).
Unknown statuses fail closed; unknown roles grant nothing.

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
- The iOS background `URLSession` windowed uploader and any native-owned
  upload work are **not** owner-fenced by this change. That production native
  fencing belongs to the native upload ticket (SA-57); until then it is an open
  gate, not a claimed guarantee.
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

The fixture is a deterministic test double. It is not Better Auth and proves
nothing about Google OAuth, audience/nonce verification or the real backend.

## Remaining gates

1. Real SA-15 backend runtime: local password sign-in, `/me`, rotation,
   sign-out and 401 behavior against the reviewed server over
   `https://tim-work-pc.taila68f99.ts.net:8444` (draft integration until SA-15
   merges and publishes `http.me.v1`).
2. Signed Android build → native Google ID token → `sign-in/social`, with
   platform/server audience and nonce verification.
3. Real-device login/expiry/account-switch with retained journals and rotated
   cookies (root-coordinated, personal profile only, intentional Start).
4. Native owner-aware upload pause/cancel (SA-57) and iOS.
5. Hosted Render origin/cookie behavior (`__Secure-` cookies over HTTPS).
