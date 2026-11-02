# Shared clip review

Staff and customers use `/clips/[clipId]` inside the existing console shell.
Staff load the current clip and review state through the real API, preview the
brokered RRD in the shared Rerun component, inspect automatic checks, edit the
task label and notes, and explicitly approve or reject. Customers load only the
approved clip DTO and viewer; they never request the review endpoint, notes or
quality checks. A validated Data browser return link preserves allowed context.

Dataset choices are a draft until approval. An omitted selection preserves the
current assignments; an explicitly empty selection clears them. Rejection removes
all assignments through the atomic API, including assignments beyond the bounded
editor. A truncated membership list disables dataset editing while preserving
approve/reject semantics. Approval needs a task label and a loaded preview;
rejection remains available when a broken preview cannot load.

Drafts live in tab session storage under a user, clip and exact manifest key.
They survive reloads and viewer updates. A pending save is persisted before the
request and retried with the same review ID and exact body after an uncertain
network result. Definite conflicts require a refresh, retain label and notes, and
refresh known dataset revisions. Unseen selected datasets keep their previous
optimistic revision; no revision is invented. Sign-out aborts private requests,
clears private state/storage and tears down the shared viewer.

Automatic checks come only from the API's projection of the hash-verified
selected result. The view displays all contract-bounded checks, curated names and
integer measurements. Missing evidence stays “not evaluated.” Detection counts
do not claim pose accuracy. Arbitrary artifact messages, paths and provider
errors are never rendered as explanatory text.

Validation on the joined SA-37/SA-36 source: seven draft/command tests,
TypeScript checks and a production Next build passed. The real browser driver
passed fifteen checks: Rerun rendering, truthful missing QC, edit-without-write,
reload persistence, uncertain save retry, atomic approval, customer denial,
concurrent-review conflict without overwrite, retained conflict drafts,
375-pixel layout, rejection membership removal, sign-out cleanup, customer-only
preview, review-route denial and credential-free media reads. Responsive screenshots
are written to ignored `artifacts/sa39/browser/`.

Run the driver under the shared resource budget with pinned Node 24 and
`agent-browser` on PATH:

```sh
E2E_EXTERNAL_FIXTURES=/path/to/bounded-fixtures.env \
  agent-resource run -- node apps/web/test-e2e/clip-review-browser.mjs
```

The browser driver uses real Better Auth, the restricted application DB role,
private local S3 reads, actual API mutations and a real golden RRD. Its catalog
acceptance evidence is explicitly synthetic seed metadata, and Chrome WebGL is
explicitly software rendered. It validates UI/auth behavior only. The actual
native-source → CPU-hands → acceptance proof is a separate end-to-end check.
