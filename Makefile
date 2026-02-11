# ── BloxBot Build System ─────────────────────────────────────────────────
#
# Usage:
#   make build       Build production DMG (macOS) — downloads deps if needed
#   make dev         Run in development mode
#   make clean       Remove build artifacts
#   make deps        Download Node.js + OpenCode sidecar
#   make check       Type-check + lint + cargo check
#
# Prerequisites: Rust, pnpm, curl, unzip

SHELL := /bin/bash

# ── Versions ─────────────────────────────────────────────────────────────
NODE_VERSION   := 22.13.1
OPENCODE_VERSION := 1.1.53

# ── Platform detection ───────────────────────────────────────────────────
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Darwin)
  ifeq ($(UNAME_M),arm64)
    TARGET       := aarch64-apple-darwin
    NODE_ASSET   := node-v$(NODE_VERSION)-darwin-arm64.tar.gz
    NODE_DIR     := node-v$(NODE_VERSION)-darwin-arm64
    OC_ASSET     := opencode-darwin-arm64.zip
    OC_BIN       := opencode
  else
    TARGET       := x86_64-apple-darwin
    NODE_ASSET   := node-v$(NODE_VERSION)-darwin-x64.tar.gz
    NODE_DIR     := node-v$(NODE_VERSION)-darwin-x64
    OC_ASSET     := opencode-darwin-x64.zip
    OC_BIN       := opencode
  endif
else ifeq ($(UNAME_S),Linux)
  TARGET       := x86_64-unknown-linux-gnu
  NODE_ASSET   := node-v$(NODE_VERSION)-linux-x64.tar.gz
  NODE_DIR     := node-v$(NODE_VERSION)-linux-x64
  OC_ASSET     := opencode-linux-x64.zip
  OC_BIN       := opencode
endif

MCP_SERVER_REPO := boshyxd/robloxstudio-mcp
MCP_SERVER_VERSION := v1.9.0

# ── Paths ────────────────────────────────────────────────────────────────
NODEJS_BIN     := src-tauri/resources/nodejs/bin/node
OPENCODE_BIN   := src-tauri/binaries/opencode-$(TARGET)
MCP_SERVER_DIR := src-tauri/resources/mcp-server/dist/index.js
NODE_MODULES   := node_modules/.pnpm

# ── Default target ───────────────────────────────────────────────────────
.PHONY: build dev clean deps check lint help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: deps $(NODE_MODULES) ## Build production app bundle
	pnpm tauri build

dev: deps $(NODE_MODULES) ## Run in development mode
	pnpm tauri dev

check: $(NODE_MODULES) ## Type-check + lint + cargo check
	pnpm tsc --noEmit
	pnpm lint
	cd src-tauri && cargo check

lint: $(NODE_MODULES) ## Lint frontend + Rust
	pnpm lint
	cd src-tauri && cargo clippy
	cd src-tauri && cargo fmt --check

clean: ## Remove build artifacts (keeps downloaded deps)
	rm -rf dist
	cd src-tauri && cargo clean

nuke: clean ## Remove everything including downloaded deps
	rm -rf src-tauri/resources/nodejs
	rm -rf src-tauri/resources/mcp-server
	rm -f src-tauri/binaries/opencode-*
	rm -rf node_modules

deps: $(NODEJS_BIN) $(OPENCODE_BIN) $(MCP_SERVER_DIR) ## Download Node.js + OpenCode sidecar + build MCP server

# ── Frontend deps ────────────────────────────────────────────────────────

$(NODE_MODULES): package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch $@

# ── Node.js runtime ─────────────────────────────────────────────────────

$(NODEJS_BIN):
	@echo "⬇ Downloading Node.js v$(NODE_VERSION)..."
	@mkdir -p /tmp/bloxbot-deps
	curl -fSL --retry 3 \
		"https://nodejs.org/dist/v$(NODE_VERSION)/$(NODE_ASSET)" \
		-o "/tmp/bloxbot-deps/$(NODE_ASSET)"
	@echo "📦 Extracting Node.js to src-tauri/resources/nodejs..."
	cd /tmp/bloxbot-deps && tar -xzf "$(NODE_ASSET)"
	mkdir -p src-tauri/resources/nodejs/bin
	cp "/tmp/bloxbot-deps/$(NODE_DIR)/bin/node" src-tauri/resources/nodejs/bin/
	mkdir -p src-tauri/resources/nodejs/lib/node_modules
	cp -R "/tmp/bloxbot-deps/$(NODE_DIR)/lib/node_modules/npm" src-tauri/resources/nodejs/lib/node_modules/
	# Create shell wrapper scripts (not symlinks — Tauri flattens symlinks)
	printf '#!/bin/sh\nbasedir=$$(dirname "$$(realpath "$$0")")\nexec "$$basedir/node" "$$basedir/../lib/node_modules/npm/bin/npm-cli.js" "$$@"\n' > src-tauri/resources/nodejs/bin/npm
	printf '#!/bin/sh\nbasedir=$$(dirname "$$(realpath "$$0")")\nexec "$$basedir/node" "$$basedir/../lib/node_modules/npm/bin/npx-cli.js" "$$@"\n' > src-tauri/resources/nodejs/bin/npx
	chmod +x src-tauri/resources/nodejs/bin/npm src-tauri/resources/nodejs/bin/npx
	rm -rf /tmp/bloxbot-deps
	@echo "✓ Node.js ready"

# ── OpenCode sidecar ────────────────────────────────────────────────────

$(OPENCODE_BIN):
	@echo "⬇ Downloading OpenCode v$(OPENCODE_VERSION)..."
	@mkdir -p src-tauri/binaries /tmp/bloxbot-deps
	curl -fSL --retry 3 \
		"https://github.com/anomalyco/opencode/releases/download/v$(OPENCODE_VERSION)/$(OC_ASSET)" \
		-o "/tmp/bloxbot-deps/$(OC_ASSET)"
	@echo "📦 Extracting OpenCode sidecar..."
	cd /tmp/bloxbot-deps && unzip -o "$(OC_ASSET)"
	mv "/tmp/bloxbot-deps/$(OC_BIN)" "$(OPENCODE_BIN)"
	chmod +x "$(OPENCODE_BIN)"
	rm -rf /tmp/bloxbot-deps
	@echo "✓ OpenCode sidecar ready"

# ── MCP server ──────────────────────────────────────────────────────────

$(MCP_SERVER_DIR):
	@echo "⬇ Cloning robloxstudio-mcp $(MCP_SERVER_VERSION)..."
	@rm -rf /tmp/bloxbot-mcp
	git clone --depth 1 --branch "$(MCP_SERVER_VERSION)" \
		"https://github.com/$(MCP_SERVER_REPO).git" /tmp/bloxbot-mcp
	cd /tmp/bloxbot-mcp && npm install && npm run build
	@echo "📦 Bundling MCP server into resources..."
	mkdir -p src-tauri/resources/mcp-server
	cp -R /tmp/bloxbot-mcp/dist src-tauri/resources/mcp-server/
	cp /tmp/bloxbot-mcp/package.json src-tauri/resources/mcp-server/
	cd src-tauri/resources/mcp-server && npm install --omit=dev --no-package-lock
	rm -rf /tmp/bloxbot-mcp
	@echo "✓ MCP server ready"
