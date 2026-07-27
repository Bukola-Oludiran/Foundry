# M5 — live activation (one page)

Everything is pre-wired. Going live = flipping your two switches + one `npm install`, then one
command. The doer becomes a **real LLM** writing the modules; the tester becomes **Piston**.
(The architecture-role agent — spec→IR — is a separate later piece; here we compile the
hand-authored `ir/examples/string-utils.ir.json`.)

## Switch 1 — Piston (needs Colima healthy)

```bash
colima restart                         # clears the unpigz VM fault + the unhealthy provium-dev stack
cd ~/jays-workspace/piston && docker compose up -d
curl -s -XPOST http://127.0.0.1:2000/api/v2/packages \
  -H 'content-type: application/json' -d '{"language":"python","version":"3.*"}'
curl -s http://127.0.0.1:2000/api/v2/runtimes    # confirm a python runtime is listed
```

## Switch 2 — a provider + key, and make pi-ai resolvable

```bash
cd ~/jays-workspace/Foundry/pi-pool
npm install ../../DextersLab/pi-mono/packages/ai      # or: npm i @mariozechner/pi-ai
#   pi-ai must be built (dist/ present) — run `npm run build` in pi-mono/packages/ai if needed
export ANTHROPIC_API_KEY=sk-ant-...                   # pi-ai auto-resolves it via getEnvApiKey
```

## Run the live build

```bash
# real doer (Claude) + Piston oracle — LLM/tester selected purely by env
FOUNDRY_LLM_PROVIDER=anthropic \
FOUNDRY_LLM_MODEL=claude-sonnet-4-20250514 \          # any valid getModel('anthropic', <id>) id
FOUNDRY_TESTER=piston \
PORT=8811 node src/server.ts &                        # logs: LLM=anthropic/…, tester=piston

~/jays-workspace/Foundry/gr-host/target/debug/foundry-host \
  --ir ~/jays-workspace/Foundry/ir/examples/string-utils.ir.json \
  --pi-pool http://127.0.0.1:8811 \
  --workspace /tmp/foundry-live
```

Expected: a real LLM writes `lowercase/trim/hyphenate/slugify` from their contracts (Seatbelt-
scoped), Piston verifies each dyad, and the host reports **ALL GREEN** bottom-up — with any
red draft self-healing via retry-with-feedback. Add `--rearchitect hyphenate` to watch a scoped
re-architecture on the live build.

## What the env switches map to
- `FOUNDRY_LLM_PROVIDER` + `FOUNDRY_LLM_MODEL` → `PiAiLlm` (`src/llm.ts`); unset → stub.
- `FOUNDRY_TESTER=piston` + `PISTON_URL` (default `http://127.0.0.1:2000`) → Piston executor
  (`src/tester.ts`); unset → local python3.
- No code changes needed — both are drop-ins already in place.
