# StateAction.ai

Private monorepo: [timothywangdev/stateaction](https://github.com/timothywangdev/stateaction). Work is tracked in [Linear](https://linear.app/hw-personal-projects/project/stateactionai-collection-and-review-mvp-392311683a3e).

Nx coordinates native pnpm, uv and Flutter/pub/Gradle commands. Lefthook checks staged content; affected CI and a guarded merger deliver one PR per ticket. Use Linear's exact provided branch name. [Repository workflow](docs/repository-workflow.md) · [Agent instructions](AGENTS.md)

| Source                                  | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `apps/mobile`                           | Existing Flutter collector                                     |
| `packages/stera_recorder`               | Android/iOS recorder and native tests                          |
| `apps/web`                              | Next.js console/API foundation                                 |
| `apps/jobs`                             | Official Render workflow/local executor foundation             |
| `packages/server`, `packages/contracts` | Server-only helpers and versioned platform contracts           |
| `workers/processing`                    | Python worker foundation                                       |
| `scripts`, `infra`                      | Reproducible tooling and local Postgres/S3-compatible services |

## Setup

```sh
git clone https://github.com/timothywangdev/stateaction.git
cd stateaction
```

Follow the [platform setup](scripts/platform/README.md) for pinned Node/pnpm/uv and the [mobile setup](scripts/mobile/README.md) for Flutter/JDK/Android. Then run:

```sh
make install
make check
pnpm affected --base=origin/main --head=HEAD
```

`make check` covers all projects. CI selects affected work and requires Android checks when mobile/toolchain/hook inputs change. The [local runtime smoke](scripts/platform/README.md#real-local-runtime) exercises real Postgres/S3, Next API, the official Render local runner and Python without a cloud deployment.

Mobile and recorder source are ordinary repository files; no app submodule is needed. The optional `stera-sdk` submodule supports historical diagnostics only. [Source history and licenses](third_party/stera-app/IMPORT.md) · [Current import evidence](docs/validation/sa-10-import.json)

## Scope and data

This published baseline contains the existing JPEG-in-MCAP recorder and a tested platform skeleton. H.264 capture, replacement auth/uploads, production processing and review features remain separate tickets. The earlier combined implementation branch is preserved while those changes enter through their own PRs. Host tests and Android builds do not qualify physical sensors, iOS signing or long recordings.

Keep recordings, images, credentials, private `.env`, APKs and generated state out of Git and caches. The checked-in MCAP fixture is synthetic. APK builds are uncached because Flutter bundles local configuration.

Run simulations before involving the user's phone. Physical operations require the [verified personal-profile helper](scripts/ANDROID_PERSONAL_DEVICE.md); work-profile operations are forbidden. Capture requires the user's intentional Start.

Earlier experiments remain in [capture validation](docs/pixel-v3-physical-validation.md), [geometry regressions](docs/geometry-v3-capture-regression.md), [hand-pose auditing](docs/hand-geometry-audit-2026-10-21.md) and [WiLoR comparison](docs/wilor-full-hand-benchmark.md). These are historical evidence, not the current setup or proof of training-quality labels.
