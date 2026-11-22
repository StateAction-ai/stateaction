# Monorepo commands and checks

- Nx coordinates tasks and affected checks; pnpm manages TypeScript dependencies, uv manages Python, and Flutter/pub/Gradle retain native mobile builds. Do not introduce another task orchestrator or a paid remote cache. The mobile and recorder projects use actual Flutter/pub/Gradle targets; mobile-tooling covers their local adapters and profile-safety helper.
- Use the pinned versions and committed lockfiles. Run `pnpm install --frozen-lockfile`, the documented uv sync, `pnpm check` and relevant integration commands. Use `pnpm affected --base=<base> --head=<head>` for affected checks; first setup must also pass a clean full run.
- Install Lefthook with the documented setup (`pnpm hooks:install`). Pre-commit checks validate staged content without auto-staging unrelated edits; pre-push rejects `main`. Do not routinely disable hooks. Fix locally reproducible failures before publishing.
- Cache deterministic builds and isolated checks only. Real uploads, database/workflow integration, device simulations and provider mutations must run and must not replay a cached success. Never cache or commit private recordings, images, credentials or raw worker payloads.
- Report local test results and hosted CI separately. Keep paid deployment, hardware qualification and feature completion distinct from a passing scaffold test.
