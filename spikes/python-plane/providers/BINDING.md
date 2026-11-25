# Modal deployment binding for the Python controller

## A. Verify the provider definition

The deployment publisher and controller read the same function and scheduling RPCs as the TypeScript verifier. They compare the derived app name, function ID, provider definition ID when present, and a digest over the decoded definition, stable execution handle, effective autoscaler, and verified model-volume manifest. The controller reads them again before it spawns. Keep the exact-call GPU watchdog and gross monitor.

The spike uses `modal-proto-binding-v1`, a domain-separated digest of deterministic protobuf encodings plus the existing canonical JSON identity envelope. The digest excludes input-plane URL and region. Issue new bindings with the same publisher and verifier. Existing TypeScript digests were computed over the JS SDK's decoded JSON, so they need their original verifier or explicit requalification. The Modal 1.6.4 wheel and protobuf descriptor are pinned. Treat an SDK upgrade as a verifier change and run wire fixtures against both approved and rejected shapes.

Definition verification limits what a deployer can change after trusted CI publishes the expected binding. This includes the image, code metadata, retry policy, resource ceilings, overriding the autoscaler, and attachments. The raw check also protects against accidental drift on an already deployed function. A deployer able to modify the trusted release manifest as well as the deployment can publish a self-consistent altered binding. Bindings require an independently trusted publish path for that threat. The preflight and spawn are separate RPCs, so a concurrent redeploy between them remains possible. Version-pinned invocation can narrow that race where the workspace plan supports it.

## B. Use a one-use release name and public function ID

CI would construct a manifest for the code, image specification, resources and release identity, derive a digest, and deploy a new app whose name contains that digest. A release ledger would reject any name already used, including failed attempts. CI would record the exact environment, function tag and hydrated object ID. The controller would recompute the name, hydrate `Function.from_name(app, tag, environment_name=...)`, require equality with the recorded ID before spawning, and enforce the existing stage lease, time budget, GPU watchdog and gross cutoff.

This catches a substituted name, an unexpected function identity, and an accidental cross-release lookup. The workspace-scoped token limits scope to the workspace. The one-use rule constrains the intended CI workflow. An operator or compromised credential with deployment access can still redeploy the same name and tag while preserving the object ID. The hosted probe demonstrated that directly by changing the code and image under the same name. That actor could substitute code or change effective resources, scaling or attachments while the controller continues to accept the old binding. The GPU watchdog sees activity after launch and the gross meter may lag. Neither validates code, secrets or data access.

B is acceptable for a disposable CPU-only, no-data experiment with an attended gross cap. B is insufficient for the MVP controller processing recordings or dispatching GPU work, even in a single-tenant workspace we control. Single tenancy reduces the set of deployers. The same authorized deployment path can still be used accidentally or through a compromised operator credential.

## Local and hosted evidence

Run the pinned Python suites from the spike worktree:

```sh
agent-resource run -- env PYTHONPATH=spikes/python-plane \
  uvx -q --from uv==0.13.6 uv run --locked --project spikes/python-plane/contracts \
  python -m unittest -v providers.test_modal_verifier providers.test_modal_executor contracts.test_generated
```

The gRPC fixture uses the Modal Python client's own control-plane transport and the same recorded response bytes used by the TypeScript test. The model manifest HTTPS read supplies fixture bytes through an injected reader. No hosted GPU or model reads were performed.

The Modal-only receipt is `/home/wearaway/flora-work/handoff/python-plane-modal-window.json`. Both final apps were verified stopped by exact ID. App-name and function-name lookups subsequently returned NotFound. Modal exposes stop and retains historical app records. The gross meter read USD 19.96858443 before and after. The window began and ended on 2026-11-25 UTC. [Modal App stop](https://modal.com/docs/sdk/py/latest/App#stop), [Modal function lookup](https://modal.com/docs/sdk/py/latest/Function#from_name), [Modal version-pinned invocation](https://modal.com/docs/guide/trigger-deployed-functions#version-pinned-lookups)
