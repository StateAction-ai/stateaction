SHELL := /bin/bash
RENDER ?= $(CURDIR)/artifacts/platform-tools/render/render
.PHONY: install check build typecheck test infra-up infra-down migrate storage-init web workflows worker-check smoke render-cli
render-cli:
	python3 scripts/platform/install-render.py
install:
	pnpm install --frozen-lockfile
	uv sync --project workers/processing --locked
check: typecheck test build worker-check
build:
	pnpm build
typecheck:
	pnpm typecheck
test:
	pnpm test
worker-check:
	cd workers/processing && uv run --locked mypy
	uv run --project workers/processing --locked python -m unittest discover -s workers/processing/tests -v
infra-up:
	docker compose -f infra/compose.yaml up -d --wait
infra-down:
	docker compose -f infra/compose.yaml down
migrate:
	pnpm db:migrate
storage-init:
	pnpm storage:init
web:
	pnpm dev
workflows:
	$(RENDER) workflows dev --env-file .env.workflows.local -- pnpm --filter @stateaction/jobs dev
smoke:
	pnpm test:platform
