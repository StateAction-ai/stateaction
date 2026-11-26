# Recipe tools

Start with the [authoring guide](AUTHORING.md). Recipe Python describes graphs
and module manifests describe their ports, parameters, scope, cost constraints
and licensing. The compiler checks the graph against the module locks, fills in
parameter defaults and computes a stable order and digest. It records source
locations for review.

`recipes/` holds published definitions. `examples/` holds local rehearsals.
Both directories commit compiled JSON. `core/` contains the SDK, compiler,
sandbox and local rehearsal runner. The
[compiled graph schema](../../packages/contracts/recipe/compiled-graph.v1.schema.json)
defines the serialized format and generates Python and TypeScript types. Recipe
schemas live under `packages/contracts/recipe/`. The published API catalog
covers the active wire contracts.

The Python worker can run the supported CPU nodes on local files and replay
FLORA evidence. See [execution eligibility](AUTHORING.md#execution-eligibility)
for the supported module versions and binding requirements. The deployed
controller still uses stage recipes pending the cutover. See the
[architecture proposal](../components/recipe-architecture.md) for the migration.
