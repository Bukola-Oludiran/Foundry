# Foundry operator runtime services

Protocol-v2 builds use two operator-owned services. They are separate from ordinary build jobs and
are the only containers allowed to receive the Docker socket.

## Build the locked images

Build from the repository root. Every `FROM` image is recorded by immutable digest in
`pi-pool/runtime/images/images.lock.json`.

```bash
docker build -f pi-pool/runtime/images/Dockerfile.environment-controller \
  -t foundry-environment-controller:local .
docker build -f pi-pool/runtime/images/Dockerfile.integration-emulator \
  -t foundry-integration-emulator:local .
docker build -f pi-pool/runtime/images/Dockerfile.project-runner \
  -t foundry-project-runner:local .
docker build -f pi-pool/runtime/images/Dockerfile.dependency-resolver \
  -t foundry-dependency-resolver:local .
```

Record each locally built image digest and use the digest-qualified value in Foundry configuration.
Do not use mutable tags in an accepted build plan.

## Dependency-resolver boundary

The bundled resolver is a fail-closed executor for an operator-vetted, immutable resolution
catalog. A catalog directory contains `index.json`, keyed by the exact accepted plan digest, and an
`artifacts/` directory containing the six content-addressed outputs referenced by each result:
native manifest and lockfile bundles, a read-only dependency layer, CycloneDX SBOM, license report,
and vulnerability report. Foundry independently binds the result to the plan, resolver image, and
platform, then verifies every artifact's type, size, and SHA-256 checksum before promotion.

Set `FOUNDRY_RESOLUTION_CATALOG_DIR` together with the normal OCI resolver settings. The worker
mounts the catalog read-only and its output artifact directory separately writable. A missing plan,
undeclared package, policy violation, checksum mismatch, malformed catalog, or artifact conflict
fails closed. Catalog generation is an operator supply-chain step; it must resolve through the
configured allowlisted registry proxy and must not place registry credentials in the catalog.

## Controller boundary

The environment controller creates one deterministic, internal Docker network per durable build,
starts only declared resource and emulator containers, publishes no host ports, and attaches exact
run, plan, environment, and component labels. Resource containers use a read-only root,
capability-drop, no-new-privileges, resource limits, and bounded tmpfs data volumes. Generated
credential values are passed only to their workload containers; the persistent controller state
contains logical secret handles but no values.

PostgreSQL migrations are read from the validated build workspace, ordered by filename, applied as
the container's unprivileged `postgres` user, and optionally applied a second time when the mandate
requires repeatability. Health, migration, snapshot, and teardown evidence is content-addressed.
Restarting the controller adopts the credential-free environment record. Teardown is idempotent and
checks that no labeled container remains.

After all node acceptance suites are green, the durable scheduler runs a separate evidence phase
before teardown. Each emulator reports only plan-bound operation identities, canonical request and
response hashes, bounded observation counts, and safe diagnostics. The controller also samples
bounded CPU, memory, and PID usage for every declared resource container. Missing expectations,
unexpected request shapes, response-hash drift, incomplete resource coverage, or unsafe evidence
fails the build. The verified result is committed as a GraphReact artifact and materialized with
the lifecycle record in `.foundry/resources/evidence.json`; credential values and raw provider
payloads are never included.

## Project-runner boundary

The project runner creates a fresh language-toolchain container for every test. The container has a
read-only root and job mount, dropped capabilities, no-new-privileges, PID/CPU/memory/time limits,
and either no network or the exact private environment network from the accepted request.
Dependency archives are checksum-verified, path-checked before extraction, rejected if they contain
links or oversized entries, and mounted read-only. The runner never mounts the Docker socket into a
test container.

Use `pi-pool/runtime/docker-compose.controller.yml` as an operator template. It intentionally
publishes no ports. Connect the worker through an operator-controlled internal network or local
proxy, and set:

- `FOUNDRY_ENVIRONMENT_MANAGER_URL` and `FOUNDRY_ENVIRONMENT_MANAGER_TOKEN`
- `FOUNDRY_PROJECT_RUNNER_URL` and `FOUNDRY_PROJECT_RUNNER_TOKEN`
- `FOUNDRY_RESOLVER_NETWORK`, `FOUNDRY_REGISTRY_PROXY_URL`,
  `FOUNDRY_DEPENDENCY_ARTIFACT_DIR`, and `FOUNDRY_RESOLUTION_CATALOG_DIR`
- `FOUNDRY_RESOURCE_IMAGES_JSON` and `FOUNDRY_EMULATOR_IMAGE`, all digest-qualified
- `FOUNDRY_DOCKER_GID`, workspace paths, state paths, and artifact paths

Tokens remain environment/workload secrets. Never place them in Compose files, image layers,
command-line arguments, architecture IR, or generated evidence.
