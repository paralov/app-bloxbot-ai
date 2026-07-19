# BloxBot build system
#
# Usage:
#   make build       Build the Electron installer
#   make dev         Run in development mode
#   make clean       Remove build artifacts
#   make check       Test + type-check + lint
#
# OpenCode is downloaded and verified by the app on first launch.

NODE_MODULES := node_modules/.pnpm

.PHONY: build dev clean nuke test check lint help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: $(NODE_MODULES) ## Build production app bundle
	pnpm package

dev: $(NODE_MODULES) ## Run in development mode
	pnpm dev

test: $(NODE_MODULES) ## Run frontend tests
	pnpm test

check: $(NODE_MODULES) ## Type-check + lint + test
	pnpm test
	pnpm typecheck
	pnpm lint

lint: $(NODE_MODULES) ## Lint frontend
	pnpm lint

clean: ## Remove build artifacts
	rm -rf dist dist-electron release

nuke: clean ## Remove build artifacts and installed dependencies
	rm -rf node_modules

$(NODE_MODULES): package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch $@
