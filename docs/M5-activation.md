# Live provider activation

The thin vertical workflow can use a **real LLM** to write modules and **Piston** as its tester.
(The architecture-role agent — spec→IR — is a separate later piece; here we compile the
hand-authored `ir/examples/string-utils.ir.json`.)

Run these commands from the repository root unless noted otherwise.

Install the locked dependencies first:

```bash
npm ci --prefix pi-pool
```

## Configure Piston

```bash
export PISTON_DIR=/path/to/your/piston-checkout
docker compose -f "$PISTON_DIR/docker-compose.yml" up -d
curl -s -XPOST http://127.0.0.1:2000/api/v2/packages \
  -H 'content-type: application/json' -d '{"language":"python","version":"3.*"}'
curl -s http://127.0.0.1:2000/api/v2/runtimes    # confirm a python runtime is listed
```

## Configure a provider

```bash
npm install --prefix pi-pool
export ANTHROPIC_API_KEY=sk-ant-...                   # pi-ai auto-resolves it via getEnvApiKey
```

## Run the live build

```bash
# real doer (Claude) + Piston oracle — LLM/tester selected purely by env
FOUNDRY_LLM_PROVIDER=anthropic \
FOUNDRY_LLM_MODEL=<supported-model-id> \
FOUNDRY_TESTER=piston \
PORT=8811 node pi-pool/src/server.ts &                # logs: LLM=anthropic/…, tester=piston

cargo build --manifest-path gr-host/Cargo.toml
./gr-host/target/debug/foundry-host \
  --ir ./ir/examples/string-utils.ir.json \
  --pi-pool http://127.0.0.1:8811 \
  --workspace /tmp/foundry-live
```

Expected: a real LLM writes `lowercase/trim/hyphenate/slugify` from their contracts, Piston verifies
each dyad, and the host reports **ALL GREEN** bottom-up. On macOS, writes are Seatbelt-scoped. The
current `--rearchitect` option demonstrates invalidation by rebuilding the existing IR; genuine IR
revision is tracked separately in [`roadmap.md`](roadmap.md).

## What the env switches map to
- `FOUNDRY_LLM_PROVIDER` + `FOUNDRY_LLM_MODEL` → `PiAiLlm` (`src/llm.ts`); unset → stub.
- `FOUNDRY_TESTER=piston` + `PISTON_URL` (default `http://127.0.0.1:2000`) → Piston executor
  (`src/tester.ts`); unset → local python3.
- No code changes needed — both are drop-ins already in place.
