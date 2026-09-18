# message-box-store

Planning documents for a standalone, publishable encrypted message-history
store that complements `@bsv/message-box-client` and Message Box Server.

This repository is intentionally application-independent. It contains no runtime
implementation yet; it defines the product boundary, architecture, wire
contracts, operational model, and delivery plan for a future package that can
be transplanted into another repository or published from its own project.

## The boundary

Message Box is an authenticated **store-and-forward transport**. It accepts an
opaque message envelope, holds it while the recipient is offline, and deletes
the envelope when the recipient acknowledges it. It is not a conversation
archive, sent-items store, device synchronizer, or backup service.

`message-box-store` is the separate **durable history service**:

```text
sender wallet
  ├─ encrypts with the wallet protocol
  ├─ archives the opaque outbound envelope in message-box-store
  └─ sends through Message Box

recipient wallet
  ├─ lists the pending Message Box envelope
  ├─ archives it durably in message-box-store
  ├─ decrypts locally
  └─ acknowledges Message Box only after archival succeeds

other device with the same wallet identity
  └─ authenticates to message-box-store, downloads ciphertext, decrypts locally
```

This is the target flow, not a capability already exposed by the surveyed
client. Its receive methods decrypt results, and its send method prepares
ciphertext internally. The first design gate proves raw-envelope capture and
prepared-send integration through public APIs. Historical replay must never
repeat payment acceptance or other transport side effects.

The service stores ciphertext and routing metadata. It never receives wallet
private keys or plaintext as part of the supported integration. A client may
decrypt only after retrieval, using the same wallet identity and protocol that
created the message.

## Documents

- [ADR-001 — Durable encrypted history beside Message Box](./ADR-001-durable-history.md)
  records the architecture, invariants, alternatives, and unresolved design
  decisions.
- [PRD — message-box-store](./PRD.md) defines the product requirements,
  acceptance evidence, milestones, and release/adoption plan.

## Proposed package shape

The eventual project should follow sister-package conventions while remaining
independently publishable; later upstream adoption must not require any consumer application:

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
server-specific code through subpath exports such as `message-box-store/server`
and `message-box-store/storage/knex`. Server-only database dependencies must
not enter the browser bundle.

## Reference snapshot

The design was surveyed against the `ts-stack` snapshot available when these
documents were written. Upstream links are the portable evidence source.

| Contract | Upstream evidence |
| --- | --- |
| Public client package and encryption/ID behavior | [client package](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client) |
| Client types and pagination options | [client types](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/messaging/message-box-client/src/types.ts) |
| Message Box HTTP contract | [HTTP spec](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/messaging/message-box-http.yaml) |
| Server routes and hard-delete acknowledgement | [server routes](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/message-box-server/src/routes) |
| Server schema, quotas, retention, and deployment | [server infrastructure](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/message-box-server) |
| Sister package and release conventions | [ts-stack packages](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging) |

The surveyed local package manifests report client `2.4.2` and private server
`1.1.40`; generated catalog pages can lag those manifests and are not treated
as the version authority.

Review baseline: vendored ts-stack commit
`5ad3b3b7c71127f513e20cb3a472dba012e08ebc`, reviewed 2026-09-18. This is not
a claim that those are the latest published releases. Local evidence links are
optional conveniences that will stop resolving after transplantation; the
upstream paths can be pinned to this commit for reproducible evidence.

## Status and next step

These are design artifacts, not a claim that the package exists or is ready to
publish. The next implementation milestone is a small protocol package plus a
reference client/server adapter, accompanied by conformance tests for
idempotent archival, partial-history convergence, and acknowledge ordering.
