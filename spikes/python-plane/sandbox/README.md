# E6 recipe sandbox

This spike exercises the Python authoring path from recipe architecture R3.3 and the local E6 check in R3.4. It uses the repository's pinned CPython 3.12.13 and has no Python dependencies.

From the repository root, run the example and its test suite.

```sh
agent-resource run --mem 1G -- bash -eu -o pipefail -c '
  cd spikes/python-plane/sandbox
  p=$(uv python find --offline 3.12.13)
  "$p" -B compile_recipe.py recipes/egocentric_default.py --digest
  "$p" -B compile_recipe.py recipes/egocentric_default.py | sha256sum
  for run in $(seq 1 20); do "$p" -B -m unittest -q; done
'
```

The CLI evaluates each recipe twice in fresh bubblewrap instances. The parent serializes each graph to UTF-8 JSON, sorts object keys in UTF-16 order, and compares SHA-256 digests before releasing either graph. The graph uses strings for fractional budget coefficients and USD amounts, and accepts integers in the interoperable JSON range. This restricted value set avoids the need for a general-purpose JSON number canonicalizer.

Bubblewrap uses `--unshare-all`, requires user and cgroup namespaces, disables nested user namespaces, drops capabilities, and clears the environment. It mounts the pinned interpreter and standard library, the required loader libraries, the SDK, and one read-only recipe source. The sandbox has a 16 MiB scratch tmpfs and no host home or repository mount. `prlimit` sets 5 seconds of CPU time, 512 MiB of address space, 64 file descriptors, a 1 MiB file size limit, and no core dumps. The parent sets an 8-second wall deadline for each compile. Startup errors fail closed as `sandbox_unavailable`.

The worker starts with `-P -s -S -B` in the cleared environment so CPython honors `PYTHONHASHSEED=0`. CPython's `-I` implies `-E`, which ignores the seed. The worker preloads the trusted SDK, clears the module search path, checks import statements with the AST, and guards runtime imports through a finder and a restricted `__import__`. The audit hook reports `nondeterministic_api` for blocked file, socket, and process operations.

## Local evidence

All seven tests passed in 20 consecutive runs under an `agent-resource --mem 1G` Free scope. The cgroup reported a 1 GiB memory cap and zero swap. The run used bubblewrap 0.11.1 and util-linux prlimit 2.41.3. A CPU-bound recipe exited with code 137 after 5.03 seconds.

The checked-in example uses repository JSON formatting. The compiler emits canonical bytes for digesting. The five-node egocentric example produced 1,527 canonical JSON bytes with SHA-256 `968d5537d32ff75756c44df51ac8bb5fbf84a8b47e3d2d63ed91a80db59c0408`. The suite checks both CLI output modes and verifies that a source formatting change preserves the digest. A mismatch test injects two different graphs at the sandbox result boundary.

The recipe probes cover file access, forbidden imports, cached and dynamic imports, and a recipe that catches the initial audit error. A trusted probe inside the same bubblewrap command confirms that only loopback is visible, attempts to write the root or recipe return `EROFS`, and a synthetic host canary is absent. It verifies the effective limits, stripped environment, fixed Python hash seed, and absence of inherited descriptors beyond stdin, stdout, and stderr. It also invokes the file, socket, subprocess and `os.system` APIs and checks the denial codes. The missing-bubblewrap test verifies the failure path.

## Limits

This produces a spike authoring graph using handwritten stand-ins for generated bindings. Module-lock validation, production graph validation, cost estimation, and runtime admission are outside the spike. The mount layout targets the Linux x86-64 gate host and its uv-managed interpreter. The Python checks catch prohibited APIs in the tested cases. The OS namespace and mount boundary carries the isolation, with the host kernel shared and no seccomp filter installed. The evidence covers local compilation of the supplied fixtures.
