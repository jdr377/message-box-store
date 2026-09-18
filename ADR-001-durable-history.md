# ADR-001: Durable encrypted history beside Message Box

- **Status:** Proposed architecture for implementation
- **Date:** 2026-09-18
- **Decision owners:** message-box-store maintainers
- **Scope:** A standalone package and deployable service that archives and
  retrieves encrypted Message Box envelopes across devices
- **Out of scope:** Changing the Message Box protocol, forking
  `@bsv/message-box-client`, or modifying `message-box-server`

## Context

Message Box is intentionally a delivery queue. The current `ts-stack` server
authenticates requests with BRC-103 over the BRC-104 HTTP binding, stores the
client-provided body for an identity-owned named box, and deletes rows when
`/acknowledgeMessage` succeeds. The client encrypts bodies by default through
the wallet protocol and exposes `sendMessage`, `listMessages`, live delivery,
and `acknowledgeMessage`; it does not provide a remote conversation archive.

That contract is appropriate for protocol handoffs, payment requests,
notifications, and other work queues. It is insufficient for a social/private
messenger where users reasonably expect sent and received history to survive a
browser cache clear, hardware loss, or switching between two devices holding
the same wallet identity.

The current server already has useful resource controls—bounded body sizes,
recipient fan-out, page limits, list response bytes, inbox/sender quotas,
retention expiry, rate limits, and a MySQL/Knex schema. Those controls protect
a queue, not an indefinitely growing archive. Reusing the queue database or
changing acknowledgement semantics would couple two different lifecycles and
would not recover already acknowledged messages from a hosted server.

Evidence for the transport boundary is in the current reference sources:

- The client derives a transport `messageId` with wallet HMAC protocol
  `[1, 'messagebox']`, key ID `1`, and the recipient as counterparty; it
  encrypts the body with the same protocol before `/sendMessage`.
- The server's `messages` table has an opaque `body`, sender, recipient,
  message-box ID, timestamps, and expiry; the `2024-03-05-001-messageID-upgrade`
  migration makes `messageId` a unique string.
- `/listMessages` returns recipient-owned, deterministic pages using
  `created_at` and `messageId` ordering plus `nextOffset`/`hasMore`.
- `/acknowledgeMessage` deletes rows scoped to the authenticated recipient.
- The standard Message Box resource profile defaults to 1 MiB bodies, 1,000
  messages per response, 8 MiB response bytes, 10,000 inbox/sender messages,
  1 GiB inbox/sender bytes, and 30-day retention; these are operator controls,
  not a user backup contract.

See the source links in [`README.md`](./README.md) for both vendored relative
references and upstream URLs.

### Integration feasibility finding

The surveyed client does **not** expose a prepare/send-encrypted pair or raw
receive hook. `sendMessage` calls private ID/encryption helpers;
`listMessages`, `listMessagesLite`, and live callbacks decrypt before returning.
`listMessages` also accepts payments by default. Wrapping these return values
would upload plaintext and cannot implement this design.

M0 must prove a public raw-envelope integration: preferably additive upstream
prepare/send and raw-receive hooks, or a separate adapter over the documented
authenticated HTTP contract. The latter must document its transport ownership
and use public wallet crypto APIs, never private methods or monkey patches.
Live delivery may initially only wake a bounded HTTP raw poll. No drop-in
compatibility claim is permitted until this gate passes.

The server can wrap the original body with payment/remittance data that is not
necessarily encrypted. V1 archives the exact inner encrypted Message Box body,
not a decrypted `PeerMessage` or payment wrapper. Payment acceptance and other
protocol side effects stay in the transport workflow and MUST NOT run during
history replay. Additional sensitive envelopes require a separately specified
client-side encryption format.

## Decision

Build `message-box-store` as an independent, modular encrypted-history
package with two cooperating but separately deployable halves:

1. **Client/archive worker.** A browser- or Node-compatible worker wraps a
   `@bsv/message-box-client` instance (or a compatible transport interface). It
   archives opaque envelopes, retrieves durable pages, merges them into a local
   wallet-owned cache, and controls Message Box acknowledgement ordering.
2. **History service.** An optional Express/Node adapter exposes authenticated
   archive and retrieval routes backed by a separate repository. The first
   reference repository is a Knex relational adapter compatible with MySQL 8;
   a repository interface keeps other databases possible without changing the
   protocol.

The package is a sibling, not an extension branch of Message Box Server. A host
may import its route adapter into the same Express process or deploy a separate
service. It must not import Message Box Server's private tables, write directly
to its database, or require a Message Box server fork. The two services may
share an operator-managed database cluster only with distinct schema/database
names and credentials.

### Data-flow invariants

```text
Message Box transport                         Durable history
----------------------                       ----------------
send/list/live/ack                            archive/list/sync/delete
temporary queue                              independent retention
ack deletes envelope                         tombstones preserve convergence
server sees opaque body                      server stores opaque ciphertext
```

The following invariants are normative for the first implementation:

- **Ciphertext-only server boundary.** The store accepts the encrypted body as
  an opaque UTF-8/byte payload and routing metadata needed for retrieval. It
  never accepts a private key, asks the wallet to decrypt, or logs plaintext.
  The server still sees identity keys, sender/recipient, box name, timestamps,
  sizes, stable IDs, and access patterns; metadata privacy is not promised.
- **Authenticated owner partition.** Every store request uses BRC-103/BRC-104
  identity authentication compatible with `AuthFetch` and
  `@bsv/auth-express-middleware`. The verified identity from the auth session,
  not a request body claim, selects the owner partition. A wallet identity can
  retrieve its own history from any device holding the corresponding key; it
  cannot read another identity's rows.
- **Immutable content, explicit metadata updates.** A stable record's
  ciphertext, hash, sender, recipient, box, and message ID are immutable. A
  retry with the same stable key and identical content is an idempotent success;
  a retry with different content is a conflict and is quarantined/reported,
  never silently overwritten.
- **Archive before acknowledge.** For an inbound Message Box envelope, the
  worker commits the durable archive record and receives a successful store
  response before calling Message Box `acknowledgeMessage`. If archival fails,
  the transport message remains pending and can be retried. A local durable
  cache may be written as an optimization but is not sufficient for the
  acknowledgement gate unless the application explicitly chooses local-only
  durability.
- **At-least-once delivery, exactly-once materialization.** Network retries,
  multiple devices, multiple advertised Message Box hosts, and crash recovery
  are expected. The store's unique key and content hash make materialization
  idempotent; the system does not claim exactly-once network delivery.
- **No implicit sent history.** Message Box stores a recipient's queue, not a
  sender's outbox. The sender integration must archive its final encrypted
  outbound envelope explicitly. A convenience wrapper should archive before
  sending and mark delivery accepted after `sendMessage` succeeds, preserving
  crash recovery without pretending an unaccepted send was delivered.
- **No plaintext merge.** Devices merge opaque records and tombstones by stable
  identifiers and monotonic change cursors. Decryption, conversation grouping,
  read state, and UI rendering remain client responsibilities.

## Proposed record identity and deduplication

The transport's `messageId` is usually a wallet HMAC and is globally unique in
the current server table. It is not safe to assume every future Message Box
implementation preserves that scope, and the current client HMAC input does
not include the message-box name. Therefore the durable store uses an explicit
canonical `recordKey`:

```text
recordKey = SHA-256(
  domain || ownerIdentityKey || direction || messageBox || sender || recipient || messageId
)
```

For v1, `domain` is `message-box-store:record:v1`; each field has an unsigned
32-bit big-endian UTF-8 byte-length prefix. Keys use validated compressed
lowercase hex; direction uses its literal string; box and message ID use exact
transport strings without Unicode normalization. The server recomputes the
key. `recordKey` is an implementation key, not a secret
and not a replacement for the original `messageId`.

The record stores `bodyHash = SHA-256(UTF8(body))`, lowercase hex. `body` is
the exact original encrypted-body string, with no parse/reserialize or Unicode
replacement; invalid Unicode is rejected. JSON wire escaping is decoded before
hashing. V1 validates a supported `encryptedMessage` envelope and rejects
plaintext transport mode; structure cannot prove encryption by a malicious
uploader. Cross-language vectors freeze these encodings before implementation.
For one `(ownerIdentityKey, recordKey)`:

- same hash and same immutable metadata → return `alreadyPresent: true`;
- different hash or immutable metadata → return a conflict, retain neither
  replacement nor a second record under the same key, and emit a security/data
  integrity event;
- same `messageId` in different boxes or directions → distinct record keys,
  unless the client supplies an application-level alias linking them.

This handles duplicate polling, duplicate overlay hosts, retry after a timeout,
two devices archiving the same envelope, and a client crash between archive and
ack. A future protocol may provide a signed sender message ID; the store can
accept it as an additional immutable field without changing this key scheme.

The default client HMAC is content-derived, not a unique send-event ID.
Repeated plaintext can reuse an ID while fresh encryption changes the bytes.
A new logical send MUST use a fresh explicit transport ID; retries MUST reuse
the persisted ID and exact ciphertext. Existing same-ID/different-body records
remain conflicts. Host URLs and receipt timestamps are observations, not
immutable identity, and MUST NOT cause conflicts across transport hosts.

## Proposed record and change model

The logical record is:

```ts
interface OpaqueMessageRecord {
  recordKey: string                 // SHA-256 canonical key, lowercase hex
  ownerIdentityKey: string          // derived from authenticated session
  messageId: string                 // original Message Box ID
  messageBox: string
  direction: 'inbound' | 'outbound'
  sender: string
  recipient: string
  body: string                      // exact inner encrypted Message Box body
  bodyHash: string                  // SHA-256 of canonical body bytes
  createdAt: string                 // server-assigned first archive time
  archivedAt: string                // first durable archive time
  deliveryState?: 'prepared' | 'unknown' | 'accepted' | 'failed' | 'received'
  expiresAt?: string | null
}
```

`ownerIdentityKey` is response metadata and may be omitted from a client-facing
record because it is already implied by the authenticated caller. The body
preserves the original `encryptedMessage` wrapper. Optional source timestamps
are untrusted observations and do not determine retention or sync ordering.

Every committed mutation creates an owner-scoped monotonic `changeSequence`
in one append-only change log, including state changes and deletions. Allocation
under the owner lock and commit are atomic; a later sequence cannot become
visible before an earlier transaction commits. Sequences are unsigned 64-bit
decimal strings, never JavaScript numbers. Idempotent retries allocate no event.
Events preserve the version they describe, not a pointer to mutable latest state.
A client stores:

- durable records keyed by `recordKey`;
- its last acknowledged change cursor;
- the server `watermark` observed at the beginning of a sync; and
- tombstones not yet applied locally.

Deletion immediately removes bodies from live retrieval and bounded cleanup
physically purges them. Minimal tombstones survive the grace period without
retaining ciphertext. A cursor older than the change window returns a typed
`ERR_CURSOR_EXPIRED` response so the client performs a bounded full resync rather
than silently presenting an incomplete history.

## Convergence and pagination

Offset pagination applies only to Message Box. Browse views use
`(createdAt, recordKey)`; authoritative sync uses `changeSequence`. Browse pages
do not establish replica completeness. A sync page contains:

```ts
interface HistoryPage<T> {
  records: T[]
  nextCursor: string | null
  checkpoint: string              // usable even on empty/final pages
  hasMore: boolean
  watermark: string
  epoch: string
  serverTime: string
}
```

The sync algorithm is:

1. With a complete local snapshot, request changes after checkpoint C and
   capture committed watermark W; all continuations are restricted to `(C,W]`.
2. Apply each immutable record idempotently by `recordKey`.
3. Apply tombstones only when their sequence is newer than the local version.
4. Continue with `nextCursor` until `hasMore` is false.
5. Persist the checkpoint atomically with each local apply batch. The final
   checkpoint represents W even on an empty page.
6. For an empty/partial cache or expired cursor, stage a complete snapshot at W.
   Only after all pages succeed, atomically reconcile the covered partition:
   remove cached records absent from the snapshot, install staged rows and W,
   then apply changes after W. Keep unsent local drafts separate. Interrupted
   snapshots must not prune the existing replica.

Snapshot membership and versions MUST remain stable at W through retained
versions or bounded materialization; filtering mutable rows by `sequence <= W`
is insufficient. Snapshot expiry requires restart; privacy deletion may
invalidate snapshots instead of continuing to serve deleted bodies. Cursors
are integrity-protected and bound to owner, epoch, feed, filters, W, position,
and expiry. Tampered cursors are invalid-input errors, not expired cursors.
Filtered caches track coverage/checkpoints separately. Response-byte limits
include JSON overhead: every allowed record must fit a page or yield a typed
error, never an empty continuation loop.

Concurrent devices can upload the same record in any order. A device that has
only a partial local history fills older pages using the cursor; it does not
use timestamps alone, because equal timestamps and clock skew can skip rows.
New writes after the watermark are fetched on the next incremental pass.

Conversation IDs are not in the Message Box transport contract. The first
release therefore treats `messageBox` plus participants as a retrieval filter
and leaves client-side conversation grouping to the application. A future
application-defined `threadKey` can be stored as authenticated metadata only
when its trust and privacy semantics are specified.

## Proposed service API

The exact route names remain subject to the PRD implementation gate, but the
first version should have a versioned, narrow API:

| Route | Purpose | Key rules |
| --- | --- | --- |
| `POST /v1/history/records` | Idempotent archive batch | Owner from auth; bounded records/bytes; immutable conflict detection; returns per-record status and current watermark |
| `GET /v1/history/records` | Read a bounded history page | Cursor, optional box/direction/participant filters, maximum page/response bytes, no cross-owner query |
| `GET /v1/history/changes` | Incremental/tombstone feed | Cursor and watermark; typed cursor expiry; stable sequence order |
| `POST /v1/history/records/state` | Outbound delivery observations | Idempotency key and expected revision; immutable content unchanged |
| `POST /v1/history/records/tombstones` | User-authorized deletion | Idempotent, owner scoped, records tombstone before purge |
| `POST /v1/history/records/retention` | Optional owner retention choice | Only within operator bounds; not required for MVP if policy is operator-only |
| `GET /v1/history/capabilities` | Limits and protocol version | Authenticated; publishes effective quotas, page bounds, retention, and supported features |
| `GET /healthz` / `GET /ready` | Liveness/readiness | Public liveness; readiness must not disclose dependency details |

The archive batch endpoint is deliberately not a Message Box acknowledgement
proxy. The client controls acknowledgement and can only invoke it after a
successful archive commit. An optional client worker can expose a convenience
`archiveAndAcknowledge()` method that performs the two calls in that order.

Error classes must be stable enough for retry logic: authentication failure,
owner mismatch, validation/size error, quota exceeded, immutable conflict,
cursor expired, rate limited, transient store unavailable, and internal error.
Responses must not echo plaintext or full credentials.

Outbound state starts `prepared`; uncertain results become `unknown`.
`accepted` means transport acceptance, not delivery/decryption. Only definitive
rejection is `failed`. Retries reuse persisted ID/body. Compare-and-set revisions
prevent stale devices downgrading `accepted`; deletion dominates state updates.
The server returns `ERR_DUPLICATE_MESSAGE`, not idempotent send success, and
may accept the ID again after acknowledgement. Duplicate/timeout alone does not
prove exact-body acceptance; there is no sender receipt query. Preserve unknown
outcomes unless evidence establishes acceptance. Automatic paid retries or
reconstructed payment actions are forbidden. M0 must prove a compatible attempt
policy; archive idempotence does not imply transport/payment idempotence.

## Authentication and authorization

The server adapter uses the same BRC-103/BRC-104 header family and wallet
authentication middleware used by Message Box Server. `AuthFetch` or a
compatible signed HTTP client is the intended client path. Authorization is
simple by design:

- the verified identity key is the only owner selector;
- all records, changes, tombstones, quotas, and cursors are owner-scoped;
- a request body `ownerIdentityKey` is ignored or rejected;
- administrative operators receive separate, explicit operational access and
  must not be treated as wallet owners;
- there is no server-side decryption role and no “support” endpoint that
  returns plaintext.

Inbound recipient and outbound sender MUST equal the authenticated owner;
self-send may have both views. This does not prove the claimed peer. Verify
signed method/path/query/body and middleware replay/session rules with negative
tests; merely using the same headers is insufficient. Use TLS and explicit
server identity policy. CORS must support configured wallet-auth headers and
cross-origin consumers; it does not replace authorization.

The store does not authenticate the original sender independently of the
Message Box envelope. An authenticated owner can archive arbitrary ciphertext
or metadata under its own identity. That is expected; content authenticity is
an application/wallet concern, while store integrity is enforced by immutable
conflict checks.

## Persistence and resource controls

The reference adapter should use Knex migrations and MySQL 8 because those are
familiar to Message Box Server operators. SQLite is useful for deterministic
unit tests and local development. The repository interface must allow a future
PostgreSQL or object-backed adapter without changing the HTTP contract.

The logical tables are:

- `history_records`: owner, record key, transport metadata, body, body hash,
  direction/state, timestamps, expiry, and current change sequence;
- `history_tombstones`: owner, record key, deletion reason/time, sequence, and
  tombstone expiry;
- `history_owner_state`: owner-scoped sequence allocator, usage counters, and
  cursor/retention policy state;
- `history_changes`: versioned upsert/state/delete events and bounded snapshot
  support; latest rows alone cannot serve fixed-watermark sync;
- `history_resource_locks`: stable owner locks for atomic quota accounting;
- optional `history_audit_events`: bounded operational/security events without
  body contents.

Required indexes include:

```text
UNIQUE(owner_identity_key, record_key)
(owner_identity_key, change_sequence, record_key)
(owner_identity_key, message_box, created_at, record_key)
(owner_identity_key, direction, created_at, record_key)
(owner_identity_key, expires_at, record_key)
(owner_identity_key, tombstone_sequence, record_key)
```

An implementation may hash identity keys or use binary storage for index size,
but it must preserve collision-safe comparison and a reversible display value
only where operationally required. It must not store a private key.

All batch writes acquire owner resource locks in deterministic order, calculate
projected record and byte usage, and commit data plus change sequences in one
transaction. The server rejects oversized work before materializing an
unbounded body. The initial resource profiles should be explicit and finite;
`unlimited` is an operator opt-out requiring an operational review, not a
default.

Suggested starting profiles (implementation defaults are still an unresolved
release decision):

| Profile | Records per owner | Ciphertext bytes per owner | Page / response |
| --- | ---: | ---: | ---: |
| small | 10,000 | 256 MiB | 250 / 4 MiB |
| standard | 100,000 | 1 GiB | 1,000 / 8 MiB |
| high-throughput | 1,000,000 | 16 GiB | 5,000 / 32 MiB |

The service also requires per-request record count and byte ceilings, per-
identity authenticated rate limits, bounded concurrency, database pool limits,
and optional global capacity budgets. Quota responses should include a safe
retry hint but not disclose another identity's usage. Counters must be based on
exact UTF-8 body bytes, not a client-supplied length. Record quotas and strict
metadata bounds cap per-record overhead separately. Physical budgets include
indexes, change versions, tombstones, snapshots, and backups.

The owner-state row may provide the resource lock. A bounded batch processes
items in request order under that lock and returns one outcome per input index;
valid admitted items commit together. Resolve duplicates/conflicts before quota
checks: identical retries at full quota succeed without charge. Rollback returns
no successes. Tombstoning releases live quota once; physical usage remains
charged until cleanup. Deletion stays available at full quota. Bound change-log
bytes and snapshot count/duration as well as age. Use binary/case-sensitive
identifier comparison. Test real MySQL locks, collation, rollback, and query
plans; SQLite alone is not concurrency evidence.

## Retention, deletion, and backup

History retention must be explicit. The MVP supports an operator default and
optional owner policy bounded by that default; it does not promise indefinite
retention. Expiry marks a record for deletion and emits a tombstone. Tombstones
remain for a configurable convergence grace period, then are purged. A hard
delete request follows the same tombstone path. A “delete all” operation is
owner-authenticated, idempotent, rate-limited, and produces an audit event
without retaining message content.

Backups are an operator responsibility but are part of the product contract:

- database backups are encrypted at rest and access-controlled;
- backups contain ciphertext plus sensitive routing metadata, never wallet
  private keys or plaintext from the supported API;
- any restore that may roll state back creates a fresh externally managed
  recovery epoch; preserving an old sequence counter alone is insufficient;
- backup and restore drills verify that a second device can retrieve and
  decrypt after a simulated local-cache loss;
- logs, metrics, traces, and support exports redact bodies, auth signatures,
  payment material, and complete device tokens.

Deleting a record from the live database does not prove removal from encrypted
operator backups; retention and legal/privacy documentation must state the
backup window.

Re-upload during tombstone retention returns `deleted` without resurrection.
After compaction, stale devices must resync before upload and MUST NOT blindly
backfill caches. Permanent suppression after that window is not promised:
explicit historical imports can reintroduce purged keys. Delete-all increments
an owner generation, invalidating old cursors and in-flight upload tokens.
Deletion receipts outside the restored backup must be reapplied before serving
it, or the operator must document the inability to prevent restored deleted
data. Epoch changes signal possible loss, not recovery of post-backup writes.
All devices must adopt archive-before-ack: an old device can delete transport
messages before capture, and transport retention still expires pending messages
during long archive outages.

## Threat model

Protected assets and assumptions:

- plaintext message content and wallet keys remain on trusted client devices;
- the store protects cross-identity authorization, record integrity, and
  resource fairness;
- BRC-103 signing and wallet encryption are trusted according to their sibling
  package contracts.

In scope:

- database compromise reveals ciphertext and metadata but should not reveal
  plaintext without wallet keys;
- a malicious authenticated client attempts quota exhaustion, replay, body
  inflation, cursor abuse, or cross-owner access;
- duplicate or conflicting uploads from retries, multiple devices, or
  multiple Message Box hosts;
- a crash occurs after archive commit and before transport acknowledgement;
- a cursor or tombstone gap would otherwise produce a silently incomplete
  local history;
- an operator accidentally exposes diagnostics, backups, or logs.

Controls are authenticated owner partitioning, immutable hashes, bounded
request/response sizes, idempotent writes, typed cursors, tombstones, rate and
concurrency limits, strict log redaction, encrypted backups, readiness gates,
and negative cross-identity tests.

Not promised in v1:

- hiding identity keys, participant keys, box names, timestamps, sizes, or
  access patterns from the storage operator;
- recovery after the wallet identity/private key is permanently lost;
- authenticity of an arbitrary sender field supplied by an owner;
- protection from a compromised client that already holds decryption keys;
- globally ordered conversations across identities or a server-side plaintext
  search index.

## Packaging and ts-stack synergy

The project follows the public messaging package shape while remaining
independently publishable; later upstream adoption remains possible:

- TypeScript ESM source with `mod.ts`, `src/`, strict typecheck, Oxlint,
  Prettier, Jest/property tests, `tsdown`, ESM and CommonJS declarations, and
  a browser-safe client artifact;
- root exports for shared types and client functions, plus explicit subpath
  exports for server/Knex code; no accidental server dependency in browsers;
- `@bsv/sdk` as a peer dependency, `@bsv/message-box-client` as an optional or
  peer integration dependency, and `@bsv/auth-express-middleware`/`express`/
  `knex`/database drivers only in the server path;
- package README, CHANGELOG, license/third-party notices, packed-consumer
  checks, browser bundle checks, and SemVer release notes;
- Node 22+ for client-compatible code and Node 24+ for the first reference
  server runtime, matching the surveyed sister packages/services;
- no imports from consumer applications and no assumptions about their routes,
  databases, UI, or wallet storage.

The eventual package can be transplanted by copying this project folder and
installing its declared dependencies. The relative links in this planning
folder are survey evidence only, never runtime imports.

Subpath exports isolate bundles, not npm installation automatically: server
dependencies must use optional peers or a separately published server artifact
if browser consumers must avoid installing them. Freeze peer ranges from the
proven adapter matrix; runtime targets are provisional until packed-consumer
tests pass. Match upstream protocol and conformance vectors without importing
monorepo-private utilities or build presets.

## Alternatives considered

### Modify Message Box acknowledgement to retain rows

Rejected. The current protocol and clients treat acknowledgement as deletion;
hosted services cannot be changed by a client; retaining rows in the transport
database still does not provide sent history, cursors, tombstones, per-device
merge, or a stable archive API. It would also fork a sister service's
semantics.

### Never acknowledge Message Box messages

Rejected. Messages repeat on every poll, remain subject to queue retention and
quotas, consume transport capacity, and still do not cover outgoing history or
device convergence.

### Store decrypted history on the server

Rejected. It breaks the current ciphertext-only privacy boundary, requires key
custody or a decryption service, and changes the threat model substantially.

### Use wallet storage, blockchain outputs, or browser IndexedDB as the archive

Rejected as the service source of truth. Wallet storage is for wallet state,
blockchain publication is immutable/expensive and poor for deletion, and a
single browser cache cannot survive hardware loss. A local cache remains a
useful replica and offline optimization.

### Fork Message Box Server into a durable mailbox

Rejected for v1. It couples transport retention to product history and makes
the result difficult to publish, upgrade, and use with hosted Message Box
servers. A standalone adapter can be embedded beside an unmodified server.

## Consequences

Positive:

- acknowledged transport envelopes have a durable, identity-authenticated
  home;
- two devices with the same wallet identity converge on the same opaque
  history and decrypt locally;
- retries and partial history are safe by construction;
- sent history is explicit rather than accidentally inferred from recipient
  queues;
- transport upgrades can proceed independently from history retention and
  storage migrations;
- operators can use familiar MySQL/Knex deployment and ts-stack practices.

Costs and risks:

- every client must integrate the archive worker and handle the archive/ack
  crash window;
- outgoing history requires a wrapper or explicit archive call;
- the service stores sensitive metadata and needs its own backups, quotas,
  migrations, monitoring, and security review;
- a full-history sync can be expensive, so cursors and bounded pages are
  mandatory;
- key loss remains unrecoverable, and key rotation needs an explicit migration
  story;
- the record model intentionally avoids server-side conversation semantics,
  leaving some social features to applications.

## Migration and adoption

Adoption is additive:

1. Publish shared protocol/client types and a no-op-capable archive adapter.
2. Integrate receive flow: list Message Box, archive, local decrypt, then ack.
3. Integrate send flow: archive prepared outbound envelope, send, mark accepted.
4. Run a backfill only for still-pending Message Box envelopes; acknowledged
   history cannot be recovered from Message Box and must come from an existing
   local export/backup.
5. Enable incremental cursor sync on a second device and exercise cache loss.
6. Make remote archive availability a readiness/degradation signal, not a
   silent reason to acknowledge transport messages.

No Message Box database migration is required. The store has independent
 migrations and can be rolled back by disabling its integration while leaving
 transport queues intact. The package must document how to disable archival
 without accidentally acknowledging pending messages.

## Unresolved decisions

These are deliberate gates for the implementation PRD, not hidden assumptions:

- final npm scope and whether client/server artifacts publish together or as
  sibling packages;
- whether the first server adapter is MySQL-only or ships a PostgreSQL adapter;
- exact route names, cursor encoding/signing, and content-type representation;
- public raw receive/prepared-send integration and compatible upstream version;
- wire vectors and proven attempt policy for ambiguous/paid sends;
- owner-configurable retention versus operator-only retention;
- tombstone grace duration and bounded snapshot implementation/capacity;
- metadata minimization, optional padding, and whether participant fields may
  be encrypted in a later protocol revision;
- identity key rotation, aliases, and recovery/import semantics;
- whether applications need a first-class `threadKey` and read-state model;
- billing/monetization, if archive storage becomes a public hosted service;
- whether Message Box overlay discovery should advertise a separate store host.
