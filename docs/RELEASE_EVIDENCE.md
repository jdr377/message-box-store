# Release evidence and follow-ups

Current public release: **@jdr377/message-box-store@0.1.2**, npm tag **latest**.
The owner authorized stable versioning, the registry publication and browser
2FA. Original code uses Open BSV License Version 6; dependency notices remain
in [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md). These decisions no longer
await an initial prerelease. Deployment approval is separate.

## Published 0.1.2 qualification

The release uses official SDK **4.0.0**, auth middleware **2.2.10**, Message Box
Client **2.6.1** and Express **5.3.0**, with no SDK override. Optional production
storage peers remain Knex `^3.3.0` and mysql2 `^3.11.0`.

- 133 affected transport, HTTP, WebSocket, authentication and history tests pass.
- 28 exact-archive consumer tests and 28 fresh public-name consumer tests pass,
  including ciphertext retention/local decryption, owner isolation, replay
  refusal, no payment and no duplicate send.
- Typecheck, lint, build, the 114-package ESM/CJS/browser/declaration closure,
  and the production dependency audit pass. The audit reported zero findings.
- Anonymous download matches SHA-256
  `dc08b8a624b360a9d5751e2b7214310425797cdbd1ab49c4efcd933f3bd1701d`,
  SHA-1 and SHA-512; the archive is **332,427 bytes / 76 files**.

Exact archive and verification logs are retained outside Git under
`.local/sdk4-refresh-20261027/`. This was a dependency update: no wire,
ciphertext, database schema, epoch, cursor or wallet-key migration ran. It did
not rerun the complete live-MySQL suite. Historical complete-suite results
below or in dated reports do not certify every current deployment.

## Downstream integration

The original MapApp packed-consumer drill is complete (`mbs-8g5.6.1`–`.6.4`):
two-wallet exchange, WIF plus ZIP restore, WIF plus explicitly selected remote
wallet-provider restore, exact seven-message-ID/direction comparison,
archive-before-ack and outage/no-ack recovery. The key alone does not restore
wallet records. These are scoped historical proofs, not every wallet/device.

MapApp and its public connector 0.1.11 now consume npm Store **0.1.2** without
source/workspace imports or a forced SDK override. Their SDK 4 consumer and
installed-archive checks are recorded in the named consumer's release evidence.
The original private-tarball-before-publication milestone is superseded.

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

## Artifact and compatibility boundary

The real packed consumer checks allowed files, documented public exports,
recursive production/optional-peer manifests, ESM, CommonJS, browser imports,
declarations and the TypeScript example. Browser exports exclude server and
database code. See [public subpaths](PUBLIC_SUBPATHS.md) and
[upgrade guidance](UPGRADING.md). Package engine ranges are not a measured
deployment throughput or broad runtime/storage certification.

## Remaining follow-ups

- `mbs-8g5.5.2.4`: independent security sign-off. Maintainer audits and tests
  do not supply this. The September audit's three storage-bound findings were
  remediated (`mbs-bij.1`–`.3`); later registry audits also ran. Neither fact
  proves independent human acceptance of the full threat model.
- `mbs-8g5.5.2.5`: a supported deployment/runtime/storage matrix and measured
  capacity statement. License, package name, registry owner, stable versioning
  and immutable release mechanics are settled; broader legal assurances or
  throughput/SLO claims are not inferred from publication.

The obsolete deep history DNS cleanup (`mbs-8g5.6.5`) is complete: both
authoritative servers report the old hostname absent, while the active
history service passes HTTPS health/readiness. This was read-only verification.

The old M4/prerelease aggregate beads are retired tracking, not a claim that
the remaining sign-off or deployment-capacity work passed. Historical audits
retain their original scope and results.
