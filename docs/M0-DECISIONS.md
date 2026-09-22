# M0 v1 product and protocol decisions

- **Status:** accepted design for v1; M0 complete, M1 in final acceptance,
  M2-M4 not implemented
- **Decision owner:** message-box-store maintainers
- **Date:** 2026-09-20
- **Authority:** this decision record resolves the product choices that were
  previously marked open in ADR-001 and PRD sections 14–17.

This record defines what the package is intended to do. It does not authorize
publication, deployment, spending, or a guarantee that stored messages will
remain available.

## Product and package

`message-box-store` is one independently publishable TypeScript package and an
additional private MapApp service for users' encrypted Message Box history.
The same package can be adapted by other applications. Message Box remains the
temporary delivery queue; the store holds an opaque history copy.

The package has browser-safe client/protocol root exports and explicit
server/storage subpaths. Server and database dependencies must not enter the
browser artifact. The first production adapter is MySQL 8 through Knex. SQLite
is the deterministic local/test adapter. PostgreSQL and multiple npm packages
are outside v1. The repository name is `message-box-store`; registry scope,
license, and maintainer account are release administration to settle before
M4 publication. The current package remains private during development.

The M1 package and repository baseline is Node.js 22 or newer, plus browsers
supported by the tested browser-safe artifact. MySQL 8 and Knex 3.3.x are the
production persistence target; SQLite and memory are parity/test adapters.
Node.js 24 reference-service verification belongs to M2/M4 after the service
exists and is not an M1 repository gate. The broader packed consumer/browser
matrix remains an M4 release check.

The reference source baseline is `bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b`
in `ReferenceRepos/ts-stack`, inspected 2026-09-20. M0's executable client
target is `@bsv/message-box-client` 2.5.1 with `@bsv/sdk` 2.7.1,
`@bsv/auth-express-middleware` 2.2.3, and `@bsv/authsocket` 2.1.7. The sibling
Message Box Server source manifest is private version 1.1.42 and requires Node
24.x. These source versions establish conventions and safety baselines; they
are not claims about the latest published server deployment.

## Supported transport

V1 supports **free Message Box transport only**. The store has no price table,
BRC-105 payment flow, payment construction/acceptance, or payment replay.
Outbound store sends always use the prepared exact envelope with an explicit
message ID and one application-level invocation of public HTTP `sendMessage`, setting
`skipEncryption: true` and `checkPermissions: false`. The store rejects an
explicit `checkPermissions: true` request with stable code
`ERR_PAID_TRANSPORT_UNSUPPORTED` before attempt reservation or transport. A
fee-requiring Message Box host is unsupported. Outbound `sendLiveMessage` is
not used because its automatic HTTP fallback can repeat a send accepted by the
live path before its acknowledgement was lost.

The message body is encrypted once by the wallet with protocol `[1,
"messagebox"]`, key ID `"1"`, and the peer identity as counterparty. The stored
body is the exact UTF-8 JSON string `{"encryptedMessage":"<canonical
base64>"}`. Hash the exact UTF-8 bytes; do not parse and reserialize before
storage or hashing. Inbound history comes from authenticated raw HTTP polling.
Archive must commit before the client acknowledges the source Message Box
host. A live callback is only a wake-up because the public callback returns
decrypted content.

`AuthFetch` 2.7.1 automatically attempts BRC-105 payment construction after an
HTTP 402, independently of the MessageBoxClient `checkPermissions` precheck.
M0 implements and proves the supported construction boundary using only
public constructors and the public `WalletInterface`:

- `createFreeOnlyMessageBoxClient()` constructs `MessageBoxClient` with the
  guarded wallet from the start. The returned narrow facade exposes identity,
  raw list, and acknowledgement only. It exposes no send, wallet, AuthFetch,
  live-send, quote, permission, payment, or upstream-client surface. A private
  WeakMap gives only the branded outbound capability access to the transport.
  The capability also resolves and retains the guarded client's wallet
  identity; any caller owner value must match before reservation or HTTP.
  Outbound input is fixed to the primary origin; `trustedHosts` permit only exact
  POST list and acknowledgement operations.
- The generic guarded AuthFetch and payment-disabled wallet adapters are
  implementation details and are not package-root exports. The test-only HTTP option accepts exact
  `localhost`, strict four-part dotted-decimal IPv4 in `127.0.0.0/8`, or IPv6
  `::1`; DNS names with a numeric `127` prefix and alternate numeric encodings
  are rejected.
- In SDK 2.7.1, a 402 handler calls `createNonce` (which calls wallet
  `createHmac` with `[2, "server hmac"]`), derives a BRC-105 payment key using
  `getPublicKey([2, "3241645161d8"])`, calls `createAction(outputs)`, then
  retries with `x-bsv-payment`. BRC-103 authentication uses the same nonce
  HMAC, so that non-spending crypto is forwarded. The payment-specific key
  derivation and wallet transaction-action methods (`createAction`,
  `signAction`, `abortAction`, and `internalizeAction`) fail closed with
  `ERR_PAID_TRANSPORT_UNSUPPORTED`.
- The public AuthFetch facade rejects caller-supplied `paymentContext`,
  `paymentRetryAttempts`, payment labels, and `x-bsv-payment` headers before
  dispatch; it snapshots caller-owned accepted headers before AuthFetch's
  asynchronous handshake so late mutation cannot introduce that header. This
  closes the existing-payment-context path that otherwise bypasses new action
  creation. The fresh-session local authenticated 402 tests observe one
  initial request per operation, no payment header or paid retry, no underlying
  wallet action, and zero payment outputs/satoshis. SDK 2.7.1 `AuthFetch` may
  perform internal HTTP exchanges during stale BRC-103 session recovery, so
  this is not a one-physical-request guarantee.

Redirect refusal is not proven or claimed. SDK 2.7.1 `AuthFetch` internally
constructs `SimplifiedFetchTransport` and does not expose the transport's
public custom-fetch constructor argument. Its default fetch follows redirects.
V1 accepts this behavior. The package validates the initial configured HTTPS
origin and route. A configured host already receives the ciphertext and public
authentication metadata, while the service receives no plaintext, private
keys, or decryption keys. Strict redirect refusal would require a private-field
change, SDK fork, or global fetch replacement, which this project prohibits.
Reconsider strict refusal only when upstream provides a supported hook or a
reviewed compatible upgrade.

`checkPermissions: false` alone still does not make an arbitrary host
payment-free. A fee-requiring host is unsupported: its first request reaches
the host, then returns a typed non-spending failure before wallet transaction
creation or paid retry. Operators must continue to configure free hosts; the
guard is not a fee guarantee. The public package root exports the guarded
Message Box factory and one-shot policy surface, not raw upstream constructors,
generic AuthFetch/wallet adapters, or internal policy modules. No
private-field access, monkey patch, request interception, or upstream fork is
used. Re-run this proof whenever the pinned SDK or Message Box client changes.

`attempted` is true only after the helper invokes the guarded public
`sendMessage` capability, and false for a preflight, reservation, conflict, or
already-claimed result. It counts one application-level invocation, not
AuthFetch's physical HTTP exchanges. `statePersisted` is true only when the
attempt-store read or write confirms the returned state. False means storage
is unconfirmed; a write whose acknowledgement was lost may still have
committed. Any surviving `prepared` record is recovered as `unknown` and blocks
another send.

`failed` means a no-dispatch rejection before the application-level send
(policy/validation rejection, immutable conflict, unavailable/failed attempt
reservation), or the typed `ERR_PAID_TRANSPORT_UNSUPPORTED` thrown by the
guarded BRC-105 payment-key path after an HTTP 402. Pre-send `failed` does not
claim a state was durably recorded unless `statePersisted` is true; an
unconfirmed reservation may have committed, and a surviving `prepared` record
recovers as `unknown`. For the post-attempt 402 result, the initial request was
sent, but the guard proves no payment key, wallet action, or paid retry
occurred. Every other thrown error, malformed response, and unrecognized
post-attempt response is `unknown`. Ambiguous results are never automatically
resent, and v1 exposes no manual reset/recovery operation. A stable message ID
helps history de-duplication but is not a delivery receipt or general
idempotency guarantee. This is an at-most-one application-level invocation
rule, not an exactly-once or one-physical-request promise.

## Retention, quotas, and deletion

Message retention is controlled by `MESSAGE_BOX_STORE_RETENTION_DAYS`. The
only accepted value is `permanent` (no scheduled expiry); finite day counts
are rejected until finite active-record retention is enforced end to end, and
`GET /v1/history/capabilities` publishes only the enforced policy (`permanent`)
so clients never read an unenforced retention value (`mbs-8g5.3.1.5.2`). A
permanent setting does not remove the per-owner quota. Operators may purge
records or the service at any time. This is best-effort history storage and no
UI or package text may promise guaranteed backup or availability.

Initial finite defaults for M1 are **10,000 records and 1 GiB of exact
ciphertext-body bytes per owner**, combined across inbound and outbound
history. The Message Box Server 1.1.42 standard profile supplies a 1 MiB body,
4 MiB HTTP body limit, 1,000-record/8 MiB page, 10,000 queue-message/1 GiB
queue-byte quotas, 30-day retention, pre-auth 300 requests/minute/IP,
authenticated 1,000 requests/minute/identity, 24 concurrent requests/process,
and DB pool max 7. V1 maps these to the history service as initial defaults.
The 100-record archive batch is a conservative planning cap informed by
`MessageBoxClient.sendList`'s 100-recipient cap; it is not an upstream archive
batch contract. M2 must test these limits with the actual Knex/MySQL workload
and may set lower defaults. These numbers are not capacity-tested promises.

These are finite starting limits based on the sibling standard profile, not
measured capacity promises. M2 must test the exact body/batch/page behavior,
MySQL accounting and contention, and reject malformed or oversized requests
before unbounded parsing or database work. Lower limits are safe. Raising a
limit requires representative load/memory evidence and a documented operator
choice. There is no unlimited mode by default.

An owner-authorized deletion removes the body from the active service and the
owner's local cache immediately, and releases live count/byte quota in the
same transaction. The service emits a minimal owner-scoped delete change with
only `recordKey`, sequence, and time; change records never retain ciphertext.
The change feed has a rolling 30-day window matching the sibling Message Box
retention baseline. A cursor outside retained history returns
`ERR_CURSOR_EXPIRED`; the client then stages a complete snapshot and deletes
local records absent from that snapshot. No ciphertext tombstones remain.
Delete-all clears live rows and rotates the owner epoch, fencing stale cursors
and writes.

Database backups may retain encrypted bytes until the operator's configured
backup window expires. A restore must rotate the epoch and reconcile deletions
recorded after the backup before serving the restored store. If that deletion
state is unavailable, the operator must not serve a rollback that could
resurrect deleted records; fail closed or discard the affected history. An
epoch signals that clients must reconcile; it does not recover data that was
never in the restored snapshot.

## Identity, metadata, and discovery

The verified BRC-103/BRC-104 wallet identity is the sole owner selector. V1 is
one identity key to one history partition; key rotation/migration is not
supported. There is no canonical conversation/thread ID. Conversation grouping
stays on the client.

The service sees routing metadata already visible to Message Box: owner,
sender, recipient, box name, stable IDs, timestamps, body length, and access
patterns. It does not add metadata encryption or padding. Longer history
retention means the service can retain this metadata longer than a temporary
Message Box queue; do not claim metadata privacy.

MapApp uses an explicitly configured HTTPS store origin. There is no overlay
advertisement, discovery, or automatic host switching. Browser CORS is an
exact configured-origin policy; it is not an authorization mechanism. No
pricing or BRC-105 routes exist in the store service.

## Record, cursor, and synchronization contract

The immutable record identity is SHA-256 over length-prefixed UTF-8 fields:

```text
"message-box-store:record:v1"
ownerIdentityKey
direction
messageBox
sender
recipient
messageId
```

Each field uses a 4-byte unsigned big-endian byte length followed by the field
bytes, in the order above. Identity keys are validated compressed lowercase
hex; other values are exact transport strings with no Unicode normalization.
`bodyHash` is SHA-256 of the exact UTF-8 body string. The server recomputes the
owner-dependent record key and body hash; clients cannot choose a partition by
including an owner claim.

The M0 executable vector is:

```json
{
  "ownerIdentityKey": "021111111111111111111111111111111111111111111111111111111111111111",
  "direction": "outbound",
  "messageBox": "general_inbox",
  "sender": "021111111111111111111111111111111111111111111111111111111111111111",
  "recipient": "032222222222222222222222222222222222222222222222222222222222222222",
  "messageId": "m0-vector-1",
  "body": "{\"encryptedMessage\":\"AQ==\"}",
  "bodyHash": "0084794ecc214b1345494cd74a5758785b703aa54b89b1ff36b5087dc65ff8ce",
  "recordKey": "998e052031cfb45d304b54db7bb55abb56c69d2612567bd9eb563229073acbfe"
}
```

The v1 JSON API is versioned and uses `application/json; charset=utf-8`:

```text
POST   /v1/history/records                 archive batch
GET    /v1/history/snapshot                bounded full snapshot pages
GET    /v1/history/changes                 incremental records/deletes
PATCH  /v1/history/records/{recordKey}/state
DELETE /v1/history/records/{recordKey}
DELETE /v1/history/records                  delete all; rotate owner epoch
GET    /v1/history/capabilities
GET    /healthz
GET    /ready
```

Archive requests carry the current `epoch` and records, but never an owner
identity claim. Owner identity is derived from the verified authentication
session. All committed changes receive an owner-scoped monotonic unsigned
64-bit decimal `changeSequence`, allocated in the same transaction as the
change. The current snapshot captures watermark W and pages active immutable
records by keyset (`recordKey`) where creation sequence is at or before W.
Writes after W are read from the change feed. Deletes after W are represented
by delete events and never return bodies. The client stages the snapshot,
reconciles absent local records only after all pages succeed, then applies
changes after W. Interrupted snapshots never prune local state.

Change cursors are opaque base64url HMAC-SHA-256 tokens under domain
`message-box-store:cursor:v1`. Their signed claims bind owner (as HMAC context,
not a plaintext owner field), epoch, feed, filter digest, watermark, position,
and expiry. Cursors are integrity-protected, not encrypted credentials; they
must contain no message bodies or secrets. A cursor copied across identities
or modified by a client fails as `ERR_INVALID_CURSOR` without revealing
whether another owner's cursor or records exist. Expired but otherwise valid
cursors return `ERR_CURSOR_EXPIRED` and require full snapshot reconciliation.

The additive checkpoint handoff does not expose the cursor HMAC secret.
`GET /v1/history/changes` accepts paired
`afterSequence=<canonical uint64>` and `epoch=<current owner epoch>` query
parameters to start a new fixed-watermark pass after a completed snapshot or
terminal changes page. The pair is mutually exclusive with `cursor`; returned
opaque cursors alone continue that pass. Authentication remains the owner
selector. Half-pairs, future positions, epoch mismatch, and retained-range
gaps—including after explicit checkpoint `0`—fail closed rather than claiming
replica completeness.

## Decisions deferred beyond v1

The v1 implementation does not support identity rotation, cross-key history
migration, thread IDs, overlay discovery, metadata encryption/padding, store
pricing, paid Message Box delivery, outbound live fallback, or retry/recovery
of an `unknown` send. These are explicit exclusions, not hidden assumptions.
Package licensing/registry ownership and measured capacity remain M4 release
gates. No package publication, deployment, or external account action is
authorized by this design record.
