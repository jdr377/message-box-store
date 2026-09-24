# Release evidence and unresolved gates

Status: partial M4 evidence for `mbs-8g5.5.2`; this is not release approval.

The package is prepared as `@jdr377/message-box-store@0.1.0-private.0`
for `https://npm.pkg.github.com`. The npm `private` flag is absent because it
blocks any registry publication; this flag does not control GitHub package
visibility. The package has not been published. Its `UNLICENSED` source license,
independent security review, release-owner approval, and private visibility
verification remain open. Do not install it in a consumer until the published
artifact and access controls have been checked.

## Functional requirements

| Requirement | Executable evidence | Current result |
|---|---|---|
| FR-001 identity-authenticated owner partition | `tests/m2-auth-context.test.mjs`, `tests/m2-capabilities-isolation.test.mjs` | Auth identity selects owner; cross-owner inputs and state leakage are rejected. |
| FR-002 opaque encrypted archive | `tests/m0-interop.test.mjs`, `tests/m1-envelope-strict.test.mjs`, `tests/m2-logging.test.mjs` | Exact encrypted envelope is retained; plaintext, keys, ciphertext logs, and malformed wrappers are rejected or redacted. |
| FR-003 stable identity and idempotent upsert | `tests/m1-properties.test.mjs`, `tests/m1-idempotency.test.mjs`, `tests/m1-repository.mysql.test.mjs` | Canonical keys, immutable conflicts, concurrent dedupe, replay safety, and rollback are covered. |
| FR-004 inbound archive-before-ack | `tests/m3-inbound.test.mjs`, `tests/m3-two-device.test.mjs` | Archive precedes acknowledgement; duplicate hosts dedupe; store outage leaves transport pending. |
| FR-005 outbound archive integration | `tests/m3-outbound.test.mjs`, `tests/m3-two-device.test.mjs` | Prepared/accepted/unknown transitions are single-attempt and replay-safe; ambiguous sends are not retried. |
| FR-006 cursor retrieval | `tests/m1-feeds.test.mjs`, `tests/m2-retrievals.test.mjs` | Fixed-watermark signed cursors, exact page bounds, filters, checkpoints, expiry, and misuse rejection are covered. |
| FR-007 partial-history convergence | `tests/m3-replica-store.test.mjs`, `tests/m3-replica.test.mjs` | Snapshot staging, atomic incremental commits, cache loss, interruption, CAS, and resnapshot recovery are covered. |
| FR-008 sent and received views | `tests/m1-feeds.test.mjs`, `tests/m3-two-device.test.mjs` | Direction/participant/message-box filters and same-identity inbound/outbound decryption are covered. |
| FR-009 deletion and convergence | `tests/m1-snapshot-binding.test.mjs`, `tests/m3-two-device.test.mjs`, `tests/m4-recovery.test.mjs` | Active ciphertext purge, quota release, deletion fences, snapshot invalidation, replica pruning, and rollback receipt reapplication are covered. |
| FR-010 capabilities and limits | `tests/m2-capabilities-isolation.test.mjs`, `tests/m2-ingress-bounds.test.mjs` | Effective version, features, quotas, page bounds, retention, and isolated owner epoch are covered. |
| FR-011 safe degradation | `tests/m0-free-only-transport.test.mjs`, `tests/m2-saturation.test.mjs`, `tests/m2-shutdown.test.mjs` | Paid paths spend nothing, overload fails typed, readiness tracks storage, and shutdown drains bounded work. |
| FR-012 backup/restore compatibility | `tests/m4-recovery.test.mjs`, `docs/RUNBOOK.md` | Disposable MySQL rollback, external deletion receipts, fresh epoch, stale-write fencing, cache-loss reconciliation, and explicit post-backup loss are covered. |

## Artifact and compatibility evidence

`bun run test:pack` creates the real npm tarball and checks:

- the artifact inventory excludes `.env`, `.git`, `.beads`, tests, plans,
  `node_modules`, and consumer/reference repositories;
- every export target and required operator recovery file exists in the tarball;
- the recursively declared production/optional-peer dependency closure resolves
  to installed package manifests and contains no MapApp dependency;
- Node 22.21.1 ESM and CommonJS imports, browser-conditioned imports, declarations,
  and the packed TypeScript example compile and execute through package exports.

The currently installed direct dependency/license inventory is:

| Package | Pinned/range | Manifest license |
|---|---:|---|
| `@bsv/auth-express-middleware` | `2.2.3` | `SEE LICENSE IN LICENSE.txt` |
| `@bsv/message-box-client` | `2.5.1` | `SEE LICENSE IN LICENSE.txt` |
| `@bsv/sdk` | `2.7.1` | `SEE LICENSE IN LICENSE.txt` |
| `express` | `5.2.1` | MIT |
| `knex` (optional peer) | `^3.3.0` | MIT |
| `mysql2` (optional peer) | `^3.11.0` | MIT |

This inventory is evidence, not legal approval. The three BSV dependency license
texts and the MIT dependency notices are reproduced in `THIRD_PARTY_NOTICES.md`.
The package's own license and the release owner's legal approval remain open.

## Gates that remain open

- The maintainer pre-review in `docs/SECURITY_PRE_REVIEW.md` traces every M0
  release-security gate. An independent reviewer must validate it and accept or
  resolve findings; executable tests are not an independent security review.
- Measured deployment capacity and supported runtime/peer matrices must be
  approved. Current limit and saturation tests prove bounded behavior, not a
  production throughput promise.
- The changelog and upgrade/compatibility/rollback guidance exist for the private
  `0.1.0-private.0` baseline, and the direct-dependency notice inventory is packaged.
  Package license, legal notice approval, maintainer ownership, and final
  release notes must be approved and finalized.
- An immutable release-candidate tarball and digest must be created only after
  the manifest/version/license decisions. Publishing and deployment require
  separate explicit authorization.
