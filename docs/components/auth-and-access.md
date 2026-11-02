# Authentication and access (SA-15)

Status, 2026-11-01: **local implementation on the real catalog; external gates open.** Local email/password sign-in, sessions, `/api/v1/me` (published as `http.me.v1`), role guards and service-credential guards run against real Better Auth 1.7.15. Roles come from the merged SA-13 catalog: its migrator, its seed and `CatalogAccessStore`, read over the restricted `stateaction_app` role. This is exercised by real HTTP and Next/browser tests. Google OAuth, native mobile sign-in, phone access over Tailscale and hosted Render behaviour are **not qualified**. See [Remaining gates](#remaining-gates).

## Design

- One Better Auth instance (`packages/server/src/auth/instance.ts`) is mounted by Next at `/api/auth/*`, with default model and field names (`user`/`session`/`account`/`verification`, camelCase columns and opaque text IDs). This matches the DDL that SA-13 verified against the 1.7.15 generator. `better-auth` is pinned exactly to `1.7.15`. Changing it requires rerunning that generator comparison.
- Sign-in methods:
  - **Local email/password** (`AUTH_LOCAL_PASSWORD=true`): for seeded collector, staff and customer identities. No mail service. Sign-up, self-service profile edits (`/update-user`), password reset, email change, account deletion and account linking/unlinking are disabled (`DISABLED_AUTH_PATHS`).
  - **Google**: configured when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set. A first Google sign-in creates an identity with no roles, which sees _Access pending_. Account linking is disabled, so a Google login never adopts an existing seeded/password identity with the same email.
  - Both methods share the same session table, cookies, `/api/v1/me` and role guards.
- Roles come only from server state through the `AccessStore` boundary (`access.ts`):
  - `CatalogAccessStore` reads SA-13's `access(user_id, role, enabled)` with `SELECT role, enabled FROM access WHERE user_id = $1`.
  - `TestFixtureAccessStore` is test-only. `authConfig` allows it only with `APP_ENV=test`, never on Render.
  - Request bodies and headers are never consulted for roles.
  - Status rules: no rows means `pending`; rows that are all disabled mean `disabled`; any enabled row means `active` with only the enabled roles.
- Guards (`guard.ts`):
  - `authenticateHuman` reads the session row on every request. The cookie cache is disabled, so revocation takes effect on the next request.
  - It looks up grants, then enforces `active` status and `anyRole`.
  - Only `/api/v1/me` admits pending/disabled identities, so clients can show their state.
  - Any `Authorization` header on a human route is rejected, so service credentials never reach human endpoints.
- Mutation protection (non-GET human routes):
  - `Sec-Fetch-Site` must be `same-origin`/`none` or absent.
  - `Origin`, when present, must exactly match `BETTER_AUTH_URL` or `AUTH_TRUSTED_ORIGINS` (`null` is rejected).
  - The `X-StateAction-Client` header and a JSON body are required.
  - Native clients send no `Origin` or Fetch Metadata, but still need the header.
  - Better Auth keeps its own origin, callback-URL and cross-site-navigation login checks. `disableOriginCheck`/`disableCSRFCheck` are explicitly `false`, because Better Auth would otherwise skip them under `NODE_ENV=test`.
  - No credentialed CORS is offered.
- Caching: every auth, `/api/v1/me` and guard response carries `Cache-Control: private, no-store, max-age=0` and `Vary: Cookie, Authorization`. Protected pages are dynamic and served `no-store` by Next.
- Cookies:
  - `HttpOnly; SameSite=Lax; Path=/`, host-only.
  - When `BETTER_AUTH_URL` is https, cookies are also `Secure` and use the `__Secure-` prefix.
  - Sessions last seven days with a one-day refresh window.
  - **Refresh path.** Only route handlers can set cookies, so only they may extend a session. Server Components (`pageIdentity` for `/` and `/login`) look the session up with Better Auth's `disableRefresh`: they read and enforce the row but never move its expiry. The home page renders the `SessionRefresh` client component. It calls `GET /api/v1/me` once per page load, and again when the tab becomes visible (at most every 10 minutes). Inside the refresh window that response carries the re-issued cookie, so the row's `expiresAt` and the cookie's `Max-Age` move together. A 401 sends the browser to `/login`. Without JavaScript the session is not extended and ends seven days after the last refresh, never later than the row.
  - **Rotation semantics, measured on 1.7.15:**
    - Each sign-in mints a new random server token. Forged or unsigned cookies are ignored.
    - Inside the refresh window, `/api/v1/me` forwards a re-issued cookie and extends the row.
    - Better Auth keeps the same token value on refresh. It does not rotate the token value on every refresh.
    - Sign-out, `revoke-session(s)` and `revoke-other-sessions` delete rows server-side. Expired rows are deleted, and their cookie is cleared on the next lookup.
- Rate limiting: Better Auth's in-memory limiter is enabled (sign-in: 3 per 10 s per client IP). See [Client IP and ingress](#client-ip-and-ingress).
- Display names (`user.name`) come from the seed or from Google and are **untrusted display text**. Render them escaped, and never treat them as an operator-assigned label or a role. Users cannot edit them through Better Auth.
- Errors use the SA-12 `http.error-envelope.v1` shape. Configuration problems are logged server-side and returned as a generic 503. Setting names and values are never shown to users.

## Service principals

`service.ts` provides typed credentials for non-human callers. Only workflow, cron and worker principals are defined:

| Caller              | Kind       | Scopes                                     | Binding             |
| ------------------- | ---------- | ------------------------------------------ | ------------------- |
| Workflow controller | `workflow` | `jobs:status`, `jobs:reconcile`            | not job-bound       |
| Repair cron         | `cron`     | `jobs:repair`                              | not job-bound       |
| Processing worker   | `worker`   | `job:claim`, `job:heartbeat`, `job:result` | exactly one `jobId` |

Credential rules:

- Tokens are `sa_svc_` plus 32 random bytes, and only their SHA-256 is stored.
- Lifetime is at most 24 h.
- `authenticateService` accepts only `Authorization: Bearer`. It never falls back to cookies.
- It checks expiry, revocation, audience, kind, scope and job binding.
- Denials are generic and keep the reason server-side.

The `ServiceCredentialStore` is injectable. Persistence, issuance and the `/internal/v1` routes belong to the job-orchestration tickets. No Render API key, database URL or R2 credential is provisioned for these principals here.

## Settings and secret map

Web service only. The workflow and worker environments receive none of these settings.

| Setting                                     | Local loopback          | Development (Tailscale)                                                  | Render (staging/production)                                                                              |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                   | `local`                 | `development`                                                            | `staging` / `production`                                                                                 |
| `BETTER_AUTH_URL`                           | `http://127.0.0.1:3000` | `https://tim-work-pc.taila68f99.ts.net:8444` (root binds the port later) | the service's public https origin                                                                        |
| `BETTER_AUTH_SECRET`                        | random, ignored `.env`  | random, ignored `.env`                                                   | Render secret (`sync: false` or `generateValue`), distinct per environment                               |
| `AUTH_TRUSTED_ORIGINS`                      | optional                | e.g. `http://127.0.0.1:3000`                                             | only real extra origins; no wildcards                                                                    |
| `AUTH_LOCAL_PASSWORD`                       | `true`                  | `true` (seeded users)                                                    | must be unset/`false`; refused when `RENDER=true`                                                        |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional                | optional                                                                 | Render secrets after the Google gate                                                                     |
| `DATABASE_URL`                              | local Postgres          | local Postgres                                                           | resolved by `applicationDatabaseUrl`: `DATABASE_URL`, else `DATABASE_HOST/PORT/NAME` + `APP_DB_PASSWORD` |

`authConfig` fails closed in these cases:

- unknown `APP_ENV`;
- missing, short or placeholder secret;
- missing database URL;
- a non-https URL outside loopback, or any non-https URL in hosted environments;
- origins that contain paths or wildcards;
- a half-configured Google client;
- no sign-in method;
- local password mode while hosted or on Render;
- the test-fixture store outside `APP_ENV=test`;
- `BETTER_AUTH_TRUSTED_ORIGINS` or `BETTER_AUTH_SECRETS` present at all, even empty;
- `AUTH_SECRET` set to anything other than `BETTER_AUTH_SECRET`.

**Ambient Better Auth settings.** Better Auth 1.7.15 reads two settings straight from `process.env`, whatever options it is given. It appends `BETTER_AUTH_TRUSTED_ORIGINS` (unvalidated, wildcards included) to the trusted origins, both when it builds its context and again on every request. `BETTER_AUTH_SECRETS` takes precedence over the configured `secret`. StateAction supports neither, and checks for them at four points:

1. `authConfig` checks the injected environment.
2. `createAuthRuntime`/`createAuth` check the real ambient environment before construction.
3. Every `/api/auth/*`, guarded route, `pageIdentity` and `signInMethods` call re-checks the ambient environment.
4. The awaited `auth.$context` is verified once against the validated config: the same origin set, `secret === secretConfig === BETTER_AUTH_SECRET`, and the base URL.

A violation gives a generic 503 and a server log line that names the setting, never its value. Removing the setting restores service. Trusted origins come only from `AUTH_TRUSTED_ORIGINS`. The process environment is never mutated to hide these settings.

**Secret rotation.** Versioned rotation (`BETTER_AUTH_SECRETS`) is not supported in the pilot. Rotating means replacing `BETTER_AUTH_SECRET` and restarting. Existing session cookies then stop verifying and users sign in again; the old rows expire on their own.

R2 credentials stay backend-only and are unrelated to auth. Never put them in public web env, Flutter or workflows.

## Client IP and ingress

Better Auth is pinned to read the client address from `x-forwarded-for` only (`advanced.ipAddress.ipAddressHeaders`), and only when that header holds a **single** address. With `trustedProxies` unset, a multi-hop chain falls back to one shared per-path bucket. Our tests set a distinct `x-forwarded-for` per simulated client. That is **test-only setup**: a client-supplied forwarded header is not a trustworthy identity.

**Tailscale Serve (measured by root, 2026-11-01, Tailscale 1.104.1, host-to-own-Serve only).** Serve overwrote normal, forged and duplicate `X-Forwarded-For` with the actual tailnet source address, and overwrote `X-Forwarded-Proto`/`Host`. It removed `Forwarded`, but **preserved a forged `X-Real-IP`**. Hence the limiter ignores `X-Real-IP`, and an HTTP test proves that a rotating forged `X-Real-IP` cannot open new buckets. This trust holds only when the development server listens on loopback and Serve is its sole ingress. `make web` and the `dev`/`start` scripts already bind `127.0.0.1` (`scripts/platform/web.mjs`). Keep it that way: never `0.0.0.0` or a LAN address for this mode. Anyone who can reach the port directly could choose their own `X-Forwarded-For`. This is not phone or end-to-end auth qualification.

**Render** has not been measured and remains part of the hosted gate. Before relying on per-client limits there, measure what its ingress actually sends. If it appends to a client-supplied chain, configure `advanced.ipAddress.trustedProxies` with the real proxy addresses. The limiter is per instance and in memory, so multiple Render instances each keep their own counts.

## Tests

| Command                                    | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec nx run server:test`             | Config fail-closed rules, access decisions, catalog adapter SQL, Better Auth hardening options (`__Secure-` cookies, disabled paths → 404, X-Forwarded-For only), ambient `BETTER_AUTH_TRUSTED_ORIGINS`/`BETTER_AUTH_SECRETS` refusal (injected env, real `process.env`, after-construction, and the awaited `$context` from an unguarded real instance), guard outage handling, and the service-principal allow/deny matrix. No database.                                                                                                                                                       |
| `pnpm exec nx run server:auth-integration` | Two uncached suites on throwaway Postgres containers (`postgres:17.9` pinned image, uniquely named and labelled, ephemeral loopback port, tmpfs, always removed). **`catalog.test.ts` (real catalog, 12 cases):** the published SA-13 migrator and seed run as a NOSUPERUSER migration owner. Better Auth and `CatalogAccessStore` connect only as `stateaction_app`, and operator changes use the owner credential. **`runtime.test.ts` (fixture-only, 24 cases):** the Better Auth generator schema, with roles from the TEST-ONLY fixture store, for the broad cookie/CSRF/rate-limit matrix. |
| `pnpm exec nx run web:auth-e2e`            | **Real catalog.** The production `next build` served by `next start` (`APP_ENV=local`), connected only as `stateaction_app` to a database migrated and seeded by SA-13. Browser-style and native-style raw HTTP, plus one real headless Chrome case driven over the DevTools protocol. 12 cases (listed below). The Chrome case is skipped only when no Chrome/Chromium binary exists (`CHROME_BIN` overrides discovery).                                                                                                                                                                        |

`catalog.test.ts` (real catalog) covers:

- the default catalog source, with the runtime connected as `stateaction_app` (no superuser, CREATEROLE, CREATEDB or BYPASSRLS);
- Better Auth's own schema check accepting the SA-13 auth tables;
- seeded collector/staff/customer/outsider sign-in, with `/me` and role routes matching their catalog rows;
- the app role refused INSERT/UPDATE/DELETE on `access` (no self-grant);
- operator grant and revoke, and the pending → granted path, all effective on the next request;
- a disabled identity, and disabling an active session's only role;
- expiry, with the cookie cleared and the row deleted;
- refresh (pages never extend, and `/me` moves the row and cookie together);
- private/no-store/Vary headers;
- sign-out row deletion;
- wrong-password sign-in creating no session.

`runtime.test.ts` (fixture-only) covers:

- sign-in, cookie attributes, `/me` and role guards;
- client role fields ignored;
- pending/disabled access and next-request revocation;
- expiry with cookie clearing and row deletion;
- the refresh window;
- a Server Component lookup that does not extend the row, followed by `/me` moving the row and cookie expiry together;
- `/update-user` disabled;
- new tokens on each sign-in, and forged cookies;
- untrusted-origin sign-out;
- server-side sign-out and other-session revocation;
- disabled sign-up;
- login CSRF and open-redirect callbacks;
- native-style sign-in;
- mutation header checks;
- bearer rejection on human routes;
- rate limiting, including a forged `X-Real-IP` ignored;
- no configuration leaks.

`web:auth-e2e` covers:

- the Next server's database sessions being only `stateaction_app`;

- anonymous redirect;
- the login page (no settings exposed, `no-store`);
- staff home page roles matching `/api/v1/me`;
- page loads leaving the row unchanged, and `/api/v1/me` re-issuing a cookie whose expiry equals the row's;
- a real browser whose `SessionRefresh` call extends the row, and stores a cookie with the same expiry;
- pending/disabled pages;
- role revocation on the next page load;
- cross-origin sign-out refused, and server revocation;
- native sign-in;
- disabled sign-up.

These tests use Docker and are uncached. CI selects every affected `integration`, `auth-integration` and `auth-e2e` target in the **Local runtime smoke** job, under the existing **Required checks** gate. Hosted execution is reported separately from local results.

## Remaining gates

1. **Catalog integration (SA-13) — done locally.** The real migrator, seed, `CatalogAccessStore` and `stateaction_app` are exercised by `catalog.test.ts` and `web:auth-e2e`. Pilot roles remain operator rows written with the owner credential; there is no operator UI.
2. **Hosted wiring (SA-14, merged).** SA-14's Blueprint supplies `DATABASE_HOST`/`PORT`/`NAME` plus `APP_DB_PASSWORD` rather than `DATABASE_URL`. `authRuntime()` already resolves the database through SA-14's exported `applicationDatabaseUrl` (the same function the server config uses; production refuses any DSN that is not `stateaction_app`). The Next e2e and catalog tests run with `DATABASE_URL` absent. Add `APP_ENV`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` and the Google secrets to the web service only. Bind `PORT`/`0.0.0.0`. Measure Render's ingress IP headers (Tailscale's do not transfer). Keep `BETTER_AUTH_TRUSTED_ORIGINS`/`BETTER_AUTH_SECRETS` out of every env group; the service refuses to start sign-in with them. Run the SA-13 migrator plus `stateaction_grant_app_role` as the owner, and give the web service only the `stateaction_app` credential. Until this is done, the Blueprint is not auth-ready.
3. **Google OAuth.** Needs real web client credentials, redirect URI `${BETTER_AUTH_URL}/api/auth/callback/google`, the consent screen, and an actual browser sign-in. Not exercised.
4. **Native mobile (SA-17).** Signed Android build → native Google ID token → Better Auth `sign-in/social` with `idToken`, plus audience/nonce verification and secure cookie storage. Not exercised; local password tests do not prove it.
5. **Shared `/api/v1/me` contract — published.** `http.me.v1` (`packages/contracts/api/http/me.v1.schema.json`, in `catalog.v2.json`) describes the `data` of the success envelope. It is closed and bounded, with an opaque `authUserId` and an RFC 3339 UTC `expiresAt`. `active` requires at least one role, and `pending`/`disabled` require none. Roles are unique and in canonical order. TS, Python and Dart load it. The actual route output is validated against it in `server:auth-integration` and `web:auth-e2e`. The Flutter client (SA-17) still has to consume the Dart binding.
6. **Tailscale binding.** Root owns choosing and binding the development origin (port 8444 proposed; 443 and 8443 are in use). Serve's forwarded headers were measured (see [Client IP and ingress](#client-ip-and-ingress)). Phone reachability and phone sign-in are not yet exercised.
7. **Service credentials.** Persistence, issuance and the `/internal/v1` routes belong to the job-orchestration tickets. Only the guard and the allow/deny matrix exist here.
8. **Hosted CI.** The `auth-integration`/`auth-e2e` selection was simulated locally against the affected graph. Hosted execution of these targets must be confirmed on the PR's own CI run.
