from generate_fixtures import DELETE, OUT, dump, mut, ok
from generate_sa87_fixtures import task
from generate_sa147_fixtures import PLAN

CONTRACT = "jobs.task-input.v6"


def render_sa154():
    recording = {
        **{
            key: value
            for key, value in task().items()
            if key not in ("recipe", "recipeSha256")
        },
        "schemaVersion": 6,
        "kind": "clip_plan",
        "recipeRef": "cpu_hand_canary@1",
        "recipeSha256": "8b8a626a4476de8a4c95ce5110142279105a61ee4667fd54f11bf2e3aa96a24e",
        "sourceSeconds": 120,
    }
    clip = {
        **recording,
        "kind": "clip_pipeline",
        "sourceSeconds": 1,
        "clip": {
            "id": "ad30fea5-011b-4cb1-9820-f076c0401e6a",
            "planVersion": 1,
            "planSha256": "b" * 64,
            "sourceRange": PLAN["spans"][0],
        },
    }
    cases = [
        ok("recording graph with a sealed source and published ref", recording),
        ok("clip graph with the verified plan and exact native range", clip),
        mut(
            "clip needs a verified range", clip, [("/clip", DELETE)], "schema_violation"
        ),
        mut(
            "recording scope cannot carry a clip",
            clip,
            [("/kind", "clip_plan")],
            "schema_violation",
        ),
        mut(
            "recipe ref includes a version",
            recording,
            [("/recipeRef", "cpu_hand_canary")],
            "schema_violation",
        ),
        mut(
            "source time cannot exceed the admitted duration ceiling",
            recording,
            [("/sourceSeconds", 7201)],
            "schema_violation",
        ),
    ]
    issue = {
        "action": "issue_node_claim",
        "owner": "controller-run-1",
        "nodeId": "track_hands",
        "bindingSha256": "8" * 64,
    }
    never = {"state": "never_submitted"}
    run = {
        "task": recording,
        "graph": {"recipeSha256": recording["recipeSha256"]},
        "nodes": {
            "source_span": {
                "state": "pending",
                "executionRef": None,
                "startDeadline": None,
                "startedAt": None,
                "claimedAt": None,
                "binding": {},
                "budgetSeconds": 120,
                "verifiedOutputs": [],
            }
        },
        "parentNodes": {},
    }
    claim = {
        "nodeId": "source_span",
        "invocationNonce": "n" * 43,
        "executionRef": "local-recipe-call",
        "backend": "local",
        "bindingSha256": "8" * 64,
    }
    grant = {
        "task": recording,
        "graph": run["graph"],
        "binding": {},
        "source": {
            "fileId": recording["jobId"],
            "sha256": "a" * 64,
            "sizeBytes": "24",
            "readUrl": "http://127.0.0.1:9/object",
        },
        "clipPlan": None,
        "producerFiles": {},
        "deadline": "2026-11-27T00:00:00.000Z",
        "uploadToken": "sa_svc_" + "t" * 43,
    }
    result = {
        "schema": "stateaction.processing_result.v7",
        "job_id": recording["jobId"],
        "recording_id": PLAN["recording_id"],
        "source_manifest_sha256": PLAN["source_manifest_sha256"],
        "recipe_id": recording["recipeRef"],
        "recipe_sha256": recording["recipeSha256"],
        "scope": "recording",
        "clip_plan": PLAN,
        "outputs": [],
        "clips": [],
        "checks": [],
        "nodes": [
            {
                "node_id": "source_span",
                "module": "clip_filter_passthrough@1",
                "state": "succeeded",
                "error_code": None,
                "receipt_sha256": "8" * 64,
                "execution_ref": "local-recipe-call",
                "source_job_id": None,
                "outputs": [],
                "counts": {"frames": 3},
            }
        ],
    }
    retry = {
        "schemaVersion": 1,
        "clipId": clip["clip"]["id"],
        "parentJobId": clip["jobId"],
        "nodes": ["track_hands"],
    }
    confirm = {
        **retry,
        "requestId": PLAN["recording_id"],
        "expectedPlanSha256": "a" * 64,
        "reason": "Check the hand result.",
    }
    batch = {"schemaVersion": 1, "scope": "failed_clips"}
    batch_confirm = {
        **batch,
        "requestId": confirm["requestId"],
        "expectedPlanSha256": confirm["expectedPlanSha256"],
        "reason": "Retry failed clips.",
    }
    fixtures = {
        CONTRACT: cases,
        "http.graph-retry-request.v1": [
            ok("explicit leaf rerun requires a clip and parent", retry),
            ok("recording batch requests eligible failed clips", batch),
            mut(
                "batch requests cannot pin a single clip",
                batch,
                [("/clipId", retry["clipId"])],
                "schema_violation",
            ),
            mut(
                "only a graph node ID is allowed",
                retry,
                [("/nodes/0", "../hand")],
                "schema_violation",
            ),
        ],
        "http.graph-retry-command.v1": [
            ok("retry confirmation pins the immutable preview", confirm),
            ok("batch confirmation pins the full preview", batch_confirm),
            mut(
                "confirmation requires the plan digest",
                confirm,
                [("/expectedPlanSha256", DELETE)],
                "schema_violation",
            ),
        ],
        "artifacts.processing-result.v7": [
            ok("settled recording graph and its verified plan", result),
            mut(
                "publication names the receipt digest explicitly",
                result,
                [("/nodes/0/receipt_sha256", DELETE)],
                "schema_violation",
            ),
        ],
        "jobs.graph-claim.v1": [
            ok("worker claims exactly one node and call", claim),
            mut(
                "claim nonce is required",
                claim,
                [("/invocationNonce", DELETE)],
                "schema_violation",
            ),
        ],
        "jobs.graph-grant.v1": [
            ok("recording scope grant pins the source and bound worker", grant),
            mut(
                "input grant must pin source bytes",
                grant,
                [("/source/sha256", DELETE)],
                "schema_violation",
            ),
        ],
        "jobs.graph-control.v1": [
            ok("lease and digest scope the node claim", issue),
            mut(
                "node ID cannot contain a path",
                issue,
                [("/nodeId", "../pose")],
                "schema_violation",
            ),
        ],
        "jobs.graph-control-result.v1": [
            ok("cancellation before submission has no execution ID", never),
            ok("file verification has saved progress", {"state": "verifying"}),
            mut(
                "unknown acknowledgement cannot authorize execution",
                never,
                [("/state", "unknown")],
                "schema_violation",
            ),
        ],
        "jobs.graph-run.v1": [
            ok("scoped graph state pins its task input", run),
            mut(
                "node execution must have an explicit state",
                run,
                [("/nodes/source_span/state", DELETE)],
                "schema_violation",
            ),
        ],
    }
    return {
        OUT / "contracts" / (name + ".json"): dump({"contract": name, "cases": items})
        for name, items in fixtures.items()
    }
