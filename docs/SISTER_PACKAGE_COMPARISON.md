# Message Box package responsibility comparison

Source comparison for `mbs-8g5.12.5` (2026-09-24). This treats Store as an independent package. No application consumer was inspected. Server and Client source comes from the `ReferenceRepos/ts-stack` snapshot. Client 2.5.1 also has installed built artifacts in Store's `node_modules`; Server's reference checkout is unbuilt. No disposable Server build was needed.

| Package | Source entry points and responsibility | Nonblank authored source lines |
| --- | --- | ---: |
| Store | [`mod.ts`](../mod.ts), [`src/server.ts`](../src/server.ts), [`src/storage.ts`](../src/storage.ts), [`src/client.ts`](../src/client.ts): durable history protocol, transport, retention and recovery, plus memory/SQLite/MySQL adapters | 12,145 gross; 11,696 production, excluding 449 fixture lines |
| Server 1.1.42 | `ReferenceRepos/ts-stack/infra/message-box-server/src/compose.ts` and `src/index.ts`: authenticated message delivery, permissions, WebSocket and HTTP routes; `src/context.ts` takes a host-provided Knex instance | 6,049 |
| Client 2.5.1 | `ReferenceRepos/ts-stack/packages/messaging/message-box-client/mod.ts` and `src/MessageBoxClient.ts`: authenticated/encrypted messaging, payments and message transport, with peer-payment/token helpers | 5,257 |

Counting rule: recursively count authored `src/*.{js,mjs,cjs,ts,mts,cts}` with `trim().length > 0`, excluding declarations and test files for Server/Client; Store's canonical `scripts/source-loc.mjs` identifies four test-only fixtures separately. Reproduce Store's exact per-file count with `node scripts/source-loc.mjs`. To reproduce sister counts, run this from `E:/mapApp/ReferenceRepos/ts-stack` (Node 22 or later):

```powershell
node -e "const fs=require('node:fs'),p=require('node:path');for(const root of ['infra/message-box-server/src','packages/messaging/message-box-client/src']){let files=0,lines=0;function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory()){if(e.name!=='__tests__')walk(f)}else if(/\.(?:js|mjs|cjs|ts|mts|cts)$/.test(e.name)&&!/(?:\.test|\.spec|\.d)\.[cm]?[jt]s$/.test(e.name)){files++;lines+=fs.readFileSync(f,'utf8').split(/\r?\n/).filter(x=>x.trim()).length}}}walk(root);console.log(root,files,lines)}"
```

These are responsibility-adjusted comparisons, not a target ratio. Server does not implement an offline history replica, signed fixed-watermark feeds, snapshot recovery, or three Store repositories. Client performs transport and encryption, not durable SQL history. Store's three repositories alone contain 3,404 production nonblank lines at baseline. Server's host-provided Knex interface is evidence of dependency injection, not proof that Store can claim arbitrary SQL dialect support; Server's own migrations and query behavior must be assessed separately.

The clearest source reduction candidate is duplicated feed preparation across the three Store adapters. The same cursor/checkpoint choice, watermark and retention checks appear in each, while `src/feeds.mjs` already contains shared page assembly. Extracting pure policy should reduce repeated code without moving SQL selection, locks, or deletion fences. The next candidate is repeated service defaults and predicates. Package inventory trimming reduces tarball size but does not count toward source LOC reduction. A file split alone does not reduce source LOC.

The installed Client's `node_modules/@bsv/message-box-client/dist` confirms its published ESM/CJS/type entry points declared in its package manifest; the source snapshot, rather than minified/generated artifacts, is the basis for responsibility and LOC comparison. Server has only source and an unbuilt `out` target in its manifest, so no like-for-like installed Server artifact comparison is claimed.
