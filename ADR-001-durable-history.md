# ADR-001: Durable encrypted history beside Message Box

- **Status:** Accepted v1 architecture; M0-M3 implemented as a private
  evaluation checkpoint, M4 open
- **Date:** 2026-09-20
- **Decision owners:** message-box-store maintainers
- **Scope:** One independently publishable package, initially operated as a
  private service for archiving and retrieving encrypted Message Box envelopes
  across devices
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

## Implementation alignment checkpoint

The M1-M3 code now reflects the architecture through canonical opaque records,
versioned schemas and migrations, bounded quotas, memory/SQLite/MySQL
repositories, stable snapshots, fixed-watermark changes, body-free deletion
fences, authenticated routes, archive/send operations, a convergent replica
contract, a polling worker, and browser-safe typed exports. These mechanisms
exist to make a best-effort encrypted history copy converge safely across devices.

They do not change the architectural boundary: Message Box remains transport;
the wallet remains the only decryption authority; the store remains optional
and operator-controlled; paid delivery, live fallback, resend recovery,
identity migration, plaintext processing, and guaranteed availability remain
outside v1. M1-M3 completion is not deployment readiness. Capacity evidence,
restore drills, security review, and publication remain M4 gates.

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

See the source baseline in [`README.md`](./README.md) and the accepted v1
contracts in [`docs/M0-DECISIONS.md`](./docs/M0-DECISIONS.md). Those documents
pin the current sibling resource profile and distinguish starting values from
capacity-tested store limits.

### Integration feasibility finding

The client does not expose a separate prepare-and-send-encrypted pair or a raw
receive hook. Its public `sendMessage` parameters do include
`skipEncryption: true`, so a caller can prepare the final body exactly once
with the public wallet `encrypt` method and send that unchanged body and an
explicit `messageId` through the normal authenticated HTTP method. The public
`AuthFetch` property can retrieve raw `/listMessages` pages; `listMessages`,
`listMessagesLite`, and live callbacks decrypt before returning and are not raw
archive sources. `listMessages` also accepts payments by default.

M0 proves this composition for the pinned `@bsv/message-box-client` 2.5.1
without private methods, monkey patches, or request interception. The
`createFreeOnlyMessageBoxClient` constructs that public client with a
payment-disabled WalletInterface and returns only identity, raw-list, and
acknowledgement operations. It exposes no direct send, wallet, AuthFetch, or
raw client. Module-private WeakMap state supplies the transport only to the
branded one-shot capability and binds it to the guarded client's public wallet
identity. Any compatibility owner argument must equal that identity before
attempt reservation or network activity. Outbound input is fixed to the primary origin;
`trustedHosts` authorize only exact POST `/listMessages` and POST
`/acknowledgeMessage` operations. Generic AuthFetch and guarded-wallet helpers
are not package-root exports. Configured
production origins use HTTPS and contain no credentials or path. The explicit
`allowLoopbackHttpForTests` option permits test HTTP only for exact `localhost`,
strict dotted-decimal IPv4 in `127.0.0.0/8`, or IPv6 `::1`.

SDK 2.7.1 `AuthFetch` constructs `SimplifiedFetchTransport` internally and
provides no public custom-transport or fetch option. Its default fetch follows
redirects. V1 accepts that upstream behavior because strict refusal would
require a private-field change, SDK fork, or global fetch replacement. The
package validates the initial configured HTTPS origin and route. It does not
claim redirect containment. Strict refusal can be added after upstream provides
a supported hook or a reviewed compatible upgrade.

The outbound integration makes one application-level public HTTP
`sendMessage` invocation after persisting the prepared envelope, always with
`checkPermissions: false`; explicit paid requests are rejected before attempt
reservation or transport. It must not expose or call `sendLiveMessage`. SDK
`AuthFetch` may perform internal HTTP exchanges while recovering a stale
BRC-103 session, so this is not a one-physical-request guarantee. The free-only
guard blocks the BRC-105 payment path and paid retry after HTTP 402. The adapter
also owns authenticated raw HTTP polling and acknowledges each source host
only after durable archival. AuthSocket live callbacks are inbound wake-up/UX
notifications; they expose decrypted content, so archive capture follows with
raw HTTP polling. This is a supported adapter composition, not a drop-in
archive integration.

### M0 proof update (2026-09-20)

The standalone `docs/M0-INTEROP-EVIDENCE.md` and M0 tests demonstrate the
public HTTP candidate against `@bsv/message-box-client` 2.5.1 and the
authenticated local route fixture. Public wallet encryption is performed once
with `[1, "messagebox"]`/`"1"` and the recipient counterparty; the exact
`{ encryptedMessage: base64 }` body is persisted with an explicit ID and sent
to public HTTP `sendMessage` with `skipEncryption: true`. The M0 policy helper
accepts only a narrow HTTP capability, reserves the canonical outbound key
before sending, and does not invoke a second transport call after a timeout or
on a repeated/concurrent request. Raw polling uses public `AuthFetch`; the same
identity on a second device decrypts outbound history. Inbound live callbacks
return decrypted notifications, while authenticated raw HTTP returns the
archiveable envelope; the receiver archives that body before acknowledging the
source host.

M0 also executes authenticated HTTP 402 challenges through outbound send, raw
list, acknowledgement, and a test-only future history-capabilities route using
an internal AuthFetch characterization helper. At SDK 2.7.1, AuthFetch
uses a BRC-105 derived `getPublicKey` and then `createAction` before a paid retry
with `x-bsv-payment`; the guarded WalletInterface blocks the payment-derived
key and all wallet action methods, rejects caller-provided payment contexts
and payment headers, and returns `ERR_PAID_TRANSPORT_UNSUPPORTED` before a
paid retry. The shared `[2, "server hmac"]` nonce operation is forwarded
because ordinary BRC-103 authentication uses the same wallet HMAC. In the
fresh-session local fixture, each operation sends one initial authenticated
request and observes no wallet transaction action, payment output, or paid
retry. The SDK may make internal authenticated recovery exchanges when a
session is stale; this proof does not claim one physical request in every
session state. An initial request is still sent to the configured host, so
fee-requiring hosts remain unsupported. The
simulated history-capabilities route is only a local AuthFetch fixture; no
production history route exists in M0.

The reason for excluding outbound `sendLiveMessage` is measured against
2.5.1, not inferred from the method name. The client sends over AuthSocket,
then automatically calls HTTP `sendMessage` after a negative acknowledgement,
a disconnected socket, or a 10-second acknowledgement timeout. It forwards
the same ID/body and `checkPermissions` flag. If the live server already
accepted the envelope but the acknowledgement is lost, fallback makes a
second transport attempt. Same-ID duplicate detection is not transport
idempotence. Local fixtures reproduce this ordering without broadcasting or
spending. Therefore v1 outbound code must not call `sendLiveMessage`.

V1 outbound states use the same definitions in the helper, tests, and this
contract. `attempted` is true only after the helper invokes the module-private
transport behind the opaque capability once; it is false for preflight, reservation,
conflict, and already-claimed outcomes. This is one application-level send
invocation, not a count of physical HTTP exchanges: SDK 2.7.1 `AuthFetch` can
internally repeat an authenticated request during stale-session recovery. The
helper makes no one-physical-request or exactly-once delivery claim. It never
calls `sendLiveMessage`, so the Socket.IO-to-HTTP fallback is absent, and the
free-only guard prevents a BRC-105 paid retry.

`statePersisted` is true only when the attempt-store read or write confirms the
state returned by the helper. It is false when no state write is made or a
reservation/state write is not confirmed; false does not prove that an
unacknowledged storage write did not commit. If a process or lost store
response leaves a `prepared` record, recovery reports `unknown` and blocks
another send. A matching success response records `accepted`. A pre-send
`failed` result means the helper did not invoke the application-level send:
policy/validation rejection, immutable conflict, or missing/failed reservation
all stop before dispatch. If a reservation write is unconfirmed,
`statePersisted` is false; a later read that finds `prepared` reports `unknown`
and blocks another send. The other allowed `failed` case is the typed
`ERR_PAID_TRANSPORT_UNSUPPORTED` emitted by the guarded BRC-105 payment-key
path after an HTTP 402. For that typed 402, the initial request was attempted,
but the guard proves no payment key, wallet action, or paid retry occurred; the
result is therefore a deterministic non-spending `failed` state with
`attempted: true`. Any other thrown error, malformed response, or unrecognized
post-invocation response is `unknown`, even if its cause might have been
pre-transport. No prepared/unknown attempt is automatically resent, and M0
exposes no recovery operation.

The accepted v1 policy is free-only. `checkPermissions: true` is rejected
before the attempt store or upstream client is called. Supported sends always
pass `checkPermissions: false`. Positive-quote and live-fallback fixtures are
upstream characterization only; they are not supported store capabilities or
release criteria. See the evidence matrix in
[`docs/M0-INTEROP-EVIDENCE.md`](./docs/M0-INTEROP-EVIDENCE.md).

One related public-client behavior must be handled explicitly: `@bsv/sdk`
2.7.1 `AuthFetch` automatically attempts BRC-105 payment construction after
any HTTP 402. The MessageBoxClient `checkPermissions` precheck does not disable
that behavior. The public guard is now implemented and proven locally; every
v1 worker and service route must be constructed through these factories. A
future upstream no-payment switch may replace the adapter only after equivalent
source review and tests. This does not authorize paid delivery.

The server can wrap the original body with payment/remittance data that is not
necessarily encrypted. V1 archives the exact inner encrypted Message Box body,
not a decrypted `PeerMessage` or payment wrapper. V1's store APIs do not accept
paid envelopes or run payment acceptance during history replay.

## Decision

Build `message-box-store` as one independently publishable package, initially
operated as a private service. It contains two cooperating halves with
separate public exports:

1. **Client/archive worker.** A browser- or Node-compatible worker wraps a
   `@bsv/message-box-client` instance (or a compatible transport interface). It
   archives opaque envelopes, retrieves durable pages, merges them into a local
   wallet-owned cache, and controls Message Box acknowledgement ordering.
2. **History service.** An optional Express/Node adapter exposes authenticated
   archive and retrieval routes backed by a separate repository. The first
   reference repository is a Knex relational adapter compatible with MySQL 8;
   a repository interface keeps other databases possible without changing the
   protocol.

The package is a sibling, not an extension branch of Message Box Server. The
initial deployment is a private service; a later public package can be
adapted by other applications. It must not import Message Box Server's private
tables, write directly to its database, or require a Message Box server fork.
The two services may share an operator-managed database cluster only with
distinct schema/database names and credentials. Package licensing and npm
registry ownership remain M4 publication gates; this decision does not publish
or deploy anything.

### Data-flow invariants

```text
Message Box transport                         Durable history
----------------------                       ----------------
send/list/live/ack                            archive/list/sync/delete
temporary queue                              independent retention
ack deletes envelope                         bounded delete events converge replicas
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
  idempotent for archive writes. This does not apply to outbound transport
  sends: v1 allows one application-level `sendMessage` invocation per logical outbound record and
  does not claim exactly-once network delivery.
- **Outbound at-most-once attempt.** The sender persists the immutable
  `prepared` record and exact body before one application-level public HTTP
  `sendMessage` invocation with explicit `messageId` and
  `skipEncryption: true`. AuthFetch may perform internal stale-session
  recovery exchanges; this policy does not claim one physical request. Outbound
  `sendLiveMessage` is prohibited because its automatic HTTP fallback can
  repeat an already accepted send. The v1 path is free-only, always passes
  `checkPermissions: false`, and rejects explicit paid mode before reserving
  the attempt. The public WalletInterface guard blocks upstream AuthFetch's
  BRC-105 payment path after HTTP 402. Ambiguous
  outcomes remain `unknown`; an existing `prepared`/`unknown` record key blocks
  another send. A guarded typed 402 is deterministically `failed` after that
  application-level invocation because no BRC-105 action or paid retry occurs;
  other ambiguous outcomes remain `unknown`. No automated recovery or resend
  path is included in v1.
- **No implicit sent history.** Message Box stores a recipient's queue, not a
  sender's outbox. The sender integration must archive its final encrypted
  outbound envelope explicitly. A wrapper archives before its one
  application-level public HTTP send invocation and marks delivery accepted only after a matching success
  response. An ambiguous result is not resent by the wrapper. A fee-requiring
  host is unsupported; the service must not create or accept a BRC-105 payment.
- **No plaintext merge.** Devices merge opaque records and minimal delete
  events by stable identifiers and monotonic change cursors. Decryption, conversation grouping,
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
A new logical send MUST use a fresh explicit transport ID. V1 does not resend
an outbound record whose attempt was prepared, accepted, or became unknown. Any
future, separately approved manual recovery must use the persisted ID and exact
ciphertext and account for the target host's duplicate-after-ack behavior.
Existing same-ID/different-body records remain conflicts. Host URLs and receipt
timestamps are observations, not immutable record identity; the outbound
attempt state pins its selected host separately.

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
in a bounded change feed, including state changes and deletions. Allocation
under the owner lock and commit are atomic; a later sequence cannot become
visible before an earlier transaction commits. Sequences are unsigned 64-bit
decimal strings, never JavaScript numbers. Idempotent retries allocate no event.
Upsert/state events preserve the version they describe for a fixed-watermark
snapshot. A delete event contains only the record key, sequence, and time, never
the ciphertext or a body-bearing tombstone. The initial change-feed retention
window is 30 days. A client stores:

- durable records keyed by `recordKey`;
- its last acknowledged change cursor;
- the server `watermark` observed at the beginning of a sync; and
- delete events not yet applied locally.

Owner deletion immediately removes bodies from live retrieval, releases quota
in the same transaction, and emits only the bounded delete event. There are no
ciphertext tombstones. A cursor older than the change window returns a typed
`ERR_CURSOR_EXPIRED`; the client stages a complete snapshot, removes local
records absent from it, then resumes incremental sync rather than silently
presenting an incomplete history. Backup restore rotates the owner epoch and
requires post-backup deletions to be reapplied before serving, or fails closed.

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

1. With a complete local snapshot, start a new changes pass using paired
   `afterSequence=C` and `epoch=<snapshot epoch>` query parameters. Capture
   committed watermark W; all opaque-cursor continuations are restricted to
   `(C,W]`. A later terminal checkpoint starts the next pass the same way.
2. Apply each immutable record idempotently by `recordKey`.
3. Apply upserts and delete events in sequence order; delete events remove local
   rows and carry no message body.
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
The explicit checkpoint pair is mutually exclusive with a cursor. It is a
position claim, not a client-mintable cursor or completeness proof. The server
validates canonical uint64 shape, current epoch, `C <= W`, and retained-range
continuity even when `C` is `0`; any retained prefix, internal, or tail gap
requires a complete snapshot. Filtered caches track coverage/checkpoints
separately. Response-byte limits
include JSON overhead: every allowed record must fit a page or yield a typed
error, never an empty continuation loop.

Auxiliary storage has separate physical admission limits. Each owner may hold
at most 32 snapshot anchors and 40,000 materialized membership rows, counting
expired or invalidated rows until they are physically purged. A new snapshot
that exceeds either limit fails atomically with `ERR_QUOTA_EXCEEDED` (HTTP 409);
an existing snapshot and its cursor remain valid until their ordinary expiry or
invalidation. The default cleanup interval is five minutes and each pass can
remove at most 5,000 snapshot items: at the per-owner membership limit, eight
successful passes drain those items when no other owners compete for the global
cleanup budget. Operators who lengthen the interval or share the budget across
many owners must provision cleanup throughput accordingly.

Idempotency results are retained for 24 hours from creation, up to 1,024 rows
per owner. Exact replays within that window return the original result even
when capacity is full. New keys at capacity fail before the mutation with
`ERR_QUOTA_EXCEEDED` (HTTP 409). Expired rows are deleted on the next keyed
mutation; after expiry the same key is a new request and must meet current CAS
and epoch checks. Immutable-conflict forensic events retain the newest 200
rows per owner on all adapters. Physical storage metrics include idempotency
and audit row counts as well as snapshot anchors and members.

Concurrent devices can upload the same record in any order. A device that has
only a partial local history fills older pages using the cursor; it does not
use timestamps alone, because equal timestamps and clock skew can skip rows.
New writes after the watermark are fetched on the next incremental pass.

Conversation IDs are not in the Message Box transport contract. The first
release therefore treats `messageBox` plus participants as retrieval filters
and leaves grouping to the application. V1 has no canonical conversation ID,
thread ID, or thread-key field.

## V1 service API

The route names and meanings are fixed for v1:

| Route | Purpose | Key rules |
| --- | --- | --- |
| `POST /v1/history/records` | Idempotent archive batch | Owner from auth; bounded records/bytes; immutable conflict detection; current epoch required |
| `GET /v1/history/snapshot` | Bounded full snapshot pages | Keyset page at a fixed watermark; absent-row reconciliation only after all pages succeed |
| `GET /v1/history/changes` | Incremental record/delete feed | Cursor and watermark; typed cursor expiry; stable sequence order |
| `PATCH /v1/history/records/{recordKey}/state` | Outbound delivery observations | Idempotency and expected revision; immutable content unchanged |
| `DELETE /v1/history/records/{recordKey}` | User-authorized deletion | Purges body/releases quota and appends minimal bounded delete event atomically |
| `DELETE /v1/history/records` | Delete all owner history | Idempotent owner scope; rotates epoch and invalidates old cursors/writes |
| `GET /v1/history/capabilities` | Limits and protocol version | Authenticated; publishes effective quotas, page bounds, retention, epoch and supported features |
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
`accepted` means transport acceptance, not delivery/decryption. A pre-send
`failed` result means the helper did not invoke the application-level send
(policy/validation rejection, immutable conflict, or unavailable/failed
reservation). The only `failed` result after invocation is the typed HTTP 402
refusal from the free-only BRC-105 guard, which proves there was no payment
action or paid retry. `attempted` records whether the helper invoked the
guarded public capability, not the number of AuthFetch's internal physical
HTTP exchanges. `statePersisted` is true only when the attempt store confirms
the returned state; false leaves storage outcome unconfirmed, including a
reservation write whose acknowledgement may have been lost. The v1 worker
never retries a prepared/unknown attempt; any future recovery must be a
separate explicit operation. Compare-and-set revisions prevent stale devices
downgrading `accepted`; deletion dominates state updates. The server returns
`ERR_DUPLICATE_MESSAGE`, not idempotent send success, and may accept the ID
again after acknowledgement. Duplicate/timeout alone does not prove exact-body
acceptance; there is no sender receipt query. Automatic paid retries or
reconstructed payment actions are forbidden. Archive idempotence does not
imply transport/payment idempotence.

## Authentication and authorization

The server adapter uses the same BRC-103/BRC-104 header family and wallet
authentication middleware used by Message Box Server. `AuthFetch` or a
compatible signed HTTP client is the intended client path. Authorization is
simple by design:

- the verified identity key is the only owner selector;
- all records, change events, quotas, and cursors are owner-scoped;
- a request body `ownerIdentityKey` is ignored or rejected;
- administrative operators receive separate, explicit operational access and
  must not be treated as wallet owners;
- there is no server-side decryption role and no “support” endpoint that
  returns plaintext.

Inbound recipient and outbound sender MUST equal the authenticated owner;
self-send may have both views. This does not prove the claimed peer. Verify
signed method/path/query/body binding and session validity with negative tests;
merely using the same headers is insufficient. The pinned middleware rejects
concurrently active duplicate request IDs but does not retain completed IDs as
permanent single-use tokens. M2 therefore adds one process-local FIFO window
covering the 5,000 most recent verified application request IDs and rejects
reuse within that window. After eviction, an exact old request falls back to
upstream live-session and signature verification and may be accepted until
explicit session removal or process restart. This bounded policy and residual
risk are normative for the single-process private v1 service. Use HTTPS and an
explicitly configured store origin. The caller must not discover or silently
switch hosts; exact CORS origin configuration supports wallet-auth headers but
does not replace authorization.

The store does not authenticate the original sender independently of the
Message Box envelope. An authenticated owner can archive arbitrary ciphertext
or metadata under its own identity. That is expected; content authenticity is
an application/wallet concern, while store integrity is enforced by immutable
conflict checks.

## Persistence and resource controls

V1 uses Knex migrations and MySQL 8 in production. SQLite is the deterministic
test adapter. PostgreSQL and object-backed adapters are out of v1 scope; do not
add a portability abstraction until another adapter is authorized.

The logical tables are:

- `history_records`: owner, record key, transport metadata, body, body hash,
  direction/state, timestamps, expiry, and current change sequence;
- `history_owner_state`: owner-scoped sequence allocator, usage counters, and
  current recovery epoch;
- `history_changes`: versioned upsert/state events plus minimal delete events
  containing only owner, record key, sequence and time; bounded snapshot
  support requires retained versions rather than only latest rows;
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
(owner_identity_key, change_sequence, record_key)
```

An implementation may hash identity keys or use binary storage for index size,
but it must preserve collision-safe comparison and a reversible display value
only where operationally required. It must not store a private key.

All batch writes acquire owner resource locks in deterministic order, calculate
projected record and byte usage, and commit data plus change sequences in one
transaction. The server rejects oversized work before materializing an
unbounded body. V1's finite initial M1/M2 limits are 10,000 records and 1 GiB
exact ciphertext-body bytes per owner; 1 MiB per body; 4 MiB HTTP request; 100
records per batch; 1,000 records and 8 MiB per page/response; 300
pre-authenticated requests/minute/IP; 1,000 authenticated requests/minute/
identity; 24 concurrent requests/process; and DB pool max 7. These follow the
Message Box Server 1.1.42 standard resource profile in
`docs/M0-DECISIONS.md`; they are planning defaults, not measured capacity
promises for history storage. M2 must test the exact bounds and MySQL
accounting; the 100-record batch is adapted from the sister client's
`sendList` recipient limit, not a history API contract. Raising a limit requires
representative MySQL/memory evidence. There is no unlimited mode by default.

The service also requires per-request record count and byte ceilings, bounded
concurrency, database pool limits, and optional global capacity budgets. Quota
responses may include a safe retry hint but must not disclose another
identity's usage. Counters use exact UTF-8 body bytes, not client-supplied
lengths. Record quotas and strict metadata bounds cap per-record overhead
separately. Physical budgets include indexes, retained change versions,
snapshots, and operator backups.

The owner-state row may provide the resource lock. A bounded batch processes
items in request order under that lock and returns one outcome per input index;
valid admitted items commit together. Resolve duplicates/conflicts before quota
checks: identical retries at full quota succeed without charge. Rollback returns
no successes. Deletion immediately removes the active body and releases quota
in the same transaction; deletion remains available at full quota. Delete
events are minimal and retained for 30 days, never as ciphertext tombstones.
Bound change-feed bytes and snapshot count/duration as well as age. Use
binary/case-sensitive identifier comparison. Test real MySQL locks, collation,
rollback, and query plans; SQLite alone is not concurrency evidence.

## Retention, deletion, and backup

History retention is configured by `MESSAGE_BOX_STORE_RETENTION_DAYS`. The
only accepted and enforced value today is `permanent` (no scheduled expiry),
which is also what `GET /v1/history/capabilities` publishes: finite per-record
expiry is deliberately deferred until it is enforced through the existing
deletion primitives (quota release, minimal delete event, snapshot
invalidation), so configuration rejects finite day counts rather than
advertising an unenforced policy (`mbs-8g5.3.1.5.2`). When finite retention
ships, an integer of at least 7 becomes valid again and capabilities must
report exactly that enforced value. Permanent means only no scheduled expiry:
finite per-owner quotas still apply and operators may purge content or the
service at any time. This is best-effort storage, not a backup or availability
guarantee. Owner deletion removes active bodies and releases quota
immediately; it appends only a minimal delete event for 30 days, with no
ciphertext tombstone. An expired cursor forces a complete snapshot and removes
local records absent from that snapshot. Delete-all is owner-authenticated,
idempotent, rotates the epoch, and retains no message content in the delete
event.

Backups are an operator responsibility but are part of the product contract:

- database backups are encrypted at rest and access-controlled;
- backups contain ciphertext plus sensitive routing metadata, never wallet
  private keys or plaintext from the supported API;
- any restore that may roll state back creates a fresh recovery epoch and
  forces full reconciliation; preserving an old sequence counter alone is
  insufficient;
- backup and restore drills verify that a second device can retrieve and
  decrypt after a simulated local-cache loss;
- logs, metrics, traces, and support exports redact bodies, auth signatures,
  payment material, and complete device tokens.

Deleting a record from the active database does not prove removal from
encrypted operator backups; the operator's finite backup window must be
documented. Before serving a restored database, reapply post-backup deletions
and rotate the epoch. If deletion state is unavailable, fail closed or discard
affected history rather than risk resurrection. Epoch changes signal that
clients must reconcile; they do not recover post-backup writes.
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
- a cursor or delete-event gap would otherwise produce a silently incomplete
  local history;
- an operator accidentally exposes diagnostics, backups, or logs.

Controls are authenticated owner partitioning, immutable hashes, bounded
request/response sizes, idempotent writes, owner-bound integrity-protected
cursors, minimal delete events/full-snapshot reconciliation, rate and
concurrency limits, strict log redaction, encrypted backups, readiness gates,
and negative cross-identity tests. The threat-to-control-to-evidence matrix in
[`docs/M0-THREAT-MODEL.md`](./docs/M0-THREAT-MODEL.md) is normative.

Not promised in v1:

- hiding identity keys, participant keys, box names, timestamps, sizes, or
  access patterns from the storage operator;
- preventing an authenticated client from corrupting or deleting its own
  partition;
- recovery after the wallet identity/private key is permanently lost;
- authenticity of an arbitrary sender field supplied by an owner;
- protection from a compromised client that already holds decryption keys;
- globally ordered conversations across identities or a server-side plaintext
  search index.

## Packaging and ts-stack synergy

The project follows the public messaging package shape while remaining
independently publishable; later upstream adoption remains possible:

- frozen M0 `.mjs` interoperability/security proof fixtures, plus strict
  TypeScript public entrypoints for M1+ surfaces. Existing proven internals can
  migrate or sit behind those entrypoints incrementally; M1 does not require a
  wholesale M0 rewrite or duplicate behavioral implementations;
- `mod.ts`, explicit `src/` boundaries, strict typecheck, lint/format/property
  tests, and `tsdown` outputs for ESM, CommonJS, declarations, and a browser-safe
  client artifact, driven by documented Bun commands;
- root exports for shared types and client functions, plus explicit subpath
  exports for server/Knex code; no accidental server dependency in browsers;
- `@bsv/sdk` as a peer dependency, `@bsv/message-box-client` as an optional or
  peer integration dependency, and `@bsv/auth-express-middleware`/`express`/
  `knex`/database drivers only in the server path;
- package README, CHANGELOG, license/third-party notices, packed-consumer
  checks, browser bundle checks, and SemVer release notes;
- Node 22 is the M1 development and package-verification baseline. Node 24
  reference-server compatibility is verified in M2/M4 after the server exists;
  it is not an M1 repository or packaging gate;
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
database still does not provide sent history, cursors, delete convergence, per-device
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
- archive retries and partial-history recovery are safe by construction;
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
- identity-key loss remains unrecoverable; rotation/migration is explicitly
  unsupported in v1 and needs a separately approved future protocol;
- the record model intentionally avoids server-side conversation semantics,
  leaving some social features to applications.

## Migration and adoption

Adoption is additive:

1. Implement shared protocol/client types and a no-ack archive adapter.
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

## Resolved v1 decisions and remaining gates

The accepted product and protocol choices are in
[`docs/M0-DECISIONS.md`](./docs/M0-DECISIONS.md); they are not implementation
questions. V1 is one independently publishable package (private during
development), browser-safe client/protocol root exports, explicit server and
storage subpaths, MySQL 8/Knex production storage, SQLite tests only, explicit
HTTPS origin, free transport only, no paid routes/pricing, permanent-by-default
retention with operator purge, bounded no-ciphertext delete events, a single
identity partition without rotation, visible routing metadata, no server-side
thread ID, and no live fallback or send recovery.

M1-M3 implementation and acceptance evidence now cover the wire, repository,
authenticated-service, and convergent-client contracts, including the
M0-proven free-only factory boundary. Remaining work is evidence and release
administration, not product-policy choice: M4 proves capacity, backup/restore behavior, browser/package
exports, release documentation, and review. npm scope, license, maintainer
account and publication are M4 release-administration gates, not authority to
publish or deploy in this task.
