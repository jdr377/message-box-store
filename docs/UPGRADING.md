# Upgrade, compatibility, and rollback

Status: proposed public prerelease `0.1.0-beta.0` guidance. This document describes the implemented
upgrade boundaries; it does not approve a release, deployment, or compatibility
promise. The release owner must approve the exact artifact and record its digest before publication.

## Compatibility baseline

| Surface | Implemented baseline | Boundary |
|---|---|---|
| Package consumer | Node.js 22+, verified on 22.21.1; ESM, CommonJS, browser-conditioned ESM, and TypeScript declarations | Node 24 and broader runtime support remain release gates. |
| Browser graph | Root, `client`, `protocol`, and `canonical` exports | No server, database, Node built-in, or direct public 1Sat service dependency. |
| Server graph | Express 5.2.1 and pinned BSV authentication/Message Box packages | SDK or transport upgrades require rerunning the free-only and authenticated-HTTP security proofs. |
| Production storage | MySQL 8, Knex `^3.3.0`, mysql2 `^3.11.0` | Memory and SQLite adapters are test/parity evidence, not production promises. |
| Wire/storage contract | Current private v1 protocol, ordered migrations, owner epoch, signed cursors, snapshots, and canonical record keys | Wire or persistence incompatibility requires a major version and explicit migration notes after SemVer begins. |
| Identity | One authenticated identity key owns one partition | Rotation, partition merge, and key recovery are unsupported. |

Exact pinned dependencies and executable evidence are recorded in
[Release evidence](RELEASE_EVIDENCE.md). Treat a dependency update as a product
change when it can affect authenticated HTTP, payment behavior, ciphertext
envelopes, canonical identifiers, cursors, or database semantics.

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

After SemVer is authorized:

- additive public protocol/client exports are minor changes;
- compatible fixes are patch changes;
- incompatible wire, persistence, canonical-key, cursor, authentication, or
  deletion semantics are major changes with an executable migration plan;
- every candidate records its source commit, artifact digest, dependency lock,
  runtime/storage matrix, test evidence, migration impact, and rollback or
  forward-fix decision.

Publication and deployment remain separate explicit approvals even after an
immutable candidate exists.
