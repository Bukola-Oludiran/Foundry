.PHONY: install fmt fmt-check lint test test-local test-durable-restart check

install:
	npm ci --prefix pi-pool

fmt:
	cargo fmt --manifest-path gr-host/Cargo.toml --all
	npm run --prefix pi-pool format

fmt-check:
	cargo fmt --manifest-path gr-host/Cargo.toml --all -- --check
	npm run --prefix pi-pool format:check

lint:
	cargo clippy --manifest-path gr-host/Cargo.toml --workspace --all-targets -- -D warnings
	npm run --prefix pi-pool typecheck

test:
	cargo test --manifest-path gr-host/Cargo.toml --workspace
	npm test --prefix pi-pool

test-local:
	cargo test --manifest-path gr-host/Cargo.toml --workspace
	npm run --prefix pi-pool test:local

test-durable-restart:
	cargo build --manifest-path gr-host/Cargo.toml --locked
	npm run --prefix pi-pool validate:durable-restart

check: fmt-check lint test
