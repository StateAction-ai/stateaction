# StateAction.ai

Open source pipeline for robotics researchers. A person records first-person
video on an Android phone, the backend turns the recording into temporal action
segments, a caption per segment and hand pose, and a researcher reviews all
three in a web console with a Rerun preview for hand pose.

License: [Apache-2.0](LICENSE). Third-party terms: [NOTICE](NOTICE).

## Status

Early and under active development. The mobile recorder, upload path, Postgres
and S3-compatible storage, web console, job orchestration and the Python
processing worker are in the repository and tested on a local stack and an
Android emulator. Production processing of two-hour recordings, iOS, and
geometry/depth/mesh processing are not finished or are deferred. Host tests and
emulator runs do not qualify physical sensors, iOS signing or long recordings.

Segmentation and captioning currently use NVIDIA FLORA (TempSeg and Captioner)
behind a replaceable interface. FLORA is under a non-commercial research
license and is not included here; you obtain it from NVIDIA under its own terms.
See [docs/delivery-scope.md](docs/delivery-scope.md) for the full scope.

## Architecture

| Source                                  | Purpose                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| `apps/mobile`                           | Flutter collector for Android                                 |
| `packages/stera_recorder`               | Android/iOS recorder plugin and native tests                  |
| `apps/web`                              | Next.js console and API                                       |
| `apps/jobs`                             | Render workflow and local job executor                        |
| `packages/server`, `packages/contracts` | Server-only helpers and versioned platform contracts          |
| `workers/processing`                    | Python processing worker                                      |
| `workers/flora`                         | Optional tooling to run FLORA on Modal (you supply the model) |
| `scripts`, `infra`                      | Tooling and local Postgres/S3-compatible services             |

Flow: Android capture, upload, Postgres plus object storage, job orchestration,
processing (decode, hand pose, segmentation, captioning), review in the web UI.
The reference deployment targets Render with Cloudflare R2 storage.

## Quick start

Requirements: Node 24.22.2, pnpm 10.33.0, uv 0.13.6; Flutter, JDK 21 and the
Android SDK for mobile work. See [platform setup](scripts/platform/README.md)
and [mobile setup](scripts/mobile/README.md).

```sh
git clone https://github.com/StateAction-ai/stateaction.git
cd stateaction
make install
make check
```

The [local runtime smoke](scripts/platform/README.md#real-local-runtime) runs
real Postgres, S3-compatible storage, the Next API, the job runner and the
Python worker without any cloud account.

## Non-goals

- Not a hosted service; you run and pay for your own deployment and GPU.
- Not a bundle of model weights. No FLORA source, weights or recordings ship here.
- No geometry, depth or mesh reconstruction and no iOS release yet.
- Raw recordings and captured images never belong in Git.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Maintainer and agent workflow notes live in [AGENTS.md](AGENTS.md) and
[docs/repository-workflow.md](docs/repository-workflow.md).
