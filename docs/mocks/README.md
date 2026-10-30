# Clickable MVP interface mock

Open [index.html](index.html) directly in a browser. It is self-contained and works offline; no install, build, CDN, analytics or service connection. Alternatively, from this folder run `python3 -m http.server 8765` and open `http://localhost:8765`.

Everything is **DEMO / synthetic**. Refresh resets the in-memory state. Role links and scenario selectors are design-review controls, not authentication. The mock downloads only a small, explicitly labeled synthetic JSON manifest; it does not produce a training archive or checksum evidence. [UI/library decision](../components/ui-design.md).

## Routes and scenarios

| Hash route | Demonstrated flow |
| --- | --- |
| `#queue` | Upload/job states; search/filter; manual retry of resolved failure; cancel/terminal state; unknown submission cannot blindly retry; empty queue |
| `#review` | Synthetic repair clip, play/seek, 21-point overlay, missing observations, human task label/notes, approve/reject, stale-review conflict |
| `#releases` | Select approved clips, name release and recipient, freeze/export, ready inventory, publish, grant/revoke, stale frozen approval, oversized selection and export failure |
| `#customer` | Published granted catalog/inspection, sample-manifest download, estimated-3D limitations, no grants, expired download URL and revoked access |
| `#mobile` | Login/access pending, camera permission denial, interrupted/unclosed capture recovery, authorized offline capture, recording/stop/finalizing, low disk, ready source, pause/resume progress, expired part URL versus login versus multipart transport, wrong-account block, uploaded acknowledgement, server-verified source with explicit manual local cleanup |

Every screen has a **Scenario** selector. Normal interactions also move state: approve a clip, export/publish a release, then inspect it as a customer; start/stop capture and resume upload on mobile. Use Reset demo to return to initial state. Cancel/publish/revoke actions show a confirmation dialog. Dialogs, navigation and controls work by keyboard.

Review/customer scenes are original SVG illustrations with an animated synthetic skeleton, not real video or estimated anatomy. The overlay has 21 joints; frame positions/coverage/time are invented demonstration data. No customer review controls are present. Raw MCAP is excluded from the default delivery.

## Intended production behavior

The production Download all action downloads the **entire bounded TAR** directly from private storage, with a separate immutable manifest/checksum file, as defined in [review and delivery](../components/review-and-delivery.md). The MVP limits one release archive to 32 GiB **total, including TAR headers/metadata**; staff reselect smaller complete releases if needed. No automatic sharding. A refreshed URL may require a manual resume; previously issued URLs may remain usable after revocation until expiry. Publication rechecks frozen approvals; withdrawn/changed reviews require a new release/rebuild.

Production is Next.js with shadcn/ui/Tailwind/Radix plus the existing Flutter recorder. This plain HTML artifact is a review aid, not a second application implementation. No production code or active mobile checkout is changed.

## Inspected previews

| View | Screenshot |
| --- | --- |
| Staff recordings/jobs | [Desktop](screenshots/queue.png) |
| Hand-overlay review | [Desktop](screenshots/review.png) |
| Delivery builder | [Desktop](screenshots/releases.png) |
| Customer inspection/download | [Desktop](screenshots/customer.png) |
| Collector upload | [Phone](screenshots/mobile.png) |

Root inspected these five screenshots after the responsive fix. All 34 named scenarios rendered without page overflow at 1440 px and 375 px. Interaction checks covered review acknowledgement, stale frozen approval blocking, publish/grant/revoke, synthetic manifest generation and customer controls. These are mock checks; real upload/processing/download qualification is still pending.
