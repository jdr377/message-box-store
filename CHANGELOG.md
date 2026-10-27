# Changelog

All notable changes to `message-box-store` will be recorded here.

The first proposed public npm prerelease is
`@jdr377/message-box-store@0.1.0-beta.0`. Its original code is under
Open BSV License Version 6, granted by `jdr377`.
This is evaluation versioning, not production release approval.

## 0.1.2 — 27 October 2026

- Use official SDK 4.0.0, auth middleware 2.2.10, Message Box Client 2.6.1
  and test-only AuthSocket 2.1.10. All selected upstream peer declarations
  support SDK 4; no dependency override is required.
- Preserve ciphertext, storage, cursors, wallet ownership and free-only delivery.
  No database or wallet migration is introduced.
- A replayed signed request is now rejected by stock auth middleware with
  HTTP 401 / ERR_AUTH_FAILED before the Store route. Store's own unsigned-request
  gate still returns ERR_AUTHENTICATION_REQUIRED. Fresh signed reads still work.

## 0.1.1 — 23 October 2026

- Update SDK 2.7.1 to 3.2.1, auth middleware 2.2.3 to 2.2.9,
  Message Box Client 2.5.1 to 2.6.0, Express 5.2.1 to 5.3.0 and
  test-only AuthSocket 2.1.7 to 2.1.9. No dependency overrides added.
- Requalify ciphertext, free-only transport, authenticated owner isolation,
  replay rejection, unknown-send recovery, and packed exports. The updated
  SDK refuses unsigned edge redirects; the former redirect limitation is
  superseded for this qualified graph.
- Test fixtures now share the same HTTP/WebSocket server identity, as required
  by the new client identity pinning. Local send options are no longer wire fields.
- No wire/storage schema, migration, key ownership or delivery policy change.
  Existing epoch, ciphertext and cursors are retained. Live database/deployment
  qualification and npm publication remain separate steps.

## 0.1.0-beta.0 — original baseline

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
