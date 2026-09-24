# Public package paths

Classification for `mbs-8g5.12.4.1`, based on the current export map. Paths stay stable in this refactor. Message Box Client publishes one built ESM/CJS/type root, while Message Box Server publishes built ESM root and server paths. Store additionally exposes raw internal modules; these have a narrower contract than its built entries.

| Path | Current contract | Environment |
| --- | --- | --- |
| `.` / `./client` / `./protocol` / `./canonical` | Built ESM, CommonJS, and declarations; `browser` condition | Browser and Node |
| `./server` / `./storage` | Built ESM, CommonJS, and declarations | Node server only |
| `./repository` | Raw `.mjs`; ESM only, no dedicated declarations or CJS target | Node server only; memory repository with optional SQLite factory |
| `./repository.sqlite` | Raw `.mjs`; ESM only, no dedicated declarations or CJS target | Node 22+ with `node:sqlite` |
| `./repository.mysql` | Raw `.mjs`; ESM only, no dedicated declarations or CJS target | Node with optional `knex` and `mysql2` peers |
| `./snapshots` / `./feeds` / `./migrations` | Raw `.mjs`; ESM only, no dedicated declarations or CJS target | Node server only |

`./storage` defines the typed `HistoryRepository` behavior surface, but is not a declaration for each raw factory. Consumers who require those factories use the documented ESM imports and can type their resulting repository against `HistoryRepository`. A clean consumer check must prove all six raw paths import from the packed artifact and that CommonJS resolution is *not* advertised for them. Built browser paths must not load SQL peers. No new declaration entry or export migration is implied by this classification; turning raw paths into typed dual-format entries would require a versioned design and more source/artifact code, which is outside this reduction tranche.
