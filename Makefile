.PHONY: install fmt fmt-check lint test test-local test-durable-restart test-live-polyglot check

install:
	npm ci
	npm ci --prefix pi-pool

fmt:
	cargo fmt --manifest-path gr-host/Cargo.toml --all
	npm run --prefix pi-pool format

fmt-check:
	cargo fmt --manifest-path gr-host/Cargo.toml --all -- --check
	npm run --prefix pi-pool format:check

lint:
	cargo clippy --manifest-path gr-host/Cargo.toml --workspace --all-targets -- -D warnings
	npm run typecheck
	npm run --prefix pi-pool typecheck

test:
	cargo build --manifest-path gr-host/Cargo.toml --locked
	cargo test --manifest-path gr-host/Cargo.toml --workspace
	npm run test:mcp
	npm run test:sidecar
	npm run test:collaboration
	npm test --prefix pi-pool

test-local:
	cargo test --manifest-path gr-host/Cargo.toml --workspace
	npm run --prefix pi-pool test:local

test-durable-restart:
	cargo build --manifest-path gr-host/Cargo.toml --locked
	npm run --prefix pi-pool validate:durable-restart

test-live-polyglot:
	npm run --prefix pi-pool validate:live-polyglot

check: fmt-check lint test
