# M5 — live activation (one page)

Everything is pre-wired. Going live = supplying your key and running one command. The doer
becomes a **real LLM** writing the modules; the tester becomes **Piston**.
(The architecture-role agent — spec→IR — is a separate later piece; here we compile the
hand-authored `ir/examples/string-utils.ir.json`.)

Run these commands from the repository root unless noted otherwise.

## Switch 1 — Piston

```bash
docker compose -f deploy/piston/compose.yaml up -d
curl -s http://127.0.0.1:2000/api/v2/runtimes
```

The repository deployment builds Piston for the Docker host's native architecture and registers
the image's system Python. This avoids amd64 `isolate`/runtime failures on Apple Silicon.

## Switch 2 — a provider + key

```bash
# Put ANTHROPIC_API_KEY in the gitignored .env (created from .env.example).
```

The maintained `@earendil-works/pi-ai` provider adapter is already installed in `pi-pool`.

## Run the live build

```bash
# real doer (Claude) + Piston oracle — LLM/tester selected purely by env
FOUNDRY_LLM_PROVIDER=anthropic \
FOUNDRY_LLM_MODEL=claude-sonnet-4-6 \                  # any valid getModel('anthropic', <id>) id
FOUNDRY_TESTER=piston \
PORT=8811 node pi-pool/src/server.ts &                # logs: LLM=anthropic/…, tester=piston

cargo build --manifest-path gr-host/Cargo.toml
./gr-host/target/debug/foundry-host \
  --ir ./ir/examples/string-utils.ir.json \
  --pi-pool http://127.0.0.1:8811 \
  --workspace /tmp/foundry-live
```

Expected: a real LLM writes `lowercase/trim/hyphenate/slugify` from their contracts, Piston verifies
each dyad, and the host reports **ALL GREEN** in observed dependency order. Add
`--rearchitect hyphenate` to watch the current manual scoped rebuild. M4 will replace that flag's
behavior with generation and activation of a validated replacement subtree IR.

## What the env switches map to
- `FOUNDRY_LLM_PROVIDER` + `FOUNDRY_LLM_MODEL` → `PiAiLlm` (`src/llm.ts`); unset → stub.
- `FOUNDRY_TESTER=piston` + `PISTON_URL` (default `http://127.0.0.1:2000`) → Piston executor
  (`src/tester.ts`); unset → local python3.
- No code changes needed — both are drop-ins already in place.
