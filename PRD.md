# Product Requirements Document: message-box-store

- **Status:** Foundational planning
- **Date:** 2026-09-18
- **Product:** `message-box-store`
- **Audience:** implementers, package maintainers, service operators, and
  applications using `@bsv/message-box-client`
- **Related decision:** [ADR-001](./ADR-001-durable-history.md)

## 1. Summary

`message-box-store` is a modular encrypted message-history package and
optional service. It gives a user who controls one BSV wallet identity a
durable, authenticated history that can be retrieved on multiple devices.
Each device downloads the same encrypted records and decrypts them locally.

The product complements, and does not replace, Message Box:

- Message Box remains the temporary authenticated delivery queue.
- `message-box-store` becomes the independently retained encrypted history.
- The wallet remains the identity, signing, and decryption authority.
- The application remains responsible for plaintext rendering, conversations,
  local cache, and user experience.

The first release is a standalone TypeScript project that can be copied out of
any consumer application, published as an npm package, or embedded beside an
unmodified Message Box Server. It has no consumer-application runtime dependency.

Normative v1 semantics are defined in the ADR; these are proposed contracts,
not shipped capabilities. The existing client decrypts receive results and
prepares ciphertext privately. M0 MUST prove raw-envelope/prepared-send
integration before claiming drop-in compatibility.

## 2. Problem and opportunity

The current Message Box flow is safe for asynchronous delivery but surprising
for social messaging: after a client durably handles a message and calls
`acknowledgeMessage`, the server deletes it. A browser cache clear or device
loss then removes the only application-level history. A second device with the
same identity does not see the already acknowledged envelope.

The current client also has no server-backed sent-items archive. Message Box
stores recipient queues, so a sender cannot reconstruct its own outgoing
history from that service.

We need a product-level archive with explicit resource limits, robust retry and
dedupe, and an honest privacy boundary. It must be useful to social apps while
remaining appropriate for other applications that use Message Box for payments
or protocol requests.

## 3. Goals

### Product goals

1. Preserve encrypted inbound history before Message Box acknowledgement.
2. Preserve encrypted outbound history through an explicit send integration.
3. Let two or more devices with the same wallet identity retrieve a consistent
   set of records and decrypt them locally.
4. Make retries, duplicate hosts, concurrent devices, partial pages, and crash
   windows safe and observable.
5. Bound per-identity and global storage/resource consumption.
6. Be easy to embed with familiar `@bsv/message-box-client` and ts-stack
   conventions while remaining an independent package.
7. Provide a path for encrypted backups and tested restore operations.

### Engineering goals

1. Keep server code unable to decrypt supported message bodies.
2. Use standard BRC-103 identity authentication and BRC-100 wallet interfaces
   instead of inventing a second key or session protocol.
3. Prefer a relational repository with atomic quota accounting and cursor
   indexes, while isolating persistence behind an adapter.
4. Publish browser-safe and server-specific exports separately.
5. Define conformance evidence before declaring the package stable.

## 4. Non-goals

- Changing or forking Message Box Server's transport routes or acknowledgement
  semantics.
- Recovering plaintext after wallet private-key loss.
- Server-side plaintext search, indexing, moderation, or AI processing.
- Defining a universal social conversation/thread/read-state protocol in v1.
- Replacing wallet storage, wallet backup, or blockchain transaction history.
- Guaranteeing exactly-once delivery on an unreliable network.
- Storing arbitrary unbounded files or attachments in the message record path.
- Treating a local browser cache as a sufficient remote backup.

## 5. Users and usage modes

### Social application user

Uses a private inbox on a browser and phone. Expects acknowledged messages and
sent items to survive cache/device loss. Wants no server plaintext access.

### Protocol application

Uses Message Box for payment requests, token settlement, notifications, or
other queues. May opt out of history archival or choose a short retention
policy. Must not be forced to treat every queue item as a social conversation.

### Application integrator

Uses the existing `MessageBoxClient` and wallet. Wants a small adapter,
deterministic retries, typed limits, and no direct database coupling.

### Service operator

Deploys a standalone history service or embeds its routes in an existing
Express process. Needs quotas, health/readiness, migrations, backups, metrics,
and safe degradation when a dependency fails.

### Library maintainer

Publishes a package with stable exports, browser-compatible client code,
server subpaths, declarations, release notes, and no consumer-specific imports.

## 6. User journeys

### Receive and acknowledge safely

1. Device A polls or receives a live Message Box envelope.
2. The archive worker validates the envelope and submits its opaque body and
   immutable metadata to the store.
3. The store commits or idempotently confirms the record.
4. Device A decrypts locally and writes its local cache/index.
5. Only then does Device A acknowledge the Message Box message.
6. Device B authenticates with the same identity, syncs the durable record, and
   decrypts with its wallet.

If step 2 or 3 fails, the Message Box message remains pending. If the process
crashes between steps 3 and 5, a retry sees `alreadyPresent` and can safely
acknowledge. If it crashes before step 3, the transport message is still
available.

### Send and preserve sent history

1. The client builds the final per-recipient encrypted envelope and stable
   `messageId` using the normal Message Box client.
2. The archive worker writes an outbound record with state `prepared`.
3. The client sends through Message Box.
4. On success, the worker marks the same immutable record `accepted`; on a
   clear failure it may mark `failed`, retaining the record for user-visible
   retry or cleanup.
5. Another device retrieves the outbound record through the same history API.

Persist exact ciphertext and a fresh ID per logical send. Archive retries are
idempotent; transport retries are not guaranteed to be. Timeout or duplicate
rejection leaves `unknown` unless acceptance is proved. Accepted means transport
acceptance only. No automatic paid retry or history replay may repeat payment
side effects. Public ciphertext preparation is an M0 gate, not an existing API.

### Fill a partial history

1. Device B starts with an empty local cache and no sync cursor.
2. It requests bounded cursor pages and stores records by `recordKey`.
3. It continues until `hasMore` is false, saving the cursor atomically after
   each batch.
4. New writes after the initial watermark are obtained in a subsequent change
   pass.
5. With an incomplete cache or expired cursor, stage a stable snapshot at W,
   reconcile absent cached records only when all pages succeed, then apply
   changes after W. Preserve unsent drafts separately.

The client never assumes that a timestamp alone is a complete pagination
boundary.

### Delete history

1. A user requests one record or all records to be deleted.
2. The authenticated store writes tombstones and advances the change sequence.
3. Other devices receive tombstones and remove local copies.
4. Bodies immediately become unavailable; bounded cleanup purges them while
   minimal tombstones survive the grace period. Backup retention and restoration
   of deletion receipts remain explicit operator obligations.

## 7. Functional requirements

### FR-001 — Identity-authenticated owner partition

Every protected endpoint MUST require BRC-103/BRC-104 authentication. The
server MUST derive the owner identity from the verified session and MUST ignore
or reject a conflicting body/path owner claim. A user MUST retrieve only its
own records, changes, quota state, and tombstones.

### FR-002 — Opaque encrypted archive

The archive API MUST accept and return the exact opaque Message Box envelope
needed by the wallet client. It MUST NOT require or accept private keys. The
reference implementation MUST avoid plaintext in logs, metrics, traces, error
responses, test snapshots, and operator diagnostics.

The service MAY validate structural bounds and hashes, but it MUST NOT attempt
to decrypt or rewrite the body.

V1 stores the exact inner encrypted-body string defined by ADR-001, excluding
unencrypted payment wrappers. Never upload decrypted `PeerMessage` values or
plaintext-mode messages. Structure cannot prove encryption by a malicious owner.
History replay MUST NOT internalize payments or acknowledge transport.

### FR-003 — Stable identity and idempotent upsert

Every record MUST have a deterministic `recordKey`, original `messageId`, and
body hash. Repeating an identical archive request MUST succeed without creating
a second record. A same-key/different-content request MUST return a typed
immutable-conflict result and create an auditable security event.

The API MUST support batches while enforcing maximum record count and total
body bytes. A partial batch result MUST identify each item, and the client MUST
be able to retry only failures.

### FR-004 — Inbound archive-before-ack worker

The client integration MUST expose an operation equivalent to:

```ts
const result = await store.archiveInbound(message)
if (result.ok || result.alreadyPresent) {
  await messageBox.acknowledgeMessage({ messageIds: [message.messageId] })
}
```

An unavailable or quota-exhausted store MUST NOT result in an automatic Message
Box acknowledgement. The application may offer an explicit “discard without
archive” action with clear user intent, but that is outside the safe default.

### FR-005 — Outbound archive integration

The client package MUST provide an explicit outbound archive operation and a
convenience wrapper that records `prepared`, calls the normal Message Box send,
and then records `accepted`, `failed`, or `unknown`. It MUST preserve ambiguous outcomes
for retry/reconciliation rather than inventing a delivery result.

### FR-006 — Cursor-based retrieval

The store MUST provide bounded pages with an opaque cursor, `hasMore`, and a
watermark. Cursor ordering MUST be deterministic and must not skip equal-time
records. The API MUST provide an incremental change feed including tombstones.

Offset pagination MAY be offered as a compatibility/debugging view but MUST
NOT be the convergence primitive.

### FR-007 — Partial-history convergence

The client MUST persist a sync cursor and apply records/tombstones idempotently.
Concurrent devices uploading the same record MUST converge to one immutable
record. If the cursor is too old, the server MUST return `ERR_CURSOR_EXPIRED` and
the client MUST have a bounded full-resync path. Silent truncation is a failure.

### FR-008 — Sent and received views

The query API MUST support filters for message box, direction, participant,
and time range where the configured privacy policy allows them. The service
MUST keep inbound and outbound records distinguishable. Conversation/thread
grouping is a client concern until a later protocol defines it.

### FR-009 — Deletion and tombstones

The service MUST support owner-authorized per-record and bulk deletion. Deletion
MUST be represented as a tombstone before physical purge, so other devices can
converge. Tombstones MUST be bounded by a grace/retention policy and surfaced
through the change feed.

### FR-010 — Capabilities and limits

An authenticated capabilities endpoint MUST expose effective protocol version,
page bounds, batch bounds, body/response limits, retention policy, and supported
features. Clients MUST use those values rather than assuming Message Box's
transport limits are archive limits.

### FR-011 — Safe degradation

The worker MUST distinguish transient service failure, authentication failure,
quota exhaustion, immutable conflict, and invalid input. It MUST provide a
retry-safe result and MUST leave Message Box pending on archive failure. The
service MUST expose public liveness and non-sensitive readiness endpoints.

### FR-012 — Backup/restore compatibility

The storage adapter MUST document consistent backup and restore. Any restore
that can roll back committed state MUST advertise a fresh recovery epoch and
force snapshot reconciliation, even when old sequence state survives.

## 8. API requirements

The implementation proposal uses versioned HTTP JSON routes over authenticated
requests:

```text
POST /v1/history/records
GET  /v1/history/records?cursor=...&messageBox=...&direction=...&limit=...
GET  /v1/history/changes?cursor=...&limit=...
POST /v1/history/records/state
POST /v1/history/records/tombstones
GET  /v1/history/capabilities
GET  /healthz
GET  /ready
```

The exact route and JSON names are an implementation decision gate, but the
following behavior is required:

### Archive batch request

```ts
interface ArchiveBatchRequest {
  ownerGeneration: string          // rejects writes predating delete-all
  records: Array<{
    recordKey: string
    messageId: string
    messageBox: string
    direction: 'inbound' | 'outbound'
    sender: string
    recipient: string
    body: string                 // exact inner encrypted-body string; ADR encoding
    bodyHash: string
    deliveryState?: 'prepared' | 'received' // subsequent changes use state route
  }>
}
```

The server derives the owner from authentication, recomputes `bodyHash`,
validates key/field bounds, and returns per-record outcomes such as `stored`,
`alreadyPresent`, `deleted`, `conflict`, `invalid`, or `quotaExceeded`. It MUST NOT trust
the client's byte count.

The server assigns creation/archive time and recomputes `recordKey` as well as
`bodyHash`. Inbound recipient/outbound sender must equal owner. Each outcome
identifies its input index and key. Admitted items commit together in request
order; rollback reports no successes. Duplicate checks precede quota charging.
State updates carry idempotency key and expected revision, support `unknown`,
and cannot downgrade accepted state or resurrect deletions. Capabilities expose
owner generation; stale-generation writes fail and require reconciliation.

### History page

```ts
interface HistoryPage<T> {
  records: T[]
  nextCursor: string | null
  checkpoint: string              // final/empty page still provides progress
  hasMore: boolean
  watermark: string
  epoch: string
  serverTime: string
}
```

The change feed uses the same shape with records and tombstones. Cursors are
opaque; clients MUST NOT parse or manufacture them. Cursor expiry is a typed
response with a recovery hint, not an empty successful page.

The ADR fixes commit-ordered decimal-string sequences, fixed W, versioned
events, stable snapshots, cursor binding and coverage rules. Browse pagination
does not prove a complete replica. Delete-all invalidates old upload generations;
tombstone compaction requires stale devices to resync before writing. Permanent
suppression after compaction is not promised for explicit historical imports.

### Error envelope

```ts
interface StoreError {
  status: 'error'
  code:
    | 'ERR_AUTHENTICATION_REQUIRED'
    | 'ERR_FORBIDDEN'
    | 'ERR_INVALID_RECORD'
    | 'ERR_REQUEST_TOO_LARGE'
    | 'ERR_QUOTA_EXCEEDED'
    | 'ERR_IMMUTABLE_CONFLICT'
    | 'ERR_CURSOR_EXPIRED'
    | 'ERR_INVALID_CURSOR'
    | 'ERR_REVISION_CONFLICT'
    | 'ERR_GENERATION_CHANGED'
    | 'ERR_RATE_LIMITED'
    | 'ERR_UNAVAILABLE'
    | 'ERR_INTERNAL'
  description: string
  retryAfterSeconds?: number
}
```

Error descriptions are operator-safe and MUST NOT include ciphertext, body
contents, signed headers, or stack traces.

## 9. Storage and quota requirements

The first reference adapter SHOULD use MySQL 8 and Knex migrations to align
with Message Box Server. SQLite SHOULD be supported for deterministic local
tests. A repository interface MUST isolate SQL dialect details.

The service MUST maintain owner-scoped usage for both record count and
canonical body bytes. It MUST enforce quotas transactionally, including
concurrent archives from multiple devices. The initial profile candidates are:

| Profile | Records | Ciphertext bytes | Archive batch | Page / response |
| --- | ---: | ---: | ---: | ---: |
| small | 10,000 | 256 MiB | 100 / 4 MiB | 250 / 4 MiB |
| standard | 100,000 | 1 GiB | 500 / 8 MiB | 1,000 / 8 MiB |
| high-throughput | 1,000,000 | 16 GiB | 5,000 / 32 MiB | 5,000 / 32 MiB |

These numbers are planning defaults, not a capacity guarantee. The release
must validate them with representative ciphertext sizes and a cgroup-constrained
memory test. Every limit MUST be finite by default. Operators may explicitly
choose an unlimited mode only with a documented capacity and abuse review.

Required resource controls:

- authenticated request rate per identity and optional shared ingress rate;
- maximum body, batch item count, batch bytes, page count, response bytes, and
  concurrent archive/sync jobs;
- maximum database pool and bounded transaction retry;
- per-owner record/byte quotas plus optional service-wide byte budget;
- expiry cleanup in bounded batches;
- backpressure when the database or worker queue is saturated;
- no unbounded in-memory accumulation while following pages.

Physical capacity also bounds change-log versions, tombstones, snapshots,
indexes, and backup growth. Same-record retries consume no additional quota;
deletion remains available at full quota. Live quota release and physical
cleanup are distinct. MySQL concurrency tests must prove exact accounting.

## 10. Security and privacy requirements

The threat model and architecture are normative in [ADR-001](./ADR-001-durable-history.md).
The implementation MUST demonstrate:

- BRC-103 identity from a verified signature is the only owner selector;
- no cross-owner record, cursor, tombstone, quota, or capabilities leakage;
- ciphertext-only operation with redacted logs and traces;
- body hash recomputation and immutable conflict detection;
- constant-time or library-safe authentication handling where applicable;
- strict URL/host configuration and TLS expectations for remote deployment;
- rate/body/concurrency ceilings before expensive database work;
- secure operator backup and secret handling;
- typed errors without plaintext/ciphertext echo;
- explicit identity-key rotation behavior or a documented unsupported state.

Message metadata is not hidden in v1. Operators can see authenticated owner,
participants, message box, stable IDs, timestamps, body length, retention,
request timing, and access frequency. Optional metadata encryption/padding is a
future protocol decision, not an implied property of “encrypted messages”.

## 11. Client integration requirements

The client integration SHOULD feel familiar to `MessageBoxClient`:

```ts
const history = new MessageBoxStoreClient({
  walletClient,
  host: 'https://history.example.com'
})

const worker = new MessageBoxArchiveWorker({
  messageBoxClient,
  historyClient: history,
  messageBoxes: ['inbox', 'general_inbox'],
  localStore
})

await worker.syncPending({ acknowledgeAfterArchive: true })
await worker.syncHistory()
const page = await history.list({ messageBox: 'general_inbox', limit: 250 })
```

Names are illustrative until the API decision gate. The important ergonomics
are:

- accepts an existing `WalletInterface`/`WalletClient` without owning keys;
- uses the same AuthFetch/BRC-103 identity session model;
- uses public Message Box/wallet contracts through the M0-selected raw adapter;
  never archives decrypted client results or calls private helper methods;
- supplies an injectable local cache so IndexedDB, SQLite, or another app store
  can be used without being bundled into the package;
- exposes explicit lifecycle (`start`, `syncOnce`, `stop`) and bounded work;
- returns per-record outcomes and metrics-friendly error codes;
- supports a no-ack mode for inspection and migration, with safe defaults.

The worker MUST not acknowledge live messages merely because a WebSocket
callback fired. The same archive gate applies to live and polled delivery.

The example is a target API, not usable with the unmodified surveyed client.
Raw polling tracks host provenance and explicitly acknowledges each source host.
Never advance a transport offset across rows deleted by acknowledgement: drain
bounded first pages or restart from zero after deletions. Bound each cycle and
report incomplete/failed hosts rather than treating partial success as complete.
All acknowledging devices must adopt archival; older clients can otherwise
delete messages before capture. A long outage can still exceed queue retention.
An archive response lost after commit is retried before ack. Only `stored` or
`alreadyPresent` satisfies the archive gate; a `deleted` outcome requires the
explicit user deletion policy, never an accidental success classification.

## 12. Operations and observability

The service MUST expose liveness and readiness separately. Readiness checks the
database and required migrations but returns a non-sensitive 503 when
unavailable. A deployment MUST retain an immutable application version and
migration state for rollback.

Structured metrics and logs SHOULD include:

- archive attempts, stored/already-present/conflict outcomes;
- inbound archive-to-ack success/failure and age of pending transport items;
- history page latency, bytes, records, cursor expiry, and sync lag;
- quota rejects by profile (without exposing identity in aggregate dashboards);
- tombstone and retention purge counts/lag;
- database transaction retries, deadlocks, pool saturation, and error class;
- authentication failures, cross-owner attempts, rate limits, and request size
  rejections;
- worker lifecycle, queue depth, retry count, and shutdown drain status.

Logs MUST not include private keys, auth signatures/nonces, complete device
tokens, body payloads, plaintext, or full ciphertext. A record key/body hash
may be logged only under a documented correlation policy; prefer redacted
prefixes and request IDs.

Deployments SHOULD support one process with embedded routes for small apps and
a standalone container for shared history. Horizontal scaling requires a
shared database, shared or gateway rate policy, and no process-local cursor or
quota truth. The worker itself should use one bounded loop per identity and
avoid spawning unbounded per-message work.

## 13. Testing and evidence plan

### Protocol and contract

- OpenAPI/JSON schema validation for success/error envelopes.
- BRC-103 authentication with valid, expired, malformed, and mismatched
  identity claims.
- Cross-identity and cross-owner negative tests for every route.
- Content type, field length, body byte, batch, page, cursor, and response
  bounds.

### Data correctness

- Duplicate archive from one device, two devices, and two Message Box hosts.
- Same key with changed body/metadata produces conflict and no overwrite.
- Concurrent archive transactions maintain exact quotas and one record.
- Cursor pages have deterministic order and no gaps/duplicates.
- Interleaved writes after a watermark converge on the next change page.
- Cursor expiry forces full resync rather than silent success.
- Tombstone propagation, purge grace, and restore preserve convergence.

### Message Box integration

- Inbound archive commits before acknowledge.
- Store failure leaves Message Box pending.
- Crash/retry after archive before acknowledge is idempotent.
- Live WebSocket and HTTP polling follow the same archive gate.
- Outbound `prepared`/`unknown`/`accepted`/`failed` transitions preserve ambiguous sends.
- Raw capture never archives plaintext; historical replay never repeats payments.
- Equal plaintext/new sends, exact retry bodies, and differing host timestamps.
- Acknowledgement during offset pagination cannot skip pending items.
- Snapshot interruption, concurrent updates, tombstone expiry, and absent-row
  reconciliation; empty-page checkpoints and filter/owner cursor misuse.
- Restore rolls epoch, rejects old writes, and reapplies deletion receipts.
- Multiple advertised Message Box hosts dedupe into one durable record.

### Privacy and operations

- Test fixtures prove no plaintext in DB rows, logs, traces, metrics, or error
  envelopes.
- Database backup/restore and simulated browser-cache loss let a second wallet
  device retrieve/decrypt history.
- Rate, quota, body, concurrency, DB retry, and cleanup controls are measured
  under profile-constrained memory.
- Graceful shutdown drains worker work without acknowledging unarchived items.
- Packed npm consumer tests cover ESM, CommonJS, declarations, and browser
  client bundle exclusion of server/database dependencies.

## 14. Packaging and release requirements

The independent project SHOULD mirror the strongest relevant ts-stack package
conventions:

- public `package.json` with ESM/CJS/declaration exports and `publishConfig`;
- `mod.ts` root export plus explicit client/server/storage subpaths;
- `tsdown` build, strict TypeScript, Oxlint, Prettier, Jest, property tests,
  and packed-consumer/browser checks;
- `README.md`, `CHANGELOG.md`, license and third-party notices;
- Node 22+ client target; Node 24+ reference server target;
- `@bsv/sdk` peer dependency; transport client integration as peer/optional;
  server/database dependencies isolated to server subpaths;
- SemVer: additive protocol/client exports are minor, bug fixes patch, wire or
  persistence incompatibilities major with migration notes;
- every published byte/manifest change has release notes, migration impact,
  test evidence, and a rollback/forward-fix statement;
- no workstation publication or deployment without explicit operator release
  authority.

The first public package may be called `@bsv/message-box-store`, but the scope
and ownership decision is unresolved. If maintainers prefer a client/server
split, preserve a shared protocol package or stable root exports so consumers
do not duplicate record and cursor types.

## 15. Adoption and migration

### MVP migration

1. Add the store client and protocol types with no automatic acknowledgement.
2. Enable inbound archive on one message box with metrics only.
3. Verify that store rows contain ciphertext and that a second device decrypts
   the same messages.
4. Enable acknowledge-after-archive for the selected box.
5. Add outbound archive wrapper and verify send timeout reconciliation.
6. Backfill only pending Message Box messages. For acknowledged history,
   import a trusted existing encrypted export if the application has one.
7. Enable retention, tombstone, backup, and restore drills before broad rollout.

### Compatibility

Existing Message Box send/list/ack clients remain valid. A client can run in
transport-only mode when the history service is unavailable, but the safe
archive worker MUST not acknowledge pending messages in that mode. Applications
that intentionally accept loss may expose a separate explicit policy.

### Rollback

Disable archive integration or switch the worker to no-ack inspection mode;
leave the Message Box server and its migrations unchanged. If a store migration
is backward-incompatible, restore the last compatible image and database
backup, then make clients re-sync from the advertised recovery epoch.

## 16. Milestones and exit criteria

### M0 — Contract and threat-model sign-off

- ADR/PRD reviewed.
- Package ownership/scope, DB adapter, cursor model, record key, and retention
  decisions resolved.
- Raw receive/prepared-send adapter demonstrated against an explicit upstream
  version, including sender-side decryption on a second device and payment policy.
- Threat model and privacy claims accepted.

### M1 — Shared protocol and repository

- Typed record/page/error/capability contracts.
- Knex migrations and repository interface.
- Idempotent archive, immutable conflict, owner partition, quotas, and cursor
  tests.

### M2 — Service adapter

- BRC-103 routes, readiness/liveness, metrics, redacted logs, rate/body limits,
  bounded cleanup, and migration/runbook evidence.

### M3 — Client worker

- HTTP/live Message Box integration, archive-before-ack, outbound state,
  local-cache adapter, cursor sync, tombstones, and crash/retry tests.

### M4 — Recovery and package release

- backup/restore drill, second-device cache-loss drill, packed consumer/browser
  checks, security review, changelog/migration guide, and release candidate.

The MVP is complete only when M1–M4 evidence exists and the following are
demonstrated in an automated or recorded integration test:

1. device A receives an encrypted message, archives it, acknowledges transport;
2. device B with the same identity retrieves the record from the store;
3. device B decrypts the original body;
4. duplicate archive and cursor replay create no duplicate conversation item;
5. an archive outage leaves a transport message pending;
6. deletion converges through tombstones within the documented grace period.

## 17. Open decisions

The following questions require maintainer/product decisions before code is
considered stable:

- Is the first hosted target a private application deployment, a generic public service, or
  only an embeddable library?
- What npm scope and repository ownership will publish the package?
- MySQL/Knex only for v1, or PostgreSQL and a portable adapter immediately?
- What are the operator and user retention defaults, and how long are
  tombstones/backups retained?
- Are `sender` and `recipient` stored in plaintext metadata or represented by a
  future encrypted metadata envelope?
- Which public raw-envelope/prepared-send adapter satisfies archive-before-send,
  and what compatible upstream version and ambiguous-send policy does it require?
- How should identity key rotation and explicit history migration work?
- Do applications require a first-class thread/conversation ID in v1?
- Should store capability be advertised through overlay discovery, configured
  explicitly, or both?
- Is optional BRC-105 pricing required for hosted history, and which routes
  are free or paid?

## 18. Reference basis

The requirements are grounded in the current vendored sources and contracts:

- [`@bsv/message-box-client`](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client)
- [`MessageBoxClient` implementation](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/messaging/message-box-client/src/MessageBoxClient.ts)
- [`message-box-client` types](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/messaging/message-box-client/src/types.ts)
- [`Message Box HTTP OpenAPI`](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/messaging/message-box-http.yaml)
- [`message-box-server`](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/message-box-server)
- [`service resource profiles`](https://github.com/bsv-blockchain/ts-stack/blob/main/docs/reference/service-resource-profiles.md)

The local package manifests are the version authority for the surveyed snapshot:
client `2.4.2`, server `1.1.40` (private). The folder remains portable because
these references are documentation links only; no runtime or build dependency
points into a consumer repository or a local reference checkout.
