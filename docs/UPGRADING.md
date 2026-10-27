# Upgrade, compatibility, and rollback

Version: `0.1.3`, npm tag `latest`. This document describes
upgrade boundaries and observed compatibility. Each future publication and
deployment still requires its own authorization and artifact record.

## Compatibility baseline

| Surface | Implemented baseline | Boundary |
|---|---|---|
| Package consumer | Node.js >=22 declared; observed on 22.23.4; ESM, CommonJS, browser-conditioned ESM, and TypeScript declarations | Other Node versions and deployments need their own qualification. |
| Browser graph | Root, `client`, `protocol`, and `canonical` exports | No server, database, Node built-in, or direct public 1Sat service dependency. |
| Server graph | Express 5.3.0, official SDK 4.0.0, auth middleware 2.2.10, Message Box Client 2.6.1 | SDK or transport upgrades require rerunning the free-only and authenticated-HTTP security proofs. |
| Production storage | MySQL 8, Knex `^3.3.0`, mysql2 `^3.11.0` | Memory and SQLite adapters are test/parity evidence, not production promises. |
| Wire/storage contract | Current v1 wire protocol, ordered migrations, owner epoch, signed cursors, snapshots, and canonical record keys | Wire or persistence incompatibility requires a major version and explicit migration notes. |
| Identity | One authenticated identity key owns one partition | Rotation, partition merge, and key recovery are unsupported. |

Exact pinned dependencies and executable evidence are recorded in
[Release evidence](RELEASE_EVIDENCE.md). The standalone release uses official
SDK 4 within the declared auth and Message Box peer ranges. No SDK override is
required. A host that changes resolution must qualify that effective graph.
Recheck authenticated HTTP, payment behavior, ciphertext envelopes, canonical
identifiers, cursors and database semantics when dependencies can affect them.

## Deployment and support

Message Box Store retains encrypted message history for wallet-authenticated
clients. The deployment baseline is one Node.js service behind HTTPS, backed by
MySQL 8/InnoDB. Current validation uses Node 22.23.4 and MySQL 8.4.13. SQLite and
memory adapters provide test coverage.

Wallet keys and message decryption remain client-side. Recovery depends on
retained wallet keys and successfully archived data. Operators maintain database
backups and follow the documented restore procedure. Documented quotas apply;
no throughput or uptime guarantee is offered.

## SDK 4 dependency update (published 0.1.2)

The dependency graph uses official SDK 4.0.0 and released auth/MessageBox
packages that declare SDK 4 support. No override or application wallet adapter
is required. This does not change ciphertext, database schema, cursors, epochs
or key ownership. Replayed signed requests can receive the stock middleware's
401 / ERR_AUTH_FAILED before Store routes; the Store unsigned-request gate
retains 401 / ERR_AUTHENTICATION_REQUIRED. Both are authentication refusals.

## 0.1.3 security repairs

Version 0.1.3 repairs the five findings in the
[independent review](https://github.com/jdr377/message-box-store/blob/main/docs/reviews/2026-10-28-independent-security-review.md).
The published 0.1.2 artifact remains immutable. This compatible update requires
no database migration; deployment is an operator action.

The wire shapes, canonical record keys, ciphertext and existing database schema
stay compatible. Custom recovery epochs rotate to a fresh canonical bounded
value on delete-all. Admission/IP rates now cover JSON ingestion and malformed
bodies; under load these requests may receive 503/429 before parsing. Public
liveness and allowed CORS preflight remain available. Browse stops at both count
and exact JSON byte bounds and returns a continuation at the last emitted key;
SQL body reads stop within one page budget plus one body. Snapshot creation
checks capacity before reading membership and never fetches unused ciphertext.

Security remediation in the unreleased checkout adds a separate default of
**1,000,000 reserved record keys per owner**: current live rows plus permanent
body-free deletion markers. A new distinct archive reserves its eventual marker
slot; deleting that record transfers the reservation and remains possible at or
above capacity. Exact archive retries and immutable-conflict checks precede
this admission check, including duplicate keys in one batch. New keys at the
bound return the existing per-record `quotaExceeded / ERR_QUOTA_EXCEEDED`
outcome. This is a finite implementation default, not a measured disk-capacity
or throughput claim, and is independent of the 10,000 active-record limit.

Existing rows and markers are counted under the existing owner transaction/lock,
once per batch. No schema migration or backfill is required. Existing owners
already over this boundary keep read, state-update, exact-retry and deletion
access; only new distinct keys are refused. Markers do not expire and are never
cleared automatically. Explicit owner delete-all retains its existing clearing
and epoch-rotation behavior; it is destructive, not an automatic quota repair.

The repaired SQL paths passed coordinator validation on MySQL 8.4.13/InnoDB,
including recovery, bounded browse, snapshot quotas, concurrent reservation
admission and reconnect behavior. The full package script also passed; its
deliberately gated MySQL tests were qualified separately for the named cases
recorded in the review. Reverting to 0.1.2 restores its original resource gaps;
no database rollback is needed for this schema-neutral change.

## Upgrade preflight

Before changing the package, service image, dependencies, or schema:

1. Identify the source version, target version or commit, artifact digest, Node
   runtime, MySQL version, and effective Knex/mysql2 versions.
2. Read every intervening entry in `CHANGELOG.md` and the target release notes.
   Stop if migration impact or rollback behavior is absent.
3. Run `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`,
   `bun run lint`, and `bun run test:pack` in a clean checkout.
4. Run the applicable contract/integration suite. Storage or migration changes
   also require the disposable MySQL suite and a current query/capacity review.
5. Take an encrypted transaction-consistent database backup. Record its digest,
   creation time, finite retention deadline, and the external deletion-receipt
   coverage needed by the restore procedure.
6. Drain and stop the service. Never run competing schema migrators.

These steps are evidence collection only. They do not authorize production use.

## Service and database upgrade

1. With the service stopped, configure the target artifact and run
   `bun run config:check`.
2. Run `bun run migrate`. Migrations are ordered, checksum-verified, and safe to
   re-run; checksum or structure errors must not be bypassed.
3. Start the target service with `bun run start`. Startup verifies but does not
   apply migrations.
4. Require `/healthz` to remain live and `/ready` to return the target version
   only after the database probe and migration verification succeed.
5. Exercise authenticated capabilities, one bounded history page, and a
   disposable archive/read/delete path before expanding traffic.
6. Existing clients with expired cursors or a changed recovery epoch must perform
   a complete snapshot rather than guessing a continuation point.

Do not migrate the Message Box transport database. History storage is separate
and its integration can be disabled independently.

## Consumer upgrade

- Import only documented package exports. Do not depend on `dist/`, private
  source paths or reference repositories.
- Preserve archive-before-ack. If history storage is unavailable, a safe worker
  leaves transport messages pending unless the application has an explicit,
  separately reviewed loss-accepting policy.
- Preserve one-attempt outbound semantics. An `unknown` result after an
  ambiguous send is not permission to retransmit automatically.
- Recreate or migrate the consumer's local replica atomically. On incompatible
  local state, discard the cache and rebuild through a complete snapshot; the
  service is not a wallet or identity-key backup.
- Rerun `bun run test:pack` whenever exports, conditions, declarations, peers,
  or browser dependencies change.

## Rollback

Choose the least destructive rollback that restores a verified state:

1. **Integration rollback:** disable history integration or switch to no-ack
   inspection mode. Message Box transport continues unchanged; pending messages
   must not be acknowledged merely because history storage is unavailable.
2. **Binary rollback without schema rollback:** allowed only when the previous
   binary has been explicitly proven compatible with the current schema. Run its
   configuration and readiness checks before traffic.
3. **Database rollback:** when backward compatibility is not proven, stop the
   service and restore the matching binary plus a transaction-consistent backup.
   Then follow the offline recovery procedure in `RUNBOOK.md`: provide complete
   post-backup deletion receipts, install an externally supplied fresh epoch,
   and keep the service offline if receipt completeness cannot be proven.

A database restore cannot recover post-backup writes. Old cursors and stale
writes must fail after the epoch change, and clients must fully resnapshot.
Never edit migration records, force a checksum, manually repair production rows,
or replay an ambiguous outbound send as a rollback technique.

## Versioning and release record

The owner selected stable npm versioning from 0.1.1; 0.1.3 follows that policy:

- additive public protocol/client exports are minor changes;
- compatible fixes are patch changes;
- incompatible wire, persistence, canonical-key, cursor, authentication, or
  deletion semantics are major changes with an executable migration plan;
- every candidate records its source commit, artifact digest, dependency lock,
  runtime/storage matrix, test evidence, migration impact, and rollback or
  forward-fix decision.

Publication and deployment remain separate explicit approvals even after an
immutable candidate exists.
