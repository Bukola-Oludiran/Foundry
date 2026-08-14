# Local Piston

Piston needs a privileged container and a Linux-native package filesystem. The named volume in
`compose.yaml` avoids timestamp/permission failures seen with bind mounts under macOS/Colima.
The API is bound to loopback only. The compose file builds Piston for the Docker host's native
architecture because the published amd64 image's `isolate` binary cannot create namespaces while
running through arm64 emulation. The same is true of published language packages, so the
`runtime-init` service registers the image's native Debian Bookworm Python 3.11 runtime. Existing
runtime directories are preserved; Foundry selects the highest installed version satisfying the
delivery contract.

The local API raises Piston's run wall-time and CPU-time ceilings to 180 seconds so the bounded
Python delivery gate can build a wheel and create a clean virtual environment. Foundry still sends
an explicit timeout and a 512 MB memory cap for every assembly run. Its stdout/stderr ceiling is
16 MiB so the bounded terminal envelope can carry compiler-authorized binary artifacts as base64. Foundry still enforces per-artifact, aggregate, media-type, and declared-ID caps.

```bash
colima start --profile foundry-runtime --cpu 2 --memory 4 --disk 16 --runtime docker
docker context use colima-foundry-runtime
docker build -f deploy/piston/Dockerfile -t foundry-piston:local .
docker compose -f deploy/piston/compose.yaml up -d --no-build
curl -s http://127.0.0.1:2000/api/v2/runtimes
```

Build the image once and use `--no-build` when starting Compose. This avoids two concurrent exports of the same mixed-toolchain image and limits sparse-disk growth.

Install Python once:

```bash
curl -sS --max-time 300 -X POST http://127.0.0.1:2000/api/v2/packages \
  -H 'content-type: application/json' \
  -d '{"language":"python","version":"3.*"}'
```

Recursive IR v5 additionally requires the pinned `foundry-product` mixed-toolchain runtime and is
fail-closed until it appears in `/api/v2/runtimes`. Its wire contract and certification status are
documented in [`../../docs/product-runtime-protocol.md`](../../docs/product-runtime-protocol.md).

Stop the service without deleting the installed runtime:

```bash
docker compose -f deploy/piston/compose.yaml down
```
