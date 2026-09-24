# message-box-store

An independently publishable encrypted-message history package, initially
operated as a private MapApp service beside `@bsv/message-box-client` and
Message Box Server. The repository contains the accepted product documents,
the frozen M0 interoperability proof, and the implemented M1-M3 private
checkpoint.

This repository is intentionally application-independent. M1-M3 now implement
the protocol and repositories, authenticated service, archive/send operations,
convergent local-replica contract, and polling worker.
That does not make it a deployable service: capacity, backup/restore drills,
security review, and release administration remain M4.
The package can be transplanted into another repository and may be published
after those gates are met; no publication or deployment is authorized here.

## Private package installation

The proposed evaluation package is `@jdr377/message-box-store@0.1.0-private.0`
on GitHub Packages. It has not been published yet. A consumer can use this
repository-level `.npmrc` registry mapping after private publication:

```ini
@jdr377:registry=https://npm.pkg.github.com
```

Keep credentials in the installing user's npm configuration or an environment
variable, never in source control. A GitHub token with `read:packages` and
access to the private package is required for installation. Publishing requires
`write:packages` and release-owner approval. Confirm the package's private
visibility and inspect its exact version and digest before changing consumers.

## The boundary

Message Box is an authenticated **store-and-forward transport**. It accepts an
opaque message envelope, holds it while the recipient is offline, and deletes
the envelope when the recipient acknowledges it. It is not a conversation
archive, sent-items store, device synchronizer, or backup service.

`message-box-store` is the separate **best-effort encrypted history store**:

```text
sender wallet
  ├─ encrypts with the wallet protocol
  ├─ archives the opaque outbound envelope in message-box-store
  └─ invokes public HTTP sendMessage once at the application level with checkPermissions:false

recipient wallet
  ├─ lists the pending Message Box envelope
  ├─ archives it durably in message-box-store
  ├─ decrypts locally
  └─ acknowledges Message Box only after archival succeeds

other device with the same wallet identity
  └─ authenticates to message-box-store, downloads ciphertext, decrypts locally
```

This flow is executable through the package's M3 client operations; it is not
a replacement for the Message Box client's own API. That client's receive
methods decrypt results, and its send method prepares ciphertext internally.
M0 confirms the public composition: prepare the envelope
once with `wallet.encrypt`, persist that exact body and explicit ID, then pass
them to HTTP `sendMessage` with `skipEncryption: true` and
`checkPermissions: false`. V1 supports free transport only. An explicit
`checkPermissions: true` request fails before attempt reservation or transport.
The worker must not call `sendLiveMessage`: in 2.5.1 it falls back to HTTP
after a negative acknowledgement or timeout, which can duplicate an accepted
send. An ambiguous HTTP result is `unknown` and is never retried. Inbound live
events are notifications only; archiveable raw bodies come from the facade's
route-scoped `listRawPage` operation before per-host acknowledgement.

“Once” means one application-level `sendMessage` invocation. SDK 2.7.1
`AuthFetch` may make internal authenticated HTTP exchanges to recover a stale
BRC-103 session; the policy does not promise one physical HTTP request. The
outbound helper exposes no live-send route, so there is no Socket.IO-to-HTTP
fallback, and the BRC-105 guard prevents a paid retry after HTTP 402.

There is a separate 402 constraint: `AuthFetch` 2.7.1 automatically attempts
BRC-105 payment construction after an HTTP 402, even when
`checkPermissions` is false. M0 now proves a public WalletInterface guard on a
real authenticated local 402 challenge. The supported factories construct
`MessageBoxClient`/`AuthFetch` with that guarded wallet from the outset; they
do not patch a client or intercept its network requests. The guard forwards
the nonce HMAC also used by ordinary BRC-103 authentication, blocks the
BRC-105 payment-derived public key and transaction-action methods, rejects
caller-supplied payment contexts or `x-bsv-payment` headers, and snapshots
accepted headers before the SDK's asynchronous authentication handshake. The
402 therefore fails with `ERR_PAID_TRANSPORT_UNSUPPORTED` before action
construction or a paid retry. A fee-requiring host is still unsupported: the
initial request reaches it, and this guard is not a general fee guarantee.

Authenticated authority is origin- and route-bound. The Message Box facade
owns outbound authority only at its primary origin. Explicitly validated
`trustedHosts` are receive sources only: exactly POST `/listMessages` and POST
`/acknowledgeMessage` are permitted. The facade exposes neither generic
authenticated fetch nor direct send. Production origins require
HTTPS. The opt-in test-only HTTP exception accepts only exact `localhost`,
strict dotted-decimal IPv4 in `127.0.0.0/8`, or IPv6 `::1`.

Use `createFreeOnlyMessageBoxClient()` for identity/raw-list/ack, derive its
unforgeable outbound capability with `createMessageBoxHttpSendCapability()`,
and send only through `sendPreparedHttpOnce()`. The capability binds the
one-shot archive owner to the guarded wallet identity. A caller-provided owner
value is compatibility-only and must match that identity before reservation or
network activity. The package root does not export
a generic AuthFetch or guarded-wallet construction surface because either
could be composed into an alternate direct-send path.
These helpers are available from both `@jdr377/message-box-store` and
`@jdr377/message-box-store/client`; the old M0 source paths are compatibility
re-exports of the same implementation.

```ts
import {
  createFreeOnlyMessageBoxClient,
  createMessageBoxHttpSendCapability,
  prepareEncryptedBody,
  sendPreparedHttpOnce,
} from '@jdr377/message-box-store'

const messageBox = createFreeOnlyMessageBoxClient({
  walletClient,
  host: 'https://messagebox.example',
})
const ownerIdentityKey = await messageBox.getIdentityKey()
const prepared = await prepareEncryptedBody({
  wallet: walletClient,
  plaintext: { text: 'hello' },
  counterparty: recipientIdentityKey,
})
const result = await sendPreparedHttpOnce({
  httpSend: createMessageBoxHttpSendCapability(messageBox),
  attemptStore,
  ownerIdentityKey,
  recipient: recipientIdentityKey,
  messageBox: 'general_inbox',
  messageId: crypto.randomUUID(),
  body: prepared.body,
  host: messageBox.host,
})
```

`attemptStore.claimPrepared` must atomically insert only when absent. Plaintext
stays with the caller; the attempt record and transport receive only the exact
encrypted `prepared.body`. Existing prepared/unknown attempts are never resent.
Durable repository behavior, service routes, and the archive/sync worker are
implemented through M3. See [`examples/private-history.ts`](./examples/private-history.ts)
for same-identity synchronization and local decryption.

Pinned SDK 2.7.1 follows standard HTTP redirects and does not expose a public
hook that can set `redirect: 'error'`. V1 accepts this upstream behavior. The
package validates the initial configured HTTPS origin and route, but it does
not claim that later physical requests stay on that origin. Strict redirect
refusal is deferred until upstream provides a supported hook or a compatible
upgrade. The package does not patch private fields, fork the SDK, or replace
global fetch behavior.

The service stores ciphertext and routing metadata. It never receives wallet
private keys or plaintext as part of the supported integration. A client may
decrypt only after retrieval, using the same wallet identity and protocol that
created the message.

The same public wallet can call the private history service through the
guarded authenticated client. The origin is explicit, capability compatibility
is checked, and mutation methods make no silent retries:

```ts
import { MessageBoxStoreClient } from '@jdr377/message-box-store'

const history = new MessageBoxStoreClient({
  walletClient,
  host: 'https://history.example.com',
})
const { epoch } = await history.capabilities()
const archived = await history.archiveBatch({
  epoch,
  records: [{
    messageId: crypto.randomUUID(),
    messageBox: 'general_inbox',
    direction: 'outbound',
    sender: ownerIdentityKey,
    recipient: recipientIdentityKey,
    body: prepared.body,
    bodyHash: prepared.bodyHash,
    deliveryState: 'prepared',
  }],
})
if (!archived.committed) throw new Error('archive was not confirmed')
```

## Documents

- [Public package paths](./docs/PUBLIC_SUBPATHS.md) identifies supported
  browser, server, typed, and raw ESM entry points.
- [M0 decisions](./docs/M0-DECISIONS.md) freezes the v1 product, storage,
  transport, quota, deletion, record, cursor, and release boundaries.
- [M0 threat model](./docs/M0-THREAT-MODEL.md) maps each threat to controls,
  evidence, owners, and release gates.
- [ADR-001 — Durable encrypted history beside Message Box](./ADR-001-durable-history.md)
  records the architecture, invariants, alternatives, and remaining
  implementation/release gates.
- [PRD — message-box-store](./PRD.md) defines the product requirements,
  acceptance evidence, milestones, and release/adoption plan.
- [Release evidence](./docs/RELEASE_EVIDENCE.md) maps FR-001 through FR-012 to
  executable checks and lists the unresolved human release gates.
- [Changelog](./CHANGELOG.md) records the private unreleased implementation and
  its compatibility boundaries without assigning an unauthorized version.
- [Upgrade, compatibility, and rollback](./docs/UPGRADING.md) defines consumer
  and operator preflight, forward migration, cache recovery, and rollback.
- [Third-party notices](./THIRD_PARTY_NOTICES.md) inventories direct runtime and
  supported optional-peer licenses without selecting this package's license.
- [Internal security pre-review](./docs/SECURITY_PRE_REVIEW.md) traces every M0
  release-security gate and identifies the independent decisions still required.

## Product intent and implementation alignment

The implementation is on-intent when it preserves these boundaries:

- It stores opaque encrypted Message Box bodies plus necessary routing and
  synchronization metadata. It never stores wallet keys or supported-flow
  plaintext.
- It is a best-effort extra history provider, not a promise that messages are
  permanently backed up. Retention defaults to `permanent`, but quota,
  operator purge, configured expiry, and service loss remain allowed.
- User deletion immediately removes active ciphertext and releases live quota.
  Only body-free synchronization metadata may remain for bounded convergence.
- V1 is free-transport-only. It exposes no pricing, paid-send, live-fallback,
  automatic resend, or manual send-recovery path.
- One authenticated identity key owns one store partition in v1. Identity
  migration and multi-key merging are deferred.
- MySQL 8/Knex is the production persistence target. SQLite and memory are
  parity/test adapters, not alternative production promises.
- Snapshot, cursor, migration, compaction, race, and byte-limit machinery are
  correctness controls for cross-device retrieval. They must not expand the
  product into a wallet backup, conversation protocol, or guaranteed archive.

Current M1 hardening is evidence work, not a change in product scope. A green
M1 closes the shared protocol/repository foundation only; the package remains
non-deployable until M2-M4 are complete.

## Agreed package shape

The project follows sister-package conventions while remaining independently
publishable; later upstream adoption must not require any consumer application:

```text
message-box-store/
  mod.ts                         # public root exports
  src/
    client/                      # browser/Node sync and archive client
    protocol/                    # shared wire types and cursor contracts
    server/                      # optional Express route adapter
    storage/                     # repository interface and Knex adapter
    worker/                      # archive-before-ack and convergence worker
  tests/
  docs/
  package.json
  tsconfig*.json
  tsdown.config.ts
  README.md
  CHANGELOG.md
```

The first package can expose browser-safe client exports at the root and
server-specific code through subpath exports such as `@jdr377/message-box-store/server`
and `@jdr377/message-box-store/storage/knex`. Server-only database dependencies must
not enter the browser bundle.

The M0 `.mjs` sources remain frozen interoperability and security proof
fixtures. M1 does not require their conversion to TypeScript. Publishable M1+
surfaces use strict TypeScript entrypoints and can migrate or wrap proven
internals incrementally. One implementation boundary generates ESM, CommonJS,
and declarations; the project must not maintain duplicate behavior merely to
support multiple artifacts. Bun owns the documented package commands. Node 22
is the current M1 verification baseline. Node 24 reference-server verification
belongs to M2/M4 after that server exists.

## Reference snapshot

The design was surveyed against the `ts-stack` snapshot available when these
documents were written. Upstream links are the portable evidence source.

| Contract | Upstream evidence |
| --- | --- |
| Public client package and encryption/ID behavior | [client package](https://github.com/bsv-blockchain/ts-stack/tree/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/packages/messaging/message-box-client) |
| Client types and pagination options | [client types](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/packages/messaging/message-box-client/src/types.ts) |
| Message Box HTTP contract | [HTTP spec](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/specs/messaging/message-box-http.yaml) |
| Server routes and hard-delete acknowledgement | [server routes](https://github.com/bsv-blockchain/ts-stack/tree/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/src/routes) |
| Server resource profiles and limits | [resources](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/src/config/resources.ts), [app limits](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/src/app.ts), [compose limits](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/src/compose.ts), [environment defaults](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/.env.example) |
| SDK authenticated HTTP and automatic 402 behavior | [AuthFetch](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/packages/sdk/src/auth/clients/AuthFetch.ts) |
| Sister package and release conventions | [ts-stack packages](https://github.com/bsv-blockchain/ts-stack/tree/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/packages/messaging) |

M0 pins and proves `@bsv/message-box-client` `2.5.1` and `@bsv/sdk` `2.7.1`.
The sibling resource/runtime survey uses vendored ts-stack commit
`bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b`, reviewed 2026-09-20; that tree's
Message Box Server manifest is private version `1.1.42`. These references are
not claims about the latest published server deployment. Upstream source links
are pinned to the inspected commit for reproducible evidence.

## Status and next step

M0 is accepted and frozen, and M1-M3 are implemented as a private evaluation
checkpoint. The M3 two-device proof, evaluated on baseline `4f13a3d`, consumes
the real packed root/client/server exports and demonstrates archive-before-ack,
same-identity recovery and decryption, idempotent replay, outage-safe pending
delivery, delete convergence (including expired-cursor snapshot recovery), and
no resend after an ambiguous outbound result.

Evidence recorded on 2026-09-22: the focused packed workflow passed 1/1;
`bun run test:pack`, build, strict typecheck, lint, and diff validation passed;
the default suite passed 317 and intentionally skipped 22 MySQL-gated tests
(339 total, 0 failures); the separately enabled disposable-MySQL suite passed
65/65 with no skips.

This checkpoint is not ready to publish or deploy. Paid delivery, automatic
resend/recovery, identity rotation/migration, a bundled local database, and
availability guarantees remain unsupported. M4 remains open for capacity,
backup/restore, security, release administration, and the final supported
runtime/package matrix.

## Reproducible M1-M3 commands (Node 22)

```sh
bun install --frozen-lockfile
bun run build        # tsdown: ESM + CommonJS + declarations from one TS source
bun run typecheck    # tsc --noEmit (strict)
bun run lint         # browser-safe graph + secret scan
bun run test:m0      # frozen M0 proof fixtures (unchanged in role)
bun run test:m1      # M1 protocol/repository/snapshot/pack evidence
bun run test         # full suite (M0-M3)
bun run test:pack    # packed clean-consumer verification (real npm tarball)
node --test tests/m3-two-device.test.mjs # packed two-device proof
bun run test:m4:mysql                    # disposable MySQL rollback/recovery drill
```

Operator rollback recovery is deliberately offline and receipt-driven. See
[`docs/RUNBOOK.md`](docs/RUNBOOK.md#offline-restore-recovery-drill). It requires
an externally supplied fresh epoch and complete post-backup deletion receipts;
without that evidence the restored service stays offline. It does not claim to
recover writes that occurred after the backup or ciphertext whose wallet
identity key was lost.

M0 `.mjs` fixtures remain frozen proof and pass unchanged. Typed M1+
entrypoints (`mod.ts`, `src/protocol.ts`, `src/client.ts`, `src/server.ts`,
`src/storage.ts`, `src/canonical.ts`) generate `dist/` ESM/CommonJS/declarations;
root/client/protocol/canonical browser targets contain no Node built-ins,
`Buffer`, or server/database graph, while server/storage declare `knex`/`mysql2`
as optional peers. Node 24 reference-server verification is deferred to M2/M4.

## M0 interoperability proof

The first contract gate is executable with `bun install --frozen-lockfile`
followed by `bun run test:m0`. It exercises public
`@bsv/message-box-client` 2.5.1,
`AuthFetch`, BRC-100 wallet encryption/decryption, and local authenticated
HTTP and AuthSocket fixtures. The M0 outbound proof API exposes only a
factory-constructed client's module-private HTTP transport through a
runtime-branded capability, always passes `checkPermissions: false`, persists `prepared` before
one application-level invocation, and leaves ambiguous outcomes `unknown`
without retry. A raw client or duck-typed sender is rejected before reservation,
wallet calls, or HTTP. An explicit paid request
returns `ERR_PAID_TRANSPORT_UNSUPPORTED` before the attempt store or wallet is
touched. An unexpected authenticated 402 also fails with that code before
wallet action creation or a paid retry across send, raw list, ack, and generic
store AuthFetch surfaces. `failed` means a no-dispatch rejection before the
application-level call, or the typed guarded 402 after an attempted request;
every other ambiguous post-attempt outcome is `unknown`. `attempted` records whether the
application-level invocation occurred, while `statePersisted` is true only
when a store read/write confirms the returned state. Direct `sendLiveMessage` and positive-quote calls
exist only in upstream characterization tests. M0 is intentionally not an
M1/M3 runtime package: the result, policy rationale, and evidence limits are
recorded in
[`docs/M0-INTEROP-EVIDENCE.md`](./docs/M0-INTEROP-EVIDENCE.md).
