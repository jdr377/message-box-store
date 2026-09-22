# M0 interoperability evidence

Date: 2026-09-20 (Australia/Sydney)

This document records the first M0 interoperability gate for the standalone
project. The executable evidence is `tests/m0-interop.test.mjs` and
`tests/m0-socket-interop.test.mjs`. They run the published
`@bsv/message-box-client` 2.5.1 against local HTTP and AuthSocket fixtures,
using the published `@bsv/auth-express-middleware` 2.2.3 and
`@bsv/authsocket` 2.1.7 public APIs. The fixtures use Message Box route/event
shapes and the BRC-103/BRC-104 handshake; they do not replace `AuthFetch`,
patch a client method, intercept a request, or import Message Box Server
internals. The M0 archive is an in-memory test double: this tranche does not
implement or prove durable storage.

## Supported M0 flow proved

The compatible public flow is:

1. Serialize the plaintext exactly as MessageBoxClient 2.5.1 does: a string
   remains its exact UTF-8 bytes; an object uses the SDK's `stringifyBRC100`.
2. Call the public wallet `encrypt` exactly once with protocol ID
   `[1, "messagebox"]`, key ID `"1"`, and the recipient identity key as the
   counterparty.
3. Build the exact body `{"encryptedMessage":"<base64>"}` with the SDK's
   BRC-100 JSON serializer. Preserve this string and its SHA-256 over UTF-8
   bytes.
4. Persist that exact inner body and explicit fresh logical `messageId` as
   `prepared` before sending. The M0 policy API accepts only the runtime-branded
   capability made from the approved free-only factory, and makes one
   application-level public HTTP `MessageBoxClient.sendMessage` invocation with
   `skipEncryption: true` and `checkPermissions: false`. A raw client or
   duck-typed sender is rejected before reservation or calling the client. An
   explicit paid request is rejected before attempt reservation or calling the
   client. The archive-before-send step is represented by an in-memory attempt
   store, not production persistence.
5. Construct the client through `createFreeOnlyMessageBoxClient()`. For
   inbound capture, use its route-scoped `listRawPage` operation against the
   authenticated `POST /listMessages` route. Treat a live callback only as an
   inbound wake-up: the callback is decrypted by the client, so archive the
   subsequent raw HTTP page. Decrypt only after the archive step with the
   sender as counterparty, then acknowledge through the guarded facade using
   the source host.
6. For outbound history, a second device with the same sender identity
   decrypts the archived ciphertext with the recipient as counterparty.

The test asserts that the server-side stored body, UTF-8 length, and body hash
are identical to the prepared body. It also exercises ordinary client
retrieval (`listMessages` with `acceptPayments: false`) using the public
MessageBoxClient constructor and a guarded wallet, plus direct second-device
decryption. The package's supported facade itself exposes raw ciphertext pages,
not a plaintext-returning history API.

The policy proof API is intentionally small:

```js
const httpSend = createMessageBoxHttpSendCapability(messageBoxClient)
const result = await sendPreparedHttpOnce({
  httpSend,
  attemptStore, // M0 test double; production must provide an atomic durable claim
  ownerIdentityKey,
  recipient,
  messageBox,
  messageId,
  body: prepared.body,
  host,
  checkPermissions: false, // true is rejected with ERR_PAID_TRANSPORT_UNSUPPORTED
})
```

The capability is an opaque, property-free runtime token. The helper retrieves
its module-private transport and the identity returned by the guarded client's
public `getIdentityKey()` API. A retained compatibility `ownerIdentityKey`
argument must exactly equal that identity before any attempt-store call or
transport work. The helper writes `prepared`
before dispatch, and never resends an existing key. “Once” is one
application-level invocation: SDK 2.7.1 `AuthFetch` may perform internal
authenticated HTTP exchanges while recovering a stale BRC-103 session, so no
one-physical-request guarantee is made. The helper never invokes
`sendLiveMessage`, so no Socket.IO-to-HTTP fallback occurs, and the BRC-105
guard blocks a paid retry after HTTP 402. A persisted `prepared` state
encountered after interruption is surfaced as `unknown` and not sent. This is a
proof surface, not the M3 durable worker or store implementation.

## Free-only constructor and HTTP 402 proof

The package root exports `createFreeOnlyMessageBoxClient()` and the branded
one-shot policy surface; it does not export guarded-wallet/AuthFetch helpers or
raw upstream constructors. The facade exposes identity, raw-list, and
acknowledgement only. A module-private WeakMap binds it to the outbound
transport used by `createMessageBoxHttpSendCapability`; callers cannot retrieve
that transport or directly send. Outbound is fixed to the primary origin.
Explicit `trustedHosts` authorize only exact POST `/listMessages` and POST
`/acknowledgeMessage`, never generic authenticated paths or outbound send.

The test-only HTTP exception accepts exact `localhost`, strict four-part
dotted-decimal IPv4 in `127.0.0.0/8`, or IPv6 `::1`. It rejects numeric
shortcuts/leading-zero IPv4, non-loopback names and addresses, DNS names such
as `127.attacker.example`, credentials, and configured paths. The initial
authenticated request must target the primary or explicitly trusted origin.

This URL preflight is not redirect containment. In pinned `@bsv/sdk` 2.7.1,
`AuthFetch` constructs `SimplifiedFetchTransport(baseURL)` internally and the
transport's default fetch follows redirects. Although
`SimplifiedFetchTransport` publicly accepts a custom fetch implementation,
`AuthFetch` exposes no public constructor/factory option for supplying it, and
`MessageBoxClient` exposes no public AuthFetch/transport injection option.
Consequently the supported send/list/ack paths cannot force `redirect: 'error'`
without private-field mutation, SDK forking, or a global fetch patch. Those
approaches are outside the accepted boundary. V1 accepts the pinned SDK's
redirect behavior and makes no redirect-containment claim. Strict refusal is
deferred until an upstream public injection hook or a reviewed compatible SDK
upgrade exists.

At the pinned SDK 2.7.1 baseline, the authenticated HTTP 402 path performs
`createNonce` (`wallet.createHmac` with `[2, "server hmac"]`), then
`wallet.getPublicKey` with `[2, "3241645161d8"]`, then
`wallet.createAction(outputs)`, then retries the request with an
`x-bsv-payment` header. The nonce HMAC is shared with normal BRC-103 Peer
authentication, so blocking it would break free authenticated requests; the
guard delegates it. It blocks the BRC-105 payment-derived key and every wallet
transaction-action method. Its public AuthFetch facade also rejects caller
payment contexts, retry controls, payment labels, and pre-supplied payment
headers before any request, and snapshots accepted caller-owned headers before
the SDK's asynchronous authentication handshake. An unexpected 402 reaches the wallet guard,
returns typed `ERR_PAID_TRANSPORT_UNSUPPORTED`, and stops before an action or
paid retry. The initial request itself is not suppressed, and a fee-requiring
host remains unsupported. These request-count assertions use a fresh-session
fixture; stale-session BRC-103 recovery may make internal AuthFetch exchanges
inside one application-level invocation.

`HTTP 402 is non-spending across supported paths` in
`tests/m0-free-only-transport.test.mjs` exercises signed 402 challenges through
raw list polling, acknowledgement, and an internal AuthFetch characterization
against a test-only future `/v1/history/capabilities` route shape;
`M0 402 is typed, stops before wallet action, and does not retry the paid
request` exercises the MessageBoxClient outbound send path. The fixture
requires one satoshi, authenticates the original request with the public
middleware, records exactly one route hit per invocation, and observes no
payment header, wallet action, payment output, or underlying satoshi
construction. It also confirms that late caller mutation cannot add a payment
header and that the ordinary BRC-103 nonce HMAC remains available. The simulated
history-capabilities route is not a production route; M0 implements no store
service endpoints. The package root surface test rejects upstream
constructors and hidden source subpaths.

## Evidence matrix

| Contract | Evidence | Result |
| --- | --- | --- |
| One encryption; exact envelope, UTF-8 body and SHA-256 | `M0 exact envelope` | Executable pass |
| Opaque HTTP capability; prepared intent saved before the sole `sendMessage` invocation | `M0 HTTP policy` | Executable pass; capability has no callable methods |
| Concurrent/repeated call with same canonical key cannot send again | `M0 one-shot concurrency` | Executable pass; one call total |
| Lost HTTP response after fixture acceptance stays `unknown`; repeat is suppressed | `M0 HTTP ambiguity` | Executable pass; exact ID/body used in one call |
| Free sends pass `checkPermissions: false`; explicit paid requests fail before attempt reservation, wallet or transport | `M0 paid permission requests fail before reservation or transport`; `M0 HTTP capability is opaque and supported sends force checkPermissions false` | Executable pass; zero reservation, wallet action or HTTP/live calls |
| Package root exposes no raw upstream constructor or live/payment/recovery capability | `package root exposes guarded factories, not upstream constructors or internal proof paths`; `M0 outbound API exposes no retry, reset, or manual recovery operation` | Executable pass; exact root exports and blocked internal subpaths are frozen |
| Invalid/plaintext body is a preflight `failed` result and is not sent | `M0 invalid prepared send` | Executable pass |
| Raw MessageBoxClient and duck-typed senders fail before reservation, wallet or HTTP; approved guarded capability still sends free | `public one-shot helper rejects raw MessageBoxClient and custom senders before reservation or authenticated 402` | Executable pass; exact signed 402 challenge remains untouched by rejected senders, approved capability completes a free send |
| Capability owner equals archive owner, envelope sender, and authenticated sender | `opaque send capability binds archive owner and envelope sender to its authenticated wallet` | Executable pass; capability-A/owner-B rejects before attempt-store, HTTP, wallet action, or requested satoshis; valid path records wallet A consistently |
| Redirect behavior | Source inspection and local 307 reproduction | Accepted v1 limitation: SDK 2.7.1 can forward ciphertext and public authentication metadata; no plaintext, private keys, or decryption keys are present; strict refusal is deferred pending a supported upstream hook or compatible upgrade |
| Secondary authority is route-scoped; explicit multi-host list/ack and strict test-loopback behavior | `Message Box secondary authority is limited to exact list and acknowledgement operations`; `test-only HTTP origins accept only localhost, strict numeric 127/8, and IPv6 ::1` | Executable pass; facade has no generic fetch/direct send, secondary outbound is rejected before reservation/wallet/HTTP, and allowlisted list/ack reach the fixture |
| Pinned Message Box Server 1.1.42 list/ack wire parity | `the guarded MessageBoxClient factory keeps public free send/list/ack functional` | Executable pass; list uses `createdAt`/`updatedAt`, missing-ID ack returns HTTP 400 `ERR_INVALID_ACKNOWLEDGMENT` and `Message not found!` |
| Object/string serialization; inner wrapper extraction and malformed/plaintext rejection | `M0 body serialization` | Executable pass |
| Ordinary client receive decrypt and same-identity second-device outbound decrypt | `M0 exact envelope` | Executable pass |
| Direct 2.5.1 behavior: explicit IDs, repeated plaintext/new ciphertext, duplicate pending send, and same-ID send after ack | Upstream direct-client characterization | Executable pass; store helper blocks reusing that outbound record key |
| Raw authenticated HTTP capture; archive-before-ack; pending on archive failure | `M0 archive-before-ack` | Executable pass using an in-memory archive test double |
| Same envelope from two hosts; dedupe once and acknowledge each source host | `M0 duplicate hosts` | Executable pass against local fixtures |
| Inbound AuthSocket notification is decrypted; raw HTTP supplies archive body before ack | `M0 AuthSocket inbound wake-up` | Executable pass against local AuthSocket fixture |
| 2.5.1 negative live ack and 10-second timeout each trigger automatic HTTP fallback | `M0 upstream fallback characterization` | Executable hazard characterization only; never used by the store policy API |
| Positive quote on accepted-but-unacknowledged live send reaches wallet action via fallback | `M0 paid fallback hazard` | Executable risk proof; local wallet refuses before fallback HTTP send, no payment is made |
| Direct upstream positive-quote behavior explains why paid mode is excluded | `M0 upstream positive-quote characterization` | Upstream characterization only; not a store capability or release criterion |
| No payment internalization during normal/history decryption | `M0 checkPermissions` | Executable pass |
| Signed BRC-103/BRC-104 route and unsigned rejection | Auth middleware plus unsigned `401` test | Executable pass against published middleware |
| Authenticated 402 cannot create an action or make a paid retry on send, raw poll, ack, or generic store AuthFetch | `M0 402 is typed, stops before wallet action, and does not retry the paid request`; `HTTP 402 from raw polling, acknowledgement and a future history/capabilities request never pays or retries` | Executable pass; initial route observed once, no `x-bsv-payment`, wallet actions or payment outputs; shared BRC-103 nonce HMAC remains functional; history path is fixture-only |
| Positive-fee live/HTTP acceptance | V1 outbound policy | Intentionally unsupported; characterization only; not a supported store path or M0 gate |
| Configured host 402 payment prevention | M0 public guarded-client/AuthFetch factories and local authenticated 402 fixtures | Executable pass for every supported factory path; the initial request still reaches the host, and no global free-host fee guarantee is claimed |

## Pinned Message Box Server fixture parity

The read-only `ReferenceRepos/ts-stack` snapshot is commit
`bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b`; its
`infra/message-box-server/package.json` declares private version `1.1.42`.
This pins the fixture contract to inspected source, not to any assertion about
the current deployed service. In that source, the list route maps database
`created_at`/`updated_at` to wire `createdAt`/`updatedAt`; the acknowledgement
route returns HTTP 400 with `ERR_INVALID_ACKNOWLEDGMENT` and
`Message not found!` when the delete count is zero.

- [1.1.42 `listMessages.ts`, timestamp mapping at the pinned commit](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/src/routes/listMessages.ts#L146-L147)
- [1.1.42 `acknowledgeMessage.ts`, missing-message response at the pinned commit](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/src/routes/acknowledgeMessage.ts#L161-L170)
- [1.1.42 list-route source test](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/src/routes/__tests/listMessages.test.ts#L82-L90)
- [1.1.42 acknowledgement-route source test](https://github.com/bsv-blockchain/ts-stack/blob/bdaebe696c18bf0c0b3c50ac9ef73a396d014d1b/infra/message-box-server/src/routes/__tests/acknowledgeMessage.test.ts#L153-L175)

The local fixture emits the same camel-case timestamp properties, and the
regression test compares their values to the fixture's stored timestamps. It
also sends an authenticated acknowledgement for an absent ID and verifies the
same HTTP status/code/description contract without deleting the pending
message.

## 2.5.1 public surface characterization

The standalone lockfile pins:

```text
@bsv/message-box-client 2.5.1
@bsv/sdk                  2.7.1
@bsv/auth-express-middleware 2.2.3
```

The installed 2.5.1 package manifest and compiled source used for the survey
were hashed on 2026-09-20:

```text
message-box-client/package.json       933CDC8D96B069D32A29568C3CB7D72E5C31C49AE6110567AD1512944E826694
message-box-client/dist/src/MessageBoxClient.js
                                       32F44F541D224D642DAB082B20A95F088B1F728576758D1FEFED0BD6506653DC
message-box-client/dist/src/MessageBoxClient.d.ts
                                       1BEC47DFD352D9087068028D75C41A838681B8A2F03C9424AAB9008C636C0DA3
@bsv/sdk/package.json                  343FD217A2C067A8243EA9E0A8EC1A30D44BEF19251D185C8E4F81B770A7FC2A
@bsv/sdk/dist/esm/src/auth/clients/AuthFetch.js
                                       061BFFF92B8B4CCC85D66CEC2DCB1B0560021FAB76FBCD322C7ACCEAAB57EFD7
```

The AuthFetch hash pins the exact installed 2.7.1 payment path reviewed below;
the SDK manifest hash pins the package version associated with that source.

The 2.5.1 declarations and implementation confirm:

- `SendMessageParams` has `body: string | object`, optional explicit
  `messageId`, `skipEncryption`, and `checkPermissions`.
- `sendMessage` always derives an HMAC message ID (the explicit ID wins),
  encrypts unless `skipEncryption === true`, and sends the authenticated
  `POST /sendMessage` JSON body.
- Its encryption helper uses exactly `[1, "messagebox"]`, key ID `"1"`, and
  the recipient counterparty, returning the BRC-100
  `{"encryptedMessage":"..."}` string.
- `listMessages` and `listMessagesLite` parse/decrypt before returning and may
  process recipient payments; neither is a raw receive hook.
- `acknowledgeMessage({ messageIds, host })` sends to the explicit source host.
- `sendLiveMessage` uses authenticated AuthSocket/Socket.IO and preserves a
  string body with `skipEncryption: true`. On a disconnected socket, negative
  acknowledgement, or 10-second timeout, it automatically calls HTTP
  `sendMessage` once with the same `messageId`, body, `skipEncryption`, and
  `checkPermissions` values. The local AuthSocket tests directly characterize
  this upstream behavior; those calls are excluded from the store's outbound
  policy API.
- The live listener decrypts before calling the application callback. It is a
  live wake-up/UI path, not a raw ciphertext capture hook. An authenticated
  `AuthFetch` `/listMessages` poll is the raw archive source.
- In 2.5.1, `checkPermissions` is evaluated inside HTTP `sendMessage`; a live
  send that succeeds over AuthSocket does not itself ask the client for a fee
  quote. The local test proves a negative live ack forwards the option to the
  HTTP fallback, where a positive quote reaches the wallet action boundary
  before any `/sendMessage` request. A production host must enforce its live
  pricing policy; do not infer paid acceptance from the local fixture.
- `checkPermissions: false` suppresses only the message client's permission
  quote precheck. In SDK 2.7.1, `AuthFetch` still processes HTTP 402. The
  package factories construct clients with a public payment-disabled
  `WalletInterface`: the BRC-105 payment-derived key and wallet action methods
  are blocked; caller payment contexts and `x-bsv-payment` headers are
  rejected. The shared nonce HMAC stays enabled because ordinary BRC-103
  authentication also uses it. A local authenticated 402 reaches the typed
  wallet guard before `createAction` and before any paid retry. Fee hosts
  remain unsupported because the original request is made first.
- The HTTP fallback is automatic. With `checkPermissions: true`, a missing
  live acknowledgement can lead to a positive quote and wallet `createAction`
  after the live server already accepted the message. The M0 timeout fixture
  proves this ordering with a wallet that refuses before creating or sending a
  payment. Therefore 2.5.1 `sendLiveMessage` does **not** satisfy v1 outbound
  policy at any fee level. Only inbound live notifications may wake an
  authenticated raw poll.

The repository's original survey described client 2.4.2 and private server
1.1.40; those versions are historical provenance only. M0 targets the pinned
public client 2.5.1, and no pristine 2.4.2 installation or byte comparison is
required. Any change to the target client or its relevant public contracts
requires rerunning this gate.

## Outbound at-most-once and payment policy

State meanings are fixed across the helper, tests, ADR, PRD, M0 decisions, and
this evidence record. `attempted` is true iff the helper invoked the branded
public `sendMessage` capability once at the application level; pre-send policy
or validation rejection, reservation failure/conflict, and reuse of an
existing key do not count. It does not count AuthFetch's physical BRC-103
stale-session recovery exchanges. `statePersisted` is true only when a
successful attempt-store read or write confirms the returned result state;
false means storage is unconfirmed and does not prove an unacknowledged write
failed. `failed` means the helper did not invoke the send capability because
of a policy/validation rejection, immutable conflict, or unavailable/failed
reservation, or the typed guarded BRC-105 refusal after an attempted
authenticated HTTP 402. A pre-send result with `statePersisted: false` does
not claim a durable failed row; if an unconfirmed reservation left a
`prepared` row, later recovery reports `unknown` and blocks resending. The 402
classification is normative because the guard proves no payment-key
derivation, wallet action, or paid retry. Any other post-attempt throw,
malformed response, or unrecognized result is `unknown`.

- A new logical send persists a fresh explicit ID and exact prepared body.
  The one-shot helper's canonical record key is atomically reserved before the
  module-private `sendMessage` transport. Repeated or concurrent helper calls
  for that key make no transport call. The package root exposes no client,
  wallet, AuthFetch, or sender surface that can manually repeat the send.
- A direct HTTP response-loss test shows `sendMessage` does not retry its own
  request. The store helper makes one call, records `unknown` on a thrown or
  malformed response, and refuses later calls under the same key. The helper
  exposes no live capability, so the built-in Socket.IO-to-HTTP fallback is
  unreachable from supported outbound code.
- The archived `prepared` state is a write-ahead claim. If a process stops
  after it is saved, recovery must treat that key as ambiguous and must not
  dispatch it again; the M0 API contains no manual retry/reset operation.
- The supported policy rejects explicit `checkPermissions: true` before
  reservation, wallet, or transport, and forces `false` on free sends. The
  local negative test checks an empty attempt store, zero `createAction` calls,
  and zero host requests. Direct upstream positive-quote fixtures characterize
  why the paid behavior is excluded; they do not expose it through the store.
  History decryption invokes only `wallet.decrypt` and never accepts or replays
  payment.
- The auth middleware verifies the BRC-103/BRC-104 request signature over the
  method/path/query/body session contract and exposes the verified identity to
  the route. An unsigned request receives `401`; the route never selects an
  owner from request JSON.

The configured MapApp Message Box host passed its read-only health check. Its
quotes for two controlled test identities each returned
`recipientFee: 0`, `deliveryFee: 0`, and `total: 0`. No live send was submitted,
no transaction was broadcast, and zero satoshis were spent. These quotes are
not a general fee guarantee; the 402 guard is independently proven by the
local authenticated challenge. The wallet-node path was not needed for this
policy proof; paid outbound behavior is unsupported. Host policy and recipient
scope were not changed for this tranche.

## Remaining M0 gaps

This gate does not implement durable storage, production service routes, or
the M1/M3 worker. The public free-only construction and 402 guard are proven
against real local authenticated challenges, but M3 must re-test every worker
operation through the guarded factory and must not introduce a raw
`MessageBoxClient`/`AuthFetch` constructor path. A configured host may return
402, in which case that operation fails before wallet action creation or paid
retry; operators must use free hosts. Positive-fee outbound behavior is
unsupported, and paid acceptance is not an M0 requirement. The one-shot
policy, explicit paid-request rejection, and ambiguous no-retry behavior are
executable locally. This gate also does not claim a raw WebSocket receive hook:
live callbacks are decrypted, so live events can only wake a bounded
authenticated raw HTTP poll. The target is 2.5.1; no 2.4.2 byte comparison is
required.
