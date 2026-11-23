# Open source release: audit, decisions and settings checklist (SA-138)

Status: owner decisions of 2026-11-23 are applied below, including approval of the visibility change after this PR merges and the settings in section 6 are applied. Nothing
here rewrites history or changes visibility.

Audit date 2026-11-23, head `034ff75` of `main`. Scope: all 21 branches, 1 tag
and 97 `refs/pull/*` refs of `StateAction-ai/stateaction` (293 commits, mirror
clone 26 MB), plus the 614-commit local object database used by maintainer
worktrees.

## 1. Secret and private-data scan

| Tool                                           | Result                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| gitleaks 8.30.1, `git --log-opts=--all`        | 24 hits on the remote refs (35 on the local database), all reviewed: no real secret          |
| trufflehog 3.100.1, all refs, verification off | 18 unverified hits, all `postgres://` URIs, all placeholder hosts or credentials; 0 verified |
| Pattern sweep (AWS, GitHub, OpenAI-style, PEM) | 0 hits in tracked files                                                                      |
| Extension sweep over all history               | no keystores, signed APK/AAB, weights, `.env` files, certificates or recordings              |

Gitleaks hits by rule and file (values not reproduced): `generic-api-key` on

- `apps/server/.env.example`, `apps/server/.env.prod.example`, commit `fce8de1a`: a `replace-me` style `BETTER_AUTH_SECRET` placeholder;
- `apps/mobile/test/.../source_v2_test.dart`, `native_closed_source_ack_test.dart` (commits `0959abe5`, `d880e950`): hex test-fixture acknowledgement tokens;
- `packages/server/test-integration/restore-drill.test.ts` (`0fd668a3`, `af27f1b0`): a canary test string;
- `packages/server/test-integration/transport-faults.test.ts` (`244f4adf`, `4b0c1ea6`, `bb617ac9`): SQL object-key literals;
- `docs/components/storage-and-data-model.md` (`6b1294f0`): prose false positive;
- `tests/fixtures/flow_report/state/jobs/*.json` (6 files, commits `4bf93a0a`, `989756f6`): CI lock-key names.

Trufflehog hits: `apps/server/.env.prod.example` (Supabase pooler template with `user:password` and `REGION`), `scripts/platform/hosted-smoke.sh`, and server and Modal tests with hosts such as `db.invalid`, `h`, `dpg-abc`, `$DB_HOST`.

Open findings of type secret: 0. Open findings of type private data: see
section 3 (workstation paths and device notes, no credentials). Recommended
hygiene, not required: rotate nothing, but add a repository secret-scanning
config once public (section 6).

Author identities visible in history: `timothywangdev@gmail.com` (92 commits),
the GitHub noreply address (542), `ekakshjanweja <jekaksh@gmail.com>` (1, the
upstream Stera import commit `fce8de1`) and `github-actions[bot]` (5). These
become public with the history. Decision: accepted by the owner, no rewrite (section 7).

### Object size review

Largest blobs: `apps/mobile/assets/images/app_vid_demo_thumbnail.png` 3.7 MB,
`ui/scaffold_texture.png` 3.0 MB, `onboarding/image1.png` 1.9 MB, bundled fonts
0.8 to 0.9 MB, `docs/project-management/linear-mobile-update-receipt.json`
0.6 MB. Nothing is above 4 MB. Media files in history: the synthetic
`apps/web/test-e2e/fixtures/review-24s.mp4` (103 KB) and `golden-clip.rrd`,
`tests/fixtures/android_geometry_v{2,3}` (synthetic MCAP and 32x16 thumbnails,
documented as synthetic), five Stera notification sounds, a ChArUco target PDF
and mobile UI/doc screenshots (`docs/mocks/screenshots`, `docs/figures`). No
HomER/WGO-Bench (CC BY-NC-SA) media or weights: the name appears only in
code and docs that refuse to commit it and in `.gitignore`.

Owner to confirm: the mobile UI images and sounds inherited from the Stera app
(Apache-2.0, FPV Labs) and `docs/mocks/screenshots/*` contain no personal data
(spot review found none; screenshots were not exhaustively inspected).

## 2. Licensing

Dependency scan (lockfiles; registry metadata, native code inside wheels not inspected):

| Ecosystem | Packages | Licenses                                                                                                         |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| npm/pnpm  | 289      | MIT 209, Apache-2.0 38, ISC 17, BSD 17, 0BSD, BlueOak, MPL-2.0 2, LGPL-3.0-or-later 1, CC-BY-4.0 1, Python-2.0 1 |
| PyPI/uv   | 61       | MIT/BSD/Apache/PSF/MIT-CMU; MPL-2.0 3 (certifi, pathspec, tqdm)                                                  |
| pub.dev   | 212      | BSD 153, MIT 43, Apache-2.0 5, MPL-2.0 3 (dbus, nm, upower), BSL-1.0 1 (json_schema)                             |
| Gradle    | direct   | Apache-2.0; ARCore under Google terms; `org.json` (JSON license, test only)                                      |

Flagged, none blocking for Apache-2.0: no AGPL, GPL or non-commercial dependency was found.
LGPL-3.0 `@img/sharp-libvips-linux-x64` (dynamic, via Next/sharp), MPL-2.0 file-level copyleft
items, ARCore (proprietary terms, needs Google Play Services for AR),
`sqlcipher_flutter_libs` 0.7.0+eol (end of life, native SQLCipher), the
non-OSI JSON license of test-only `org.json`. Unverified manually: rerun-sdk
0.41.0 metadata (assumed MIT OR Apache-2.0), Dart `html` and `json_schema`.

Imported code: the Stera mobile stack is Apache-2.0, copyright 2026 FPV Labs
(`third_party/stera-app/{LICENSE,NOTICE}`); fonts are OFL-1.1. Both are carried
in the new `NOTICE`.

FLORA (NVIDIA, non-commercial research license): no FLORA source, weights or
checkpoints are tracked (about 70 files mention it, none are weights or NVIDIA
headers; the READMEs say "not in this repository"). It is reached through
`workers/processing/.../flora_adapter.py` and the Modal tooling in
`workers/flora`, which load it from a user-supplied `FLORA_REF`. The adapter is
a replaceable interface, but the Modal tooling is FLORA-specific. Public docs
now state that users obtain FLORA under its own license (README, NOTICE).
Follow-up in this PR: none. Recommend (owner decision): keep `workers/flora`
as optional tooling, which is what this PR assumes.

`stera-sdk` submodule: gitlink to `https://github.com/fpv-labs/stera-sdk`
(public, Apache-2.0, pinned commit `df6a5ec` exists on its `main`), documented
as "historical diagnostics only". Recommendation: keep it (public and
licensed), listed in NOTICE. Alternative: remove the gitlink and `.gitmodules`
in a later change. Not removed here.

## 3. Content review list (not changed by this PR unless stated)

| Item                                                                                                                                                                 | Finding                                                                                                                                                                            | Proposal                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                                                                                                                                          | Said "Private monorepo", linked Linear and `timothywangdev/stateaction`                                                                                                            | Rewritten in this PR for a public audience (old text removed: private-repo line, Linear link, ticket-flow paragraph; maintainer links kept via AGENTS.md) |
| `AGENTS.md` (86 lines)                                                                                                                                               | Names the "user's company/work profile", personal-profile rule, Pixel device notes (`user 0`/`user 10`), workstation RAM caps, `/tmp` lock paths, private repo name, Linear policy | Keep as maintainer/agent file; move workstation and device-profile specifics to a private place or generalise; owner decides                              |
| `docs/agent-rules/android-device-profile.md`, `docs/agent-rules/*`, `scripts/ANDROID_PERSONAL_DEVICE.md`                                                             | Company/work profile wording and device notes                                                                                                                                      | Reword to "personal profile only" without employer reference, or keep private                                                                             |
| `docs/components/workstation-resource-guard.md`                                                                                                                      | 6 references to `/home/wearaway`, `agent-resource-guard`                                                                                                                           | Generalise paths to placeholders                                                                                                                          |
| `docs/validation/wilor-*-preflight.json`, 9 files in `docs/validation`                                                                                               | `/home/wearaway/...` absolute paths                                                                                                                                                | Redact paths or keep as receipts                                                                                                                          |
| `tests/fixtures/flow_report/state/jobs/*.json` (42 files), `ticket-events.jsonl`, `real-lane-log.jsonl`                                                              | Workstation paths, branch names with the maintainer's Linear username prefix, flowlog output                                                                                       | Replace with synthetic fixtures or accept                                                                                                                 |
| `workers/flora/modal_flora.py`                                                                                                                                       | Default `FLORA_REF` is `/home/wearaway/flora-work/...`                                                                                                                             | Make `FLORA_REF` required (small code change, not done here)                                                                                              |
| `apps/web/test-e2e/*`, `apps/jobs/test-integration`                                                                                                                  | A few `/home/wearaway` paths                                                                                                                                                       | Redact                                                                                                                                                    |
| `docs/repository-workflow.md`, `docs/local-ci.md`, `scripts/automation/README.md`, `docs/components/inline-quality-checks.md`, `spikes/android/processing/README.md` | Linear workspace URL (`hw-personal-projects`), maintainer-only ticket policy                                                                                                       | Keep as maintainer docs; the links 404 for outsiders; owner decides                                                                                       |
| `spikes/android/capture/result.json`, `physical-failure.json`, `spikes/android/upload/*`                                                                             | Work-profile mentions and physical-device results                                                                                                                                  | Review before publishing                                                                                                                                  |
| `docs/capture-comparison-*.md`, `docs/pixel-v3-physical-validation.md`, device-specific docs                                                                         | Personal phone model and test notes                                                                                                                                                | Accept or trim                                                                                                                                            |
| `.planning/debug/hand-reconstruction.md`                                                                                                                             | Agent scratch notes                                                                                                                                                                | Move out or accept                                                                                                                                        |
| Test strings such as `Pixel ...` in contract fixtures                                                                                                                | Device model names only, no serials                                                                                                                                                | Accept                                                                                                                                                    |

No emails other than commit authors, no serials, no phone numbers and no
company names beyond the "company/work profile" wording were found in the
tracked tree.

## 4. Added by this PR

`LICENSE` (Apache-2.0, proposed), `NOTICE`, `README.md`, `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`,
`.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE/external.md`
(the maintainer `pull_request_template.md` stays the default),
`tests/automation/test_workflow_hardening.py`, and a fork guard on the
`auto-merge.yml` job. Nothing else was deleted.

Remaining placeholder: the CODEOWNERS handle `@timothywangdev`.

## 5. Workflow review

- No `pull_request`, `pull_request_target` or `issue_comment` trigger: all four workflows are `workflow_dispatch`, `workflow_run` (merger) or `deploy/*` tags. Fork PRs cannot reach secrets.
- Every action is pinned to a full commit SHA, checkouts use `persist-credentials: false`, top-level `permissions` are read-only except the merger.
- `auto-merge.yml` checks out `main` only, runs no PR code, rejects non-same-repository `workflow_run` events in the script and now also in the job `if`.
- Secrets appear only in `deploy.yml`'s `deploy` job (`environment: production`); `validate` has none.
- `tests/automation/test_workflow_hardening.py` enforces these rules in the gate.
- Residual risk: anyone with write access can push a `deploy/*` tag. Protect it with an environment rule (section 6).

## 6. Repository settings checklist (apply after the owner's go)

Current state read via the API: private, squash merge only, delete-branch-on-merge on, Actions allowed for all actions, secret `RENDER_API_KEY` exists, environment `production` exists, no webhooks, `security_and_analysis` not reported.

1. Settings > General: keep squash-only merge and leave "Always suggest updating pull request branches" off (the merger never refreshes branches).
2. Settings > Code security: enable private vulnerability reporting, secret scanning, push protection, Dependabot alerts and security updates; enable code scanning default setup if wanted.
3. Add `.github/dependabot.yml` after the license decision (npm, pip/uv, pub, gradle, github-actions); Dependabot PRs follow the maintainer flow.
4. Settings > Actions > General: "Require approval for all outside collaborators" for fork PR workflows; default `GITHUB_TOKEN` permission read-only; set "Allow actions" to GitHub-owned plus the pinned actions; enable "Require actions to be pinned to a full-length commit SHA".
5. Environment `production`: required reviewers, restrict deployment branches and tags to `main` and `deploy/*`, keep every secret there; move `RENDER_API_KEY` from the repository secrets into the environment and delete the repository-level copy.
6. Tag protection or ruleset for `deploy/*`: only maintainers may create.
7. Rulesets on `main` (available once public): require pull request, block force pushes and deletion, restrict who can push. The local gate remains the required check; `pnpm ci:merge` stays the merge path.
8. Rotate nothing found by the scan; consider rotating `RENDER_API_KEY` when moving it.
9. Issues on, Discussions optional, Wiki off; enable "Report content".
10. Org: confirm the public repo needs no paid seat, that Actions minutes are free for public repos (hosted CI stays manual), and that no private Linear/Modal/Render links remain in `.github`.

## 7. Owner decisions (2026-11-23)

1. License: Apache-2.0, final.
2. Security and conduct contact: `contact@stateaction.ai` (applied in `SECURITY.md` and `CODE_OF_CONDUCT.md`).
3. History: publish as is. The owner accepted that the personal author email (92 commits) becomes public, after being told that an in-place rewrite cannot clear GitHub's hidden `refs/pull/*`. No rewrite is performed. The dry run and runbook below stay as documentation, and a pre-rewrite backup mirror exists outside the repository.
4. Section 3 content: publish as is, no redaction.
5. `stera-sdk` submodule stays (used by `scripts/process_capture.py` and two local-ci stages) and stays in NOTICE. NOTICE holder: `StateAction.ai`.
6. Production environment and `deploy/*` tag protection are documented in section 6 (items 5 and 6) and are a pre-flip requirement.

### History rewrite dry run (documentation only, not executed)

`scripts/release/history-rewrite-dry-run.sh` on a throwaway mirror of all refs (293 commits): 293 of 293 trees identical, 0 objects with the old address, 119 of 119 ref tips change, 291 signatures dropped (no "Verified" badges afterwards). GitHub's hidden `refs/pull/*` cannot be rewritten by push, so the old address stays reachable there unless the owner creates a new repository or has GitHub purge them; options A/B/C are in the runbook. Not executed by decision of the owner (item 3).

## 8. The visibility change (do not run until the owner says go)

```sh
GH_TOKEN="$(gh auth token --user timothywangdev)" gh repo edit StateAction-ai/stateaction --visibility public --accept-visibility-change-consequences
```
