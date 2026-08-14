# PCBPnR recursive-product readiness exercise

Status: architecture-only, non-gating. No code-delivery certification is claimed.

This exercise applies IR v5 composition to the proposed Electrobun desktop product without
pretending that existing Node capabilities can verify desktop behavior.

```text
pcbpnr
├── desktop-shell
│   ├── application-window
│   ├── command-and-menu-surface
│   ├── project-lifecycle
│   └── update-coordinator
├── frontend
│   ├── board-workspace
│   │   ├── viewport
│   │   ├── selection-and-tools
│   │   └── overlays
│   ├── placement-workflow
│   ├── routing-workflow
│   ├── library-browser
│   └── diagnostics-and-history
├── product-domain
│   ├── board-model
│   ├── component-and-footprint-model
│   ├── placement-engine
│   ├── routing-and-clearance-engine
│   ├── command-history
│   └── project-serialization
├── native-sidecar
│   ├── geometry-kernel
│   ├── import-export
│   ├── filesystem-boundary
│   └── background-job-runtime
├── persistence
│   ├── project-store
│   ├── preferences
│   └── recovery-and-migrations
└── distribution
    ├── windows-package
    ├── code-signing
    ├── update-channel
    └── release-manifest
```

Each composite would own an immediate-child DAG and typed integration scenarios. The root scenarios
must cover opening and migrating a project, editing a board through the renderer-to-sidecar
contract, undo/redo, crash recovery, deterministic export, packaged Windows startup, and a signed
update. The frontend may depend only on product-domain and shell public contracts; it may not read
native-sidecar internals. Distribution consumes accepted artifacts rather than source directories.

## Structured capability gaps

| Required capability | Why existing capabilities are insufficient | Certification required |
| --- | --- | --- |
| `bun-package` | `typescript-package` uses pinned Node/npm/TypeScript and cannot establish Bun runtime or lockfile semantics. | Offline Bun runtime, lockfile verification, tests, mutation, packaging, reproducibility. |
| `electrobun-desktop` | `node-service` cannot prove Electrobun process topology, RPC, window lifecycle, or packaged execution. | Pinned Electrobun toolchain, shell/RPC integration, clean packaged launch. |
| `browser-webview-ui` | A TypeScript compile does not prove browser rendering, interaction, accessibility, or webview isolation. | Deterministic browser/webview automation, visual and interaction evidence, CSP/isolation tests. |
| `windows-desktop-package` | Artifact bundles do not produce or install signed Windows applications. | Windows worker, installer lifecycle, signing provenance, uninstall/upgrade/recovery tests. |
| `gui-automation` | HTTP/process contracts cannot interact with native menus, dialogs, drag/drop, keyboard, or accessibility trees. | Sandboxed desktop automation with deterministic screenshots and semantic assertions. |
| `native-sidecar` | `rust-binary` alone does not prove desktop IPC, lifecycle supervision, artifact co-packaging, or crash recovery. | Mixed Electrobun/Rust runtime, typed IPC, termination and restart tests. |
| `desktop-update-system` | A release manifest does not prove signing, channel selection, rollback, partial-download recovery, or stale-update rejection. | Signed update fixture, prior-release upgrade, rollback, offline and corrupted-update tests. |

These gaps are compiler-visible missing capabilities. Foundry must reject a PCBPnR code-delivery
architecture that references them until each definition and its Piston/worker certification exists.
Using `node-service`, `typescript-package`, or `artifact-bundle` as an approximation would be a
false-green risk.
