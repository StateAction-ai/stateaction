# Contributing

Thanks for helping. This project is licensed under Apache-2.0; by submitting a
change you agree it is provided under that license (Apache-2.0 section 5).
Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Open an issue to discuss anything larger than a small fix.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.
- Never commit recordings, captured images, credentials, `.env` files, model
  weights, signing keys or APK/AAB files. Test fixtures must be synthetic. The
  repository history is public and cannot be cleaned afterwards.

## Set up

Pinned toolchain: Node 24.22.2, pnpm 10.33.0, uv 0.13.6; Flutter, JDK 21 and the
Android SDK for mobile work. Details: [platform setup](scripts/platform/README.md),
[mobile setup](scripts/mobile/README.md).

```sh
make install
make check
pnpm affected --base=origin/main --head=HEAD
```

Use the committed lockfiles (`pnpm install --frozen-lockfile`, `uv sync --locked`).

## Pull requests

- One logical change per PR, rebased on the latest `main`, no merge commits.
  Maintainers squash merge, so the PR becomes one commit on `main`.
- Open the PR from a fork with the `external.md` template
  (`?template=external.md`).
- Run the checks for what you changed (`make check`, or `pnpm affected`).
  Mobile changes need the Flutter/Gradle checks and an emulator run for the
  recorder path; say what you could not run.
- Add or update tests with the change. Tests must be deterministic: no sleeps
  as ready signals, no shared ports, per-test state, bounded waits.
- Do not weaken thresholds or assertions to make a change pass. Failed model
  windows and captions are recorded as failed, never as empty results.
- Keep the model behind the replaceable interface; do not add FLORA code,
  weights or other non-commercially licensed material.

## How maintainers merge

Hosted GitHub Actions in this repository are manual. The maintainers run the
full gate locally (`pnpm ci:local`) on the exact head of each PR and merge only
after a passing receipt, so a fork PR is merged after a maintainer has run the
gate on it. Details: [docs/local-ci.md](docs/local-ci.md) and
[docs/repository-workflow.md](docs/repository-workflow.md). The ticket and
branch-naming rules in `AGENTS.md` apply to maintainers and their agents, not to
outside contributors.

## Mobile and devices

Use the guarded emulator launcher, never start emulators by hand. Only test on a
physical phone's personal profile, never a managed or work profile; see
[docs/agent-rules/android-device-profile.md](docs/agent-rules/android-device-profile.md).
