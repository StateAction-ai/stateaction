# Web and API foundation

Node 24 / Next.js App Router. From the repository root, `pnpm --filter @stateaction/web... build` builds this app and its shared dependencies; `pnpm --filter @stateaction/web typecheck` generates route types and checks TypeScript.

`GET /api/v1/health` checks migrated Postgres and the configured S3 bucket. It returns only readiness booleans, never credentials/provider errors. `POST /api/v1/development/workflows/verify` is a bounded, bearer-protected local smoke endpoint. It refuses production and non-loopback workflow endpoints. It is not product authentication or a recording job API.

Start with `make web` after the setup in [local tooling](../../scripts/platform/README.md). `@stateaction/server` uses Next's `server-only` guard; provider code must not be imported into client components.

## Authentication (SA-15)

`/login`, `/` and sign-out use the single Better Auth instance at `/api/auth/*` (from `@stateaction/server/auth`). `GET /api/v1/me` returns the server identity, access status (`active`/`pending`/`disabled`) and roles; roles never come from the client. Browser mutations send `X-StateAction-Client` and JSON. Set the auth values from `.env.example` (replace `BETTER_AUTH_SECRET`) before `make web`; until then sign-in reports itself unavailable. `pnpm exec nx run web:auth-e2e` runs the production build against an isolated Postgres. Design, settings map and open gates: [auth and access](../../docs/components/auth-and-access.md).

Collector recording routes (from `@stateaction/server/recordings`): `POST /api/v1/recordings`, `POST /api/v1/recordings/{recordingId}/seal` and `GET /api/v1/recordings/{recordingId}`. They require an enabled collector session on every request and need the explicit `PROCESSING_PROFILE_REVISION`/`SUPPORTED_RGB_PROFILES` and S3 settings; source bytes never pass through them. See [recording admission](../../docs/components/recording-admission.md).

## Console shell, Settings and profile (SA-16)

Pages under `app/(console)` (`/pipeline`, `/data-browser`, `/settings`) read the shared Better Auth session and the operator-managed access table on every request (`lib/server-session.ts`); there is no fixture, header or environment identity path. Staff get Pipeline and Data browser, customers get granted Data only, and collector-only, pending, disabled or unavailable states show an honest notice with sign-out and no private navigation. Every page re-checks its own role because layouts do not re-run on client navigation, and all HTML and API replies are `private, no-store` so Back and direct URLs re-check the session.

`PATCH /api/v1/me/profile` (`profileRoute` in `@stateaction/server/auth`) changes only the signed-in user's own display name (trimmed, 1-80 characters, rules shared with the Settings form from `@stateaction/server/display-name`). The target row is the session's user id; the body is closed (`{"name": string}`, at most 1 KiB), the request must come from the exact trusted Origin with `X-StateAction-Client: web` and same-origin Fetch Metadata, and Better Auth's broad `/api/auth/update-user` stays disabled. The schema is a proposed local contract, not published registry conformance. The web service connects only as `stateaction_app`.

Sign-out clears private browser state only after the server revokes the session (sign-out accepted and `/api/v1/me` then refuses the cookie); a failed revocation keeps everything and offers a retry.

`pnpm exec nx run web:auth-e2e` also runs `test-e2e/console.e2e.test.mjs` (real Next production server, Better Auth and restricted Postgres). `node test-e2e/serve-console.mjs` starts the same ephemeral stack for manual browser checks (it prints a throwaway origin and password).
