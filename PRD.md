# Product Requirements Document: message-box-store

- **Status:** Accepted v1 product contract; M0-M3 implemented as a private
  evaluation checkpoint, M4 open
- **Date:** 2026-09-20
- **Product:** `message-box-store`
- **Audience:** implementers, package maintainers, service operators, and
  applications using `@bsv/message-box-client`
- **Related decision:** [ADR-001](./ADR-001-durable-history.md)

## 1. Summary

`message-box-store` is one independently publishable package, initially used
as a private MapApp service for best-effort storage of encrypted Message Box
history. It gives a user who controls one BSV wallet identity a history copy
that can be retrieved on multiple devices, subject to retention, quota, and
operator purge.
Each device downloads the same encrypted records and decrypts them locally.

The product complements, and does not replace, Message Box:

- Message Box remains the temporary authenticated delivery queue.
- `message-box-store` becomes the independently retained encrypted history.
- The wallet remains the identity, signing, and decryption authority.
- The application remains responsible for plaintext rendering, conversations,
  local cache, and user experience.

The package is designed to be independently adaptable and publishable, but is
private during development and no publication or deployment is authorized by
this PRD. It is embedded beside an unmodified Message Box Server and has no
consumer-application runtime dependency. V1 uses MySQL 8/Knex in production,
SQLite for deterministic tests, and no PostgreSQL adapter. Its root client and
protocol exports are browser-safe; server/storage code uses explicit subpaths.

Normative v1 semantics are defined in the ADR and accepted decisions. M1-M3
now implement the repository, authenticated service, and convergent client
workflow, but this remains a private evaluation checkpoint rather than a
shipped service. The existing client decrypts
receive results and prepares ciphertext internally. M0 proves a public composition for the pinned
2.5.1 client: `wallet.encrypt` prepares once, `sendMessage` receives the exact
body with `skipEncryption: true`, and authenticated raw HTTP polling supplies
inbound archive records. This is not a drop-in archive integration.

The M0 HTTP and AuthSocket fixtures are executable in the standalone
repository against `@bsv/message-box-client` 2.5.1 and the public authenticated
HTTP/AuthSocket contracts. They cover exact prepared-body HTTP send, raw inbound
polling, archive-before-ack, live wake-up followed by raw polling, the
upstream live-to-HTTP fallback hazard, and same-identity second-device
decryption. The store's outbound policy helper accepts only an opaque branded capability,
persists `prepared` first, makes one application-level send invocation,
rejects explicit paid mode before reservation, and never repeats an ambiguous
attempt. V1 is free-transport-only; no paid send or satoshi spend was needed
for this proof. SDK `AuthFetch` still attempts
automatic payment on HTTP 402, so the public M0 factories construct supported
Message Box/store clients with a payment-disabled WalletInterface before any
request. Authenticated local 402 challenges prove no action or paid retry; a
fee-requiring host remains unsupported because the original request reaches
it. The factories are proof-level client construction, not durable storage,
production routes, or the M1/M3 worker. See
[`docs/M0-INTEROP-EVIDENCE.md`](./docs/M0-INTEROP-EVIDENCE.md).

## 2. Problem and opportunity

The current Message Box flow is safe for asynchronous delivery but surprising
for social messaging: after a client durably handles a message and calls
`acknowledgeMessage`, the server deletes it. A browser cache clear or device
loss then removes the only application-level history. A second device with the
same identity does not see the already acknowledged envelope.

The current client also has no server-backed sent-items archive. Message Box
stores recipient queues, so a sender cannot reconstruct its own outgoing
history from that service.

We need a product-level archive with explicit finite limits, robust archive
retry/deduplication, a conservative one-shot outbound policy, and an honest
privacy boundary. V1 does not provide paid Message Box delivery or pricing.

## 3. Goals

### Product goals

1. Preserve encrypted inbound history before Message Box acknowledgement.
2. Preserve encrypted outbound history through an explicit send integration.
3. Let two or more devices with the same wallet identity retrieve a consistent
   set of records and decrypt them locally.
4. Make archive retries, duplicate hosts, concurrent devices, partial pages,
   and crash windows safe and observable; keep outbound transport at one
   client invocation per logical record.
5. Bound per-identity and global storage/resource consumption.
6. Be easy to embed with familiar `@bsv/message-box-client` and ts-stack
   conventions while remaining an independent package.
7. Provide operator-controlled encrypted backups and a tested epoch-based
   restore path without promising user-available recovery.

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
- Guaranteeing exactly-once delivery or permanent availability on an
  unreliable network or under operator control.
- Storing arbitrary unbounded files or attachments in the message record path.
- Treating a local browser cache as a sufficient remote backup.

## 5. Users and usage modes

### Social application user

Uses a private inbox on a browser and phone. Expects acknowledged messages and
sent items to survive cache/device loss. Wants no server plaintext access.

### Protocol application

Uses free Message Box transport for supported history archival. Paid transport
and pricing are outside v1. An application may opt out of archival or configure
retention; the service does not impose conversation/thread semantics.

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

1. The wallet prepares the final encrypted envelope once with the Message Box
   protocol and a fresh explicit `messageId`.
2. The archive worker atomically persists the exact body and state `prepared`
   under its canonical outbound record key.
3. The worker makes one application-level invocation of public HTTP
   `MessageBoxClient.sendMessage` with that ID/body, `skipEncryption: true`,
   and `checkPermissions: false`.
   An explicit paid/permission-check request fails with
   `ERR_PAID_TRANSPORT_UNSUPPORTED` before reservation or transport. The host
   is explicitly configured and HTTPS; a fee-requiring host is unsupported.
4. A matching success response marks the record `accepted`. A timeout, other
   thrown error, malformed response, or recovered `prepared` record is
   `unknown` and is never automatically sent again. A pre-send no-dispatch
   result (policy/validation rejection, immutable conflict, or reservation
   unavailable/failed) is `failed`; if its state write/read is unconfirmed,
   `statePersisted` remains false and a surviving `prepared` record recovers as
   `unknown`. The typed
   `ERR_PAID_TRANSPORT_UNSUPPORTED` from the BRC-105 wallet guard after HTTP
   402 is also `failed`: the initial request was attempted, but no payment key,
   wallet action, or paid retry occurred.
5. Another device retrieves the opaque outbound record and decrypts it locally.

The worker's HTTP-only capability has no `sendLiveMessage` route or paid-send
API. It never invokes a live-to-HTTP fallback, and the BRC-105 guard blocks a
paid retry after HTTP 402. Existing
`prepared`, `unknown`, or `accepted` records block another send under the same
record key; a concurrent invocation cannot race past the atomic reservation.
This is an at-most-once client invocation policy, not exactly-once network
delivery. SDK 2.7.1 `AuthFetch` may make internal authenticated HTTP exchanges
while recovering a stale BRC-103 session, so M0 does not promise one physical
HTTP request. The public method may still time out after server acceptance;
the outcome remains `unknown` because the API has no sender receipt lookup.
Do not automatically retry it. A future manual recovery operation requires a
separate decision and evidence.

`attempted` is true only after the helper invokes the guarded public
`sendMessage` capability; it is false for preflight, reservation, conflict,
and already-claimed outcomes. `statePersisted` is true only when the
attempt-store read or write confirms the state returned by the helper. False
means the stored state is unconfirmed, not that a write whose acknowledgement
was lost definitely failed. Any surviving `prepared` record is recovered as
`unknown` and blocks another send.

`sendLiveMessage` is excluded for all outbound store delivery, regardless of
fee. In 2.5.1 it automatically falls back to HTTP after a negative
acknowledgement, a disconnected socket, or a 10-second acknowledgement timeout.
If the live send was accepted before its acknowledgement was lost, fallback is
a second transport attempt. With `checkPermissions: true`, that fallback can
reach wallet action creation before duplicate rejection. Body/ID deduplication
does not make a payment action idempotent. Inbound AuthSocket notifications may
still wake an authenticated raw HTTP poll followed by archive-before-ack.

Only free calls are supported. Outbound store calls force
`checkPermissions: false`; the implementation rejects paid requests rather than
passing them through. `createFreeOnlyMessageBoxClient()` constructs the
upstream client with the public WalletInterface guard from the outset; generic
AuthFetch construction remains internal and is not a root export. The guard prevents BRC-105 payment-key
derivation and transaction actions; the fetch facade rejects pre-supplied
payment contexts/headers and surfaces a typed failure on an unexpected 402.
M3 must preserve and re-test this boundary for every worker operation;
ambiguous send results are never retried.

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
2. The authenticated store permanently purges the body, releases count/byte
   quota in the same transaction, and appends a bounded delete event containing
   only record key, sequence, and time.
3. Other devices apply that event and remove local copies. When the 30-day feed
   window expires, they take a full snapshot and delete local records absent
   from it.
4. A backup restore rotates the recovery epoch and forces full reconciliation;
   post-backup deletions must be reapplied or the operator fails closed. Backup
   retention and restore are not a user-facing guarantee.

## 7. Functional requirements

### FR-001 — Identity-authenticated owner partition

Every protected endpoint MUST require BRC-103/BRC-104 authentication. The
server MUST derive the owner identity from the verified session and MUST ignore
or reject a conflicting body/path owner claim. A user MUST retrieve only its
own records, change events, quota state, and cursors.

### FR-002 — Opaque encrypted archive

The archive API MUST accept and return the exact opaque Message Box envelope
needed by the wallet client. It MUST NOT require or accept private keys. The
reference implementation MUST avoid plaintext in logs, metrics, traces, error
responses, test snapshots, and operator diagnostics.

The service MAY validate structural bounds and hashes, but it MUST NOT attempt
to decrypt or rewrite the body.

V1 stores the exact inner encrypted-body string defined by ADR-001, excluding
unencrypted payment wrappers. Never upload decrypted `PeerMessage` values or
plaintext-mode messages. The store provides free transport only; supported
history and send APIs MUST NOT price, construct, accept, or replay payments.
Structure cannot prove encryption by a malicious owner. History replay MUST
NOT internalize payments or acknowledge transport.

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
convenience wrapper that persists `prepared` and the exact encrypted body
before making one application-level public HTTP `MessageBoxClient.sendMessage`
invocation with an explicit ID, `skipEncryption: true`, and
`checkPermissions: false`. AuthFetch may make internal stale-session HTTP
recovery exchanges; this is not a one-physical-request promise. An
explicit paid request MUST fail with stable error code
`ERR_PAID_TRANSPORT_UNSUPPORTED` before reserving an attempt or calling wallet
or transport. A fee-requiring host is unsupported; every supported HTTP client
MUST use the guarded public factory so an unexpected 402 cannot reach wallet
transaction-action methods or trigger a paid retry. It MUST NOT call
`sendLiveMessage` for outbound delivery. Matching success records `accepted`;
any ambiguous result is `unknown` and MUST NOT be automatically retried. A
deterministic preflight failure before the application-level invocation is
`failed` when the helper did not invoke the application-level send (pre-send
policy/validation, immutable conflict, or reservation failure); the typed
`ERR_PAID_TRANSPORT_UNSUPPORTED` after HTTP 402 is also `failed` because the
guard blocks BRC-105 payment construction and retry.
`attempted` records whether that invocation happened, and `statePersisted`
records whether the attempt store confirmed the returned state. Existing
prepared/unknown/accepted attempt keys MUST block a second invocation. The API
must not imply exactly-once network delivery or expose an automatic recovery
path.

### FR-006 — Cursor-based retrieval

The store MUST provide bounded pages with an opaque cursor, `hasMore`, and a
watermark. Cursor ordering MUST be deterministic and must not skip equal-time
records. The API MUST provide an incremental change feed including minimal
delete events that contain no ciphertext.

Offset pagination MAY be offered as a compatibility/debugging view but MUST
NOT be the convergence primitive.

### FR-007 — Partial-history convergence

The client MUST persist a sync cursor and apply records/delete events
idempotently.
Concurrent devices uploading the same record MUST converge to one immutable
record. If the cursor is too old, the server MUST return `ERR_CURSOR_EXPIRED` and
the client MUST have a bounded full-resync path. Silent truncation is a failure.

### FR-008 — Sent and received views

The query API MUST support filters for message box, direction, participant,
and time range. The service MUST keep inbound and outbound records
distinguishable. V1 has no canonical conversation/thread field; grouping is a
client concern.

### FR-009 — Deletion and convergence

The service MUST support owner-authorized per-record and bulk deletion. Owner
deletion MUST permanently purge the active ciphertext and release count/byte
quota in the same transaction. No ciphertext tombstone may remain. A minimal
change event containing only record key, sequence and time MUST remain for 30
days. After cursor expiry, the client MUST perform a complete snapshot and
remove local records absent from that snapshot. Restore MUST rotate the epoch,
reapply deletions recorded after the backup, or fail closed before serving.

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
GET  /v1/history/snapshot?cursor=...&limit=...
GET  /v1/history/changes?cursor=...&limit=...
PATCH /v1/history/records/{recordKey}/state
DELETE /v1/history/records/{recordKey}
DELETE /v1/history/records
GET  /v1/history/capabilities
GET  /healthz
GET  /ready
```

The route names and cursor scheme are frozen by
[`docs/M0-DECISIONS.md`](./docs/M0-DECISIONS.md). The following behavior is
required:

### Archive batch request

```ts
interface ArchiveBatchRequest {
  epoch: string                    // rejects writes predating delete-all/restore
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
the owner epoch; stale-epoch writes fail and require reconciliation.

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

The change feed uses the same shape with records and body-free delete events. Cursors are
opaque; clients MUST NOT parse or manufacture them. Cursor expiry is a typed
response with a recovery hint, not an empty successful page.

`GET /v1/history/changes` has two start modes. An omitted `cursor` starts the
legacy initial scan. A client with complete local coverage starts a new pass
with paired `afterSequence=<checkpoint>` and `epoch=<owner epoch>` query
parameters. The pair is mutually exclusive with `cursor`; continuations use
only the returned opaque cursor and remain fixed to the pass watermark. The
server rejects half-pairs, noncanonical uint64 values, positions beyond the
current watermark, epoch mismatch, and every retention gap—including a gap
after an explicit checkpoint of `0`. A checkpoint is a claimed position, not
authorization or proof that the client holds a complete replica;
authentication still selects the owner.

The ADR fixes commit-ordered decimal-string sequences, fixed W, versioned
events, stable snapshots, cursor binding and coverage rules. Browse pagination
does not prove a complete replica. Delete-all and restore rotate the owner
epoch and invalidate old cursors and writes. Importing deleted records is not a
supported way to bypass a delete; clients must reconcile against the current
snapshot before uploading stale local history.

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
    | 'ERR_EPOCH_CHANGED'
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

Production storage MUST use MySQL 8 and Knex migrations. SQLite is for
deterministic tests only; PostgreSQL and object-backed adapters are out of v1.
Keep the initial adapter narrow rather than adding unneeded dialect
abstractions.

The service MUST maintain owner-scoped usage for both record count and
exact UTF-8 body bytes. It MUST enforce quotas transactionally, including
concurrent archives from multiple devices. The finite initial defaults are:

| Profile | Records | Ciphertext bytes | Archive batch | Page / response |
| --- | ---: | ---: | ---: | ---: |
| v1 initial | 10,000 | 1 GiB | 100 / 4 MiB | 1,000 / 8 MiB |

Each body is at most 1 MiB. The standard Message Box Server 1.1.42 resource
profile additionally supplies initial values of 300 unauthenticated
requests/minute/IP, 1,000 authenticated requests/minute/identity, 24 concurrent
requests/process, and DB pool max 7. See
[`docs/M0-DECISIONS.md`](./docs/M0-DECISIONS.md) for the source baseline and
remaining controls. These are planning defaults, not capacity promises for
history storage; M2/M4 must measure MySQL accounting, contention and bounded
memory. Raising a limit requires representative evidence. There is no
unlimited mode by default.

Required resource controls:

- authenticated request rate per identity and optional shared ingress rate;
- maximum body, batch item count, batch bytes, page count, response bytes, and
  concurrent archive/sync jobs;
- maximum database pool and bounded transaction retry;
- per-owner record/byte quotas plus optional service-wide byte budget;
- expiry cleanup in bounded batches;
- backpressure when the database or worker queue is saturated;
- no unbounded in-memory accumulation while following pages.

Physical capacity also bounds retained change versions, snapshots, indexes,
and backup growth. Same-record retries consume no additional quota. Deletion
purges ciphertext and releases count/byte quota in one transaction; the
body-free delete event is retained for 30 days. Deletion remains available at
full quota. MySQL concurrency tests must prove exact accounting.

Retention is configured through `MESSAGE_BOX_STORE_RETENTION_DAYS`, accepting
an integer of at least 7 or `permanent`; default `permanent` means no scheduled
expiry. It is still subject to the finite quota and operator purge. The
service is best-effort storage and MUST NOT be described in UI or package copy
as a guaranteed backup. Operator backup retention may preserve deleted bytes
for its documented finite backup window.

## 10. Security and privacy requirements

The threat model and architecture are normative in [ADR-001](./ADR-001-durable-history.md).
The implementation MUST demonstrate:

- BRC-103 identity from a verified signature is the only owner selector;
- no cross-owner record, cursor, delete-event, quota, or capabilities leakage;
- never accept or store plaintext or private/decryption keys; never log or
  return plaintext, keys, signed headers, auth nonces, credentials, complete
  tokens, or ciphertext;
- body hash recomputation and immutable conflict detection;
- tampered/cross-owner cursors fail without revealing the owner's activity;
- signed method/path/query/body alteration and invalid/removed sessions are
  rejected. Each service instance also rejects reuse of a verified BRC-104
  request ID within its bounded 5,000-request post-authentication window. This
  is not an absolute single-use guarantee: after FIFO eviction, an exact old
  request falls back to the pinned upstream live-session and signature checks;
- an HMAC-integrity-protected cursor is owner-, epoch-, feed-, filter-,
  watermark-, position-, and expiry-bound; it is not message ciphertext or a
  credential and does not promise confidentiality;
- strict explicitly configured HTTPS origin and normal TLS validation. The
  Message Box outbound authority belongs only to the primary origin; explicitly
  validated `trustedHosts` authorize only exact POST raw-list and per-source
  acknowledgement routes. No generic authenticated fetch is exposed;
- rate/body/concurrency ceilings before expensive database work;
- secure operator backup and secret handling;
- typed errors without plaintext/ciphertext echo;
- one key owns one partition; rotation/migration is unsupported in v1;
- deletion purge, quota release, replica reconciliation, and restore epoch are
  tested as a release security gate.

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

Names are illustrative, while v1 route and protocol decisions are frozen in
[`docs/M0-DECISIONS.md`](./docs/M0-DECISIONS.md). The important ergonomics are:

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
Raw polling tracks host provenance and explicitly acknowledges each source host
only if it is in the configured `trustedHosts` allowlist.
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
- delete-event and retention purge counts/lag;
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
- Delete immediately purges the active body/releases quota, emits no body in its
  30-day change event, and converges by incremental feed or absent-row snapshot.
- Retention accepts only `permanent` or an integer of at least 7 days; operator
  purge remains possible at all times.

### Message Box integration

- Inbound archive commits before acknowledge.
- Store failure leaves Message Box pending.
- Crash/retry after archive before acknowledge is idempotent.
- Live WebSocket and HTTP polling follow the same archive gate.
- The facade exposes no send, wallet, raw client, or generic AuthFetch. Only a
  runtime-branded capability backed by module-private transport can enter the
  one-shot helper; no helper path reaches `sendLiveMessage`.
- Outbound `prepared`/`unknown`/`accepted`/`failed` transitions permit one
  application-level invocation at most, including concurrent/repeated calls.
  AuthFetch may do internal stale-session HTTP recovery, so this is not a
  one-physical-request promise. Explicit
  `checkPermissions: true` fails before attempt reservation, wallet, or
  transport; supported sends always pass false.
- A lost HTTP response leaves `unknown`; invoking the policy helper again does
  not repeat the same ID/body. A typed guarded 402 is deterministically
  `failed` with `attempted: true` and no paid retry. The separate HTTP 402 gate
  verifies no wallet action or paid retry can occur on the supported send
  integration.
- M0's local authenticated 402 tests cover outbound send, raw inbound polling,
  acknowledgement, plus an internal generic AuthFetch characterization. The
  underlying wallet receives no transaction-action call or payment output;
  caller-supplied payment contexts and headers fail before dispatch.
- M3 re-tests every worker operation through the guarded factory. A future SDK
  or Message Box client upgrade requires re-auditing the pinned 402 path before
  integration continues.
- A 2.5.1 live timeout/negative-ack characterization proves why outbound live
  delivery is prohibited; positive-fee live acceptance is outside v1 support.
- Raw capture never archives plaintext; store APIs expose no pricing,
  payment-construction, acceptance, or replay capability.
- Equal plaintext/new sends use fresh IDs and ciphertext; conflicting bodies,
  or hosts cannot reuse a prepared record key.
- Acknowledgement during offset pagination cannot skip pending items.
- Snapshot interruption, concurrent updates, delete-event expiry and absent-row
  reconciliation; empty-page checkpoints and filter/owner cursor misuse.
- Restore rolls epoch, rejects old writes, and reapplies the deletion events
  recorded after the restored backup.
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
- frozen M0 `.mjs` proof fixtures that are not wholesale-converted as an M1
  gate;
- strict TypeScript public entrypoints for M1+ surfaces, with `mod.ts` root and
  explicit client/server/storage subpaths. Proven internals may migrate or be
  wrapped incrementally, but generated artifacts must share one behavioral
  implementation;
- Bun-driven `tsdown` build, typecheck, lint, formatting, property tests, and
  packed-consumer/browser checks;
- `README.md`, `CHANGELOG.md`, license and third-party notices;
- Node 22 M1 package baseline. Node 24 reference-server verification is deferred
  to M2/M4 and is not an M1 closure requirement;
- `@bsv/sdk` peer dependency; transport client integration as peer/optional;
  server/database dependencies isolated to server subpaths;
- SemVer: additive protocol/client exports are minor, bug fixes patch, wire or
  persistence incompatibilities major with migration notes;
- every published byte/manifest change has release notes, migration impact,
  test evidence, and a rollback/forward-fix statement;
- no workstation publication or deployment without explicit operator release
  authority.

V1 is one independently publishable package, initially private to MapApp, with
browser-safe client/protocol root exports and explicit server/storage
subpaths. Registry scope, license and maintainer account are publication
administration to resolve before M4; no publish/deploy action is authorized by
this plan.

## 15. Adoption and migration

### MVP migration

1. Add the store client and protocol types with no automatic acknowledgement.
2. Enable inbound archive on one message box with metrics only.
3. Verify that store rows contain ciphertext and that a second device decrypts
   the same messages.
4. Enable acknowledge-after-archive for the selected box.
5. Add outbound one-shot HTTP archive wrapper and surface `unknown` without
   retransmitting after timeout.
6. Backfill only pending Message Box messages. For acknowledged history,
   import a trusted existing encrypted export if the application has one.
7. Configure retention and complete delete-convergence, backup, and
   epoch-based restore drills before broader rollout.

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
- One package shape, initial private MapApp use, MySQL 8/Knex production,
  SQLite tests, cursor/record key, free-only transport, finite limits, retention,
  delete semantics, and the accepted privacy/security boundaries are frozen in
  `docs/M0-DECISIONS.md` and `docs/M0-THREAT-MODEL.md`.
- Raw receive and HTTP-only prepared-send policy demonstrated against the
  pinned `@bsv/message-box-client` 2.5.1, including exact envelope preservation,
  sender-side decryption on a second device, one-shot state handling, and
  rejection of `checkPermissions: true` before reservation/wallet/transport.
- Outbound `sendLiveMessage` is explicitly unsupported because its automatic
  fallback can duplicate an accepted send. Positive-quote and live-fallback
  fixtures are characterization only, not supported features or release
  criteria.
- M0 proves the public free-only construction guard against a real local
  authenticated HTTP 402 challenge. M3 must re-test all implemented worker
  operations through that factory; M1 storage adapters now exist, while
  authenticated production routes and the M3 worker do not.
- The pinned reference snapshot is `@bsv/message-box-client` 2.5.1 / `@bsv/sdk`
  2.7.1 and server source 1.1.42. Historical older-version comparisons are
  not required.
- Threat model and privacy claims accepted.

### M1 — Shared protocol and repository

- Typed record/page/error/capability contracts, browser-safe package surfaces,
  and independent conformance vectors are implemented and accepted.
- Memory, persistent SQLite, and MySQL/Knex repository adapters and ordered
  migrations are implemented. MySQL is the production target; SQLite/memory
  provide parity and deterministic evidence.
- Idempotent archive, immutable conflict, quotas, deletion fencing, stable
  snapshots, fixed-watermark change feeds, retention compaction, and cursor
  expiry are implemented. Final `.2.4` acceptance still requires clean proof
  of concurrency, legacy migration boundaries, bounded cleanup, UTC sessions,
  and exact serialized response limits.

### M2 — Service adapter

- BRC-103 routes, readiness/liveness, metrics, redacted logs, rate/body limits,
  bounded cleanup, MySQL limits, and migration/runbook evidence.

### M3 — Client worker

- HTTP outbound Message Box integration, inbound live wake-up plus authenticated
  raw polling, archive-before-ack, outbound state,
  local-cache adapter, cursor sync, deletion/absent-snapshot convergence,
  regression tests that all AuthFetch operations use the M0-proven factory,
  and crash/retry tests.

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
6. deletion purges active ciphertext and quota immediately, then converges
   through the bounded body-free feed or absent-row snapshot.

## 17. Deferred implementation and release gates

The product choices are resolved in `docs/M0-DECISIONS.md`; these are evidence
gates, not open product questions:

- M1-M3: implemented and covered by protocol/repository, authenticated-service,
  client-operation, and packed two-device evidence. This status does not grant
  publication or deployment authority.
- M4: capacity and backup/restore evidence, packed browser/server exports,
  license/registry/maintainer administration, and security review.
- Revalidate the adapter matrix whenever the pinned client or SDK versions
  change. Rotation, thread IDs, metadata encryption/padding, discovery, pricing,
  paid delivery, live fallback, and resend/recovery remain outside v1.

## 18. Reference basis

The requirements are grounded in the current vendored sources and contracts:

- [`@bsv/message-box-client`](https://github.com/bsv-blockchain/ts-stack/tree/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/packages/messaging/message-box-client)
- [`MessageBoxClient` implementation](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/packages/messaging/message-box-client/src/MessageBoxClient.ts)
- [`message-box-client` types](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/packages/messaging/message-box-client/src/types.ts)
- [`Message Box HTTP OpenAPI`](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/specs/messaging/message-box-http.yaml)
- [`message-box-server`](https://github.com/bsv-blockchain/ts-stack/tree/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server)
- [`service resource profiles`](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/docs/reference/service-resource-profiles.md)

The local package manifests are the version authority for the surveyed snapshot
at ts-stack commit `bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b`: client `2.5.1`,
SDK `2.7.1`, auth middleware `2.2.3`, and server source `1.1.42` (private).
The folder remains portable because
these references are documentation links only; no runtime or build dependency
points into a consumer repository or a local reference checkout.
