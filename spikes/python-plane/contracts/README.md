# Generated Python wire contracts

[`generated.py`](generated.py) defines static types for all 33 `jobs.*` contracts and the three HTTP contracts used for DAG reads and response envelopes. [`generate.py`](generate.py) reads the versioned [v23 catalog](../../../packages/contracts/api/catalog.v23.json) and its JSON Schemas, follows local and cross-schema references and emits `TypedDict` records, literals, unions and typed `parse_wire` overloads.

`parse_wire(contract, data)` delegates to the existing [Python validator](../../../packages/contracts/python/src/stateaction_contracts/validate.py). It enforces the catalog's byte limits and cross-field rules, along with JSON Schema constraints that Python types cannot express, such as numeric bounds, regular expressions, conditional requirements and ordered array positions. A violation raises `ContractViolation` with the shared error code and field paths. The generated types preserve the wire keys and carry no provider dependency at import time.

From the repository root:

```sh
export PYTHONPATH=spikes/python-plane
agent-resource run -- uvx uv==0.13.6 run --locked --project spikes/python-plane/contracts \
  python spikes/python-plane/contracts/generate.py --check
agent-resource run -- uvx uv==0.13.6 run --locked --project spikes/python-plane/contracts \
  python -m unittest -v providers.test_modal_executor contracts.test_generated
agent-resource run -- uvx uv==0.13.6 run --locked --project spikes/python-plane/contracts \
  python -m unittest discover -s packages/contracts/python/tests -v
```

Omit `--check` to regenerate the module. The project and its [lockfile](uv.lock) pin the spike to Python 3.12.13, uv 0.13.6, Modal 1.6.4 and the existing Python contract package. The generated parser passed 301 existing fixture cases across 36 contracts, including 185 rejection cases. The upstream Python suite also passed, covering 1,066 cases across all 118 wire contracts plus digest and stage checks. Both suites use local fixtures.
