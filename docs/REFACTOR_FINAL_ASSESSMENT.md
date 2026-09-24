# Message Box Store refactor: final assessment

Assessment for `mbs-8g5.12` on 2026-09-25. This compares the independent Store package with the `ReferenceRepos/ts-stack` source snapshots of Message Box Server 1.1.42 and Message Box Client 2.5.1. It does not inspect any application consumer. The Store checkout contains uncommitted work, so these figures describe the current working tree, not a published release.

## Measured source and artifact

`node scripts/source-loc.mjs` counts nonblank authored `src` lines, including comments, excluding declarations, generated output, and four test-only fixture files. The frozen per-file baseline is [REFACTOR_LOC_BASELINE.json](REFACTOR_LOC_BASELINE.json).

| Measure | Baseline | Current | Change |
| --- | ---: | ---: | ---: |
| Store production source | 11,696 | 11,377 | -319 (-2.7%) |
| Store gross `src`, including fixtures | 12,145 | 11,826 | -319 |
| Test-only fixtures | 449 | 449 | 0 |
| Pack entries | 100 | 74 | -26 |
| Pack compressed bytes | 403,541 | 330,142 | -73,399 |
| Pack unpacked bytes | 1,598,219 | 1,312,305 | -285,914 |

The pack baseline is `.local/pack-before.json`; current figures are from `npm pack --dry-run --json --ignore-scripts` after rebuilding the current tree, using the local npm cache. Packing savings are **not** source LOC savings. Store production source now consists of 26 files:

| Responsibility and files | Current nonblank lines | Share |
| --- | ---: | ---: |
| HTTP service, policy and lifecycle: `service.ts` | 2,885 | 25.4% |
| Memory, SQLite, MySQL and shared repository contract | 3,366 | 29.6% |
| MySQL and SQLite migrations and schema verification | 711 | 6.3% |
| Protocol, canonicalization, feeds and snapshots | 2,076 | 18.2% |
| Client integration, replica, transport, recovery and public facades | 2,339 | 20.6% |
| **Total** | **11,377** | **100%** |

The repository row is `repository.mjs` (884), `repository.sqlite.mjs` (1,109), `repository.mysql.mjs` (1,169), and `repository-contract.mjs` (204). The service, repositories and migrations alone total **6,962 lines**. The largest single module is still `service.ts`; the refactor reduced it by 156 lines, but did not make it small.

## What the sister comparison does and does not explain

The same nonblank-source rule yields **6,049** lines in Server (45 files) and **5,257** in Client (9 files). Store is therefore 1.88 times Server and 2.16 times Client. These are separate products, not alternative implementations of the same API.

Server provides authenticated message delivery, permissions, payment/replay controls, HTTP/WebSocket routes and notifications. It has a Knex-backed message database and migrations; it does **not** implement Store's durable cross-device history, signed fixed-watermark change feeds, snapshots, deletion receipts, offline replica recovery, or memory/SQLite/MySQL parity. Its host-provided Knex handle is an injection boundary, not tested arbitrary-dialect support. Client owns transport, encryption, message listing and payments; it does **not** own a durable history server or SQL adapters. Its `MessageBoxClient.ts` alone contains 3,036 nonblank lines, so large modules are not unique to Store.

Store combines a service, browser/client integration, protocol, durable recovery and three repositories. The extra responsibilities explain where much of the difference arises. They do **not** prove that every Store line is necessary or that a 2x ratio is an acceptable efficiency target. Earlier passes removed the demonstrated feed, archive, config, validation and guard duplication; the measured result is only a 2.7% production reduction. We should not describe that as a major size transformation.

The nonblank metric includes documentation. A simple prefix count finds 1,547 comment-prefixed lines in Store production source, versus 967 in Server and 1,395 in Client. The crude non-comment proxy is 9,830, 5,082 and 3,862 lines respectively; it still shows a substantial difference. Prefix counting is not a parser and misses inline comments. Deleting historical comments could move the LOC metric without simplifying behavior, so it is not counted as an architectural saving.

## Final lifecycle task

The remaining `mbs-8g5.12.2.4` asks whether cleanup and shutdown share state plumbing that can be simplified. A second inspection found no worthwhile behavior-preserving net-LOC extraction:

- `createCleanupScheduler` owns an injectable timer, a single in-flight cleanup pass, rescheduling, outcome isolation and bounded cancellation. Its `stop` returns cancellation and drain facts.
- `createAdmissionTracker` owns an active-request count, admission/drain state and multiple idle waiters. `waitIdle` uses process timers and removes each waiter on resolution or timeout.
- `performStop` orders admission drain, cleanup stop, request drain, HTTP socket close and optional owned-pool destruction. The close timer protects a different resource from the cleanup timer.

Only a small timeout/wait pattern looks superficially alike. Sharing it would require timer and cancellation options plus different return shapes, adding indirection around safety-critical ordering for no demonstrated net source saving. The previous agent reached the same conclusion independently. No lifecycle code was changed for this task; closing it means **investigated, no safe reduction found**, not that lifecycle code is theoretically optimal.

## Residual opportunities and limits

The largest possible future reduction is in the 3,366 repository lines, but the existing shared feed/archive policy has already removed the direct duplication. Further consolidation would need a prototype of a storage-neutral mutation algorithm and adapter-owned lock/transaction hooks. MySQL deadlock retry and `FOR UPDATE`, SQLite `BEGIN IMMEDIATE`, timestamp conversion, migration verification and deletion fences cannot be silently normalized. There is no defensible 500-line net-saving estimate without that prototype and full concurrency proof.

Service route composition could also be revisited, but the completed guard/validation refactor removed the verified repeated paths. A file split or more generic middleware would not itself reduce source. A public API contraction could remove capability and would require a separate versioned compatibility decision. Database openness remains the `HistoryRepository` contract plus three supported adapters; promising arbitrary Knex dialects would be unsupported.

## Evidence and disposition

The latest existing full dedicated-MySQL receipt, `.local/validation-refactor-archive-full-mysql.log`, postdates the last repository source edits and reports **346 passed, 0 failed, 0 skipped**. The service tranche receipt also reports 346/346 and M2 focused tests. For this final assessment, `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run test:pack` all passed on the current tree; the package check covered artifact inventory, dependency closure and ESM/CJS/browser/declaration consumers. This assessment changes documentation and Bead status only; it does not rerun the expensive MySQL suite. These receipts are not an independent security review or publication approval.

Close `.2.4` as investigated with no safe net saving, then close the service `.2` and overall `.12` coordination epics: their aggregate measured source reduction and recorded gates pass. The result remains a large package. Any further size campaign should begin with a concrete cross-adapter design and a measured prototype, not a promise that sister-package parity is possible.
