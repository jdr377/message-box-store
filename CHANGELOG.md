# Changelog

All notable changes to `message-box-store` will be recorded here.

The first proposed private GitHub Packages artifact is
`@jdr377/message-box-store@0.1.0-private.0`. Its original code is under
Open BSV License Version 6, granted by `jdr377`; it remains unpublished.
This is evaluation versioning, not public release approval.

## Unreleased

### Added

- Browser-safe protocol, canonicalization, history client, atomic local replica,
  synchronization, and archive-worker exports with ESM, CommonJS, and TypeScript
  declarations.
- Authenticated Express history routes and MySQL 8/Knex production storage with
  bounded quotas, cursor and snapshot feeds, deletion convergence, health,
  readiness, cleanup, and graceful shutdown controls.
- Free-only Message Box transport composition, archive-before-ack inbound flow,
  one-attempt outbound state handling, and same-identity two-device recovery.
- Offline rollback recovery tooling that requires complete external deletion
  receipts and an externally supplied fresh epoch before restored data is served.
- Real packed-tarball verification covering artifact inventory, production
  dependency closure, ESM/CommonJS/browser imports, declarations, and examples.

### Security

- Rejects paid transport paths and owner/capability mismatches before wallet,
  reservation, or transport effects.
- Keeps plaintext and wallet keys outside the history service and redacts
  ciphertext, identity, credential, and database details from operational logs.
- Fails closed when rollback deletion-receipt completeness cannot be established.

### Compatibility and migration

- Requires Node.js 22 or newer; the verified package baseline is Node 22.21.1.
- Uses MySQL 8 with Knex 3.3.x and mysql2 3.x for production persistence.
- Existing Message Box clients remain transport-compatible. Safe history workers
  do not acknowledge pending messages when archive storage is unavailable.
- Identity rotation, paid delivery, automatic resend after ambiguous delivery,
  and recovery of post-backup writes are not supported in v1.
- See [Upgrade, compatibility, and rollback](docs/UPGRADING.md) before changing a
  package, dependency, service binary, or database schema.

### Release status

- No immutable release candidate has been approved or produced.
- Package scope and evaluation version are selected. Third-party notice review,
  supported runtime matrix, independent security acceptance, publication, and
  deployment remain separate release-owner decisions.
