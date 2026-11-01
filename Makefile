SHELL := /bin/bash
RENDER ?= $(CURDIR)/artifacts/platform-tools/render/render
.PHONY: install check build typecheck syntax test format affected graph infra-up infra-down migrate storage-init web workflows worker-check smoke render-cli
install:
	pnpm install --frozen-lockfile
	uv sync --project workers/processing --locked
check:
	pnpm check
build:
	pnpm build
typecheck:
	pnpm typecheck
syntax:
	pnpm syntax
test:
	pnpm test
format:
	pnpm format:check
affected:
	pnpm affected
graph:
	pnpm graph
worker-check:
	pnpm exec nx run-many --projects=processing --targets=build,typecheck,test,format
render-cli:
	python3 scripts/platform/install-render.py
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
