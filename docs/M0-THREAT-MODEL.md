# M0 v1 threat model and evidence matrix

- **Status:** accepted threat boundaries; release tests are assigned below
- **Decision owner:** message-box-store maintainers
- **Date:** 2026-09-20
- **Normative decisions:** [M0 v1 decisions](./M0-DECISIONS.md)

## Trust boundaries and accepted privacy claims

Wallets hold signing/decryption keys and decrypt message bodies locally. The
store receives encrypted Message Box envelopes and the routing metadata needed
to archive and synchronize them. The owner identity, participants, box name,
stable IDs, timestamps, size, and access patterns are visible to the operator,
as they are to Message Box. The history service may retain them longer. V1 does
not hide metadata, provide forward secrecy, prove sender authenticity, or
recover history after loss of the wallet identity key.

The store never accepts plaintext or private/decryption keys in its supported
API. An authenticated owner can nevertheless upload arbitrary bytes or false
peer metadata to its own partition. Envelope structure and hashing detect
malformation or later mutation; they do not prove that an adversarial owner
encrypted content honestly. A compromised valid client may corrupt or delete
its own history. Protecting an owner from its own identity key is outside v1.

An attacker controlling the database or server may read encrypted bodies and
visible routing metadata, delete or corrupt stored state, and observe access
patterns. The server has no wallet decryption key and cannot recover plaintext
from the supported storage format. Operator database backups inherit the same
confidentiality and metadata exposure; backup retention is finite and a store
restore is a recovery operation, not a durability guarantee to users.

## Threat → control → evidence / owner

| Threat | V1 control | Evidence and owner | Residual risk |
| --- | --- | --- | --- |
| Unauthenticated access or a body-supplied owner claim crosses partitions | Select owner solely from verified BRC-103/BRC-104 identity; reject/ignore body claims; scope all reads, writes, deletes, quota and cursors | M0 proves signed request and unsigned `401`; M2 service maintainer tests every route with forged and cross-owner claims | A compromised auth dependency or server operator can bypass the application boundary |
| Replayed or altered signed HTTP request | Pinned auth middleware and public `AuthFetch` bind method/path/query/body and require a live mutual session. The middleware rejects concurrently active duplicate request IDs but does not retain completed IDs as permanent single-use tokens. The private single-process service additionally rejects reuse within a bounded FIFO window of the 5,000 most recent verified application request IDs; the exact handshake is excluded | M2 service maintainer tests altered method/path/query/body, mismatched identity, invalid/removed sessions, immediate probe and non-probe replay, legitimate fresh retries, exact handshake exclusion, and explicit post-capacity eviction behavior | After FIFO eviction, an exact stolen request with a still-live session and valid signature may be accepted until explicit session removal or process restart. The replay window is process-local and is not an absolute single-use guarantee |
| Forged, modified, expired, or cross-owner cursor | Opaque HMAC-SHA-256 cursor binds owner context, epoch, feed, filters, watermark, position and expiry; never return activity on owner mismatch | M1 protocol maintainer freezes vectors/tamper cases; M2 service maintainer tests invalid/cross-owner cursors and full-snapshot expiry | Cursor integrity is not confidentiality; valid owner metadata remains visible |
| Duplicate archive or immutable content replacement | Canonical owner-scoped record key, exact-body SHA-256, idempotent same-content archive, conflict on changed immutable fields | M0 freezes record/body vector and exact envelope; M1 protocol maintainer and M2 storage maintainer test concurrency/conflicts | Hashing cannot prove that a valid uploader honestly encrypted its content |
| Plaintext, keys, signed headers, auth nonces, credentials, full tokens, or ciphertext leak through logs/errors/traces | Never accept plaintext/keys; redact all listed data; stable errors expose codes, not input values | M2 server maintainer tests logs/traces/error envelopes with sentinel values; release blocker | Process-level compromise can observe data handled in memory; operators control downstream log sinks |
| Ciphertext or metadata is read from database/backup | Store exact encrypted body only; encrypt/access-control operator backups; never store wallet keys; accurately document visible metadata | M0 second-device decrypt proves the expected key boundary; M2 storage maintainer inspects schema/logging; M4 operator runs backup/restore drill | Database/server compromise exposes ciphertext, routing metadata and access patterns, not wallet keys/plaintext |
| Storage exhaustion, body inflation, request floods, unbounded work | Finite owner quotas; 1 MiB body; 4 MiB request; 100-record batch; 1,000-record/8 MiB page; bounded rates, 24 concurrency, DB pool max 7; reject before expensive work | M2 service maintainer tests exact limits and MySQL accounting; M4 operator/capacity owner measures before raising. Server values follow 1.1.42; 100-row batch adapts client `sendList`'s 100-recipient cap, not an upstream archive contract | Workload may require lower per-deployment limits; defaults are not capacity guarantees |
| Cursor-retention gap or partial snapshot silently loses/duplicates local rows | Commit-ordered owner sequence, epoch/watermark, bounded keyset snapshot, stage then reconcile; expired cursor forces full snapshot; interrupted snapshot never prunes | M1 protocol maintainer tests vectors; M3 client maintainer tests replica recovery | A client that ignores the protocol can keep stale local copies until it reconciles |
| Deleted content returns on another device or after rollback | Purge active body/release quota atomically; emit minimal bounded delete event; expired cursor forces absent-row reconciliation; restore rotates epoch and reapplies post-backup deletes or fails closed | M1 storage maintainer tests deletion/cursor expiry; M3 client maintainer tests multi-device deletion; M4 operator tests restore-after-delete | Encrypted operator backups may contain deleted bytes until their documented finite backup window expires |
| User routes credentials to a spoofed store | Outbound input is fixed to the primary HTTPS origin. Explicit secondary inputs authorize only exact POST raw-list and acknowledgement routes; no generic AuthFetch is exposed. Validate initial URLs/origins before AuthFetch; CORS is not auth | M0 tests reject direct secondary arbitrary paths and outbound before HTTP (and outbound before reservation/wallet), while list/ack remain functional; strict loopback parsing rejects DNS/prefix tricks | Accepted v1 limitation: SDK 2.7.1 follows redirects and exposes no public injection hook to refuse them. A configured host can redirect ciphertext and public authentication metadata. It already receives that data. The store receives no plaintext, private keys, or decryption keys. Strict refusal is deferred until a supported upstream hook or compatible upgrade exists |
| Caller combines wallet-A capability with owner-B archive claim | Capability privately resolves the guarded client's public identity once; compatibility owner input must equal it before reservation or transport | M0 two-wallet adversarial test observes zero attempt-store, HTTP, action, and satoshi effects on mismatch; valid send records archive owner, envelope sender, and authenticated sender as wallet A | Compromise of wallet A remains authority for wallet A records |
| Fee-requiring host triggers wallet action or live fallback sends twice | Reject `checkPermissions:true`, force false, expose no live-send/payment API; construct supported Message Box/store `AuthFetch` through public factories with the payment-disabled wallet; reject supplied payment contexts/headers, snapshot accepted headers before the async handshake, and fail closed on BRC-105 key derivation and transaction-action methods. Outbound policy permits one application-level send invocation and no Socket.IO-to-HTTP fallback; the BRC-105 guard blocks paid retries | M0 real local authenticated 402 tests cover send, raw list, ack, and a fixture-only future history-capabilities request through generic store AuthFetch; wallet spies observe zero action/internalize calls, zero payment outputs and no `x-bsv-payment` retry, including after attempted late header mutation. M0 also tests raw/custom sender rejection before reservation/wallet/HTTP. M3 re-tests every worker path through the public factory; SDK/client upgrades rerun the adapter suite | The initial request still reaches the configured host; a 402 makes that operation unavailable. SDK 2.7.1 may make internal HTTP exchanges during stale BRC-103 session recovery, so one application-level invocation is not a one-physical-request promise. Direct imports of upstream constructors outside this package's supported root can bypass its factories. An SDK upgrade may change the payment path and requires re-audit |
| Lost history or identity key | No server-side key escrow or UI guarantee; operator purge/expiry allowed; identity rotation/migration unsupported in v1 | M0 maintainer records accepted risk; M3/M4 client/service docs and recovery tests preserve the boundary | Lost keys or purged history cannot be recovered by this service |

## Sibling resource baseline

The starting resource values follow Message Box Server's standard profile at
the baseline commit above: 1 MiB message body, 4 MiB HTTP body, 1,000 message
page, 8 MiB list response, 10,000 inbox/sender messages, 1 GiB inbox/sender
bytes, 30-day transport retention, 300 pre-authenticated requests/minute/IP,
1,000 authenticated requests/minute/identity, 24 concurrent HTTP
requests/process, and MySQL pool maximum 7. V1 maps the two separate queue
quotas conservatively to a combined per-owner history quota and maps finite
30-day transport retention to no-scheduled-expiry history retention. The
30-day deletion/change feed is independently bounded. Client
`MessageBoxClient.sendList` limits recipient batches to 100; using 100 for an
archive batch is a cautious initial adaptation, not an upstream history API
contract. These are planning defaults, not capacity measurements for the
history workload; any increase requires MySQL and memory evidence.

In `ReferenceRepos/ts-stack`, source paths are
`infra/message-box-server/src/config/resources.ts`,
`infra/message-box-server/src/app.ts`,
`infra/message-box-server/src/compose.ts`,
`infra/message-box-server/.env.example`, and
`packages/messaging/message-box-client/src/MessageBoxClient.ts`. The exact
reference snapshot is commit `bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b` and
the server manifest is private version 1.1.42. Client M0 evidence targets
published client 2.5.1 and SDK 2.7.1. The `@bsv/sdk` `AuthFetch` contract
automatically handles HTTP 402 by constructing and sending a BRC-105 payment;
the client `checkPermissions` flag controls the quote precheck but is not a
global no-payment switch. M0's public guard blocks the payment-derived key and
action stage while forwarding the shared nonce HMAC required by ordinary
BRC-103 authentication. The generic factory rejects reusable payment
contexts and pre-supplied payment headers. A fee host is still unsupported, and
the first request is not suppressed.

## Release security gate

M4 cannot call the package release-ready until the implementation and recorded
evidence show:

1. no cross-owner read/write/delete/quota/capability access;
2. signed-request mutation and invalid/removed sessions are rejected; request-ID
   reuse is rejected within the documented 5,000-entry process-local window,
   while post-eviction acceptance remains an explicit residual risk;
3. errors, logs, traces, and backups contain no plaintext, keys, or forbidden
   authentication material;
4. every request, batch, page, response, rate, concurrency, pool, record, and
   byte budget is finite and tested;
5. cursors fail on tampering and owner mismatch, and expire into a complete
   snapshot flow;
6. deletion removes active ciphertext, converges to all replicas, and cannot
   be undone by a supported restore;
7. supported free Message Box/store HTTP requests cannot create a wallet action
   or retry with payment on HTTP 402, and outbound code cannot fall back from
   live to HTTP. M0 proves the public construction guard against local
   authenticated 402 challenges; M3 re-tests it on the implemented worker;
8. accepted limitations remain visible in operator/package documentation and
   are not converted into stronger product or UI claims.
