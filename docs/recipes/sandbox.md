# Compile isolation and licensing

The Linux compiler runs each recipe twice with CPython 3.12.13 in separate
bubblewrap namespaces. It mounts the interpreter, standard library, shared
libraries, SDK and one read-only source file. It clears the environment,
disables nested user namespaces and sets CPU, address space, descriptor and
file-size limits with prlimit. Separate wall deadlines bound interpreter
startup and recipe evaluation. If
bubblewrap or the namespace policy fails, compilation stops.

An import allowlist and audit hook reject file, socket and subprocess
operations during recipe evaluation. The kernel namespace and mount policy
provide the OS boundary. Python's hooks supplement that boundary. The compiler
checks the emitted graph against the module locks and JSON Schema outside the
sandbox. CI rebuilds it twice and compares the resulting bytes with the
committed version.

Review community submissions before running checks. Bubblewrap shares the host
kernel and the local rehearsal runs module stub implementations as ordinary
Python. Its receipts always mark output as synthetic. An exception or injected
failure is recorded as a failed window, and dependents record a blocked window.

Compiled graphs list non-commercial modules. Keep that provenance when using
FLORA-derived work in research. Module manifests and fixture stubs do not grant
rights to model code or weights.
