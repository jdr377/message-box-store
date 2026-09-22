/**
 * M1 migrations: MySQL 8/Knex reference + deterministic SQLite adapter.
 * Separate schema/credentials from Message Box. Case-sensitive identifiers
 * via utf8mb4_bin (MySQL) / BINARY (SQLite uses BLOB-like TEXT with BINARY
 * comparison by default for `=`).
 *
 * Logical tables per ADR-001:
 * - history_records
 * - history_owner_state (sequence allocator, usage, epoch)
 * - history_changes (versioned upsert/state + minimal delete events)
 * - history_resource_locks (stable owner locks)
 * - history_audit_events (bounded security events, no bodies)
 * - schema_migrations (idempotent runner)
 */

import { createHash } from 'node:crypto'

export const MYSQL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS history_owner_state (
  owner_identity_key VARCHAR(66) NOT NULL PRIMARY KEY,
  epoch VARCHAR(128) NOT NULL DEFAULT 'gen-1',
  next_sequence DECIMAL(20,0) UNSIGNED NOT NULL DEFAULT 1,
  record_count INT UNSIGNED NOT NULL DEFAULT 0,
  byte_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS history_resource_locks (
  owner_identity_key VARCHAR(66) NOT NULL PRIMARY KEY,
  locked_at TIMESTAMP(6) NULL,
  holder VARCHAR(128) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS history_records (
  owner_identity_key VARCHAR(66) NOT NULL,
  record_key CHAR(64) NOT NULL,
  message_id VARCHAR(256) NOT NULL,
  message_box VARCHAR(128) NOT NULL,
  direction ENUM('inbound','outbound') NOT NULL,
  sender VARCHAR(66) NOT NULL,
  recipient VARCHAR(66) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  body_hash CHAR(64) NOT NULL,
  body_bytes INT UNSIGNED NOT NULL,
  delivery_state ENUM('prepared','received','unknown','accepted','failed') NOT NULL DEFAULT 'received',
  revision DECIMAL(20,0) UNSIGNED NOT NULL DEFAULT 1,
  change_sequence DECIMAL(20,0) UNSIGNED NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  archived_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at TIMESTAMP(6) NULL,
  PRIMARY KEY (owner_identity_key, record_key),
  UNIQUE KEY uq_owner_record (owner_identity_key, record_key),
  KEY idx_owner_seq (owner_identity_key, change_sequence, record_key),
  KEY idx_owner_box_created (owner_identity_key, message_box, created_at, record_key),
  KEY idx_owner_dir_created (owner_identity_key, direction, created_at, record_key),
  KEY idx_owner_expires (owner_identity_key, expires_at, record_key),
  CONSTRAINT chk_body_hash CHECK (body_hash REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS history_changes (
  owner_identity_key VARCHAR(66) NOT NULL,
  change_sequence DECIMAL(20,0) UNSIGNED NOT NULL,
  record_key CHAR(64) NOT NULL,
  kind ENUM('upsert','state','delete') NOT NULL,
  version DECIMAL(20,0) UNSIGNED NOT NULL,
  deleted_at TIMESTAMP(6) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (owner_identity_key, change_sequence),
  KEY idx_owner_record_seq (owner_identity_key, record_key, change_sequence),
  KEY idx_owner_seq_record (owner_identity_key, change_sequence, record_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS history_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_identity_key VARCHAR(66) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  record_key CHAR(64) NULL,
  detail VARCHAR(512) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY idx_owner_created (owner_identity_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
`.trim()

export const SQLITE_SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT NOT NULL PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS history_owner_state (
  owner_identity_key TEXT NOT NULL PRIMARY KEY,
  epoch TEXT NOT NULL DEFAULT 'gen-1',
  next_sequence TEXT NOT NULL DEFAULT '1',
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS history_resource_locks (
  owner_identity_key TEXT NOT NULL PRIMARY KEY,
  locked_at TEXT NULL,
  holder TEXT NULL
);

CREATE TABLE IF NOT EXISTS history_records (
  owner_identity_key TEXT NOT NULL,
  record_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_box TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK (body_hash GLOB '[0-9a-f][0-9a-f]*' AND length(body_hash)=64),
  body_bytes INTEGER NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'received' CHECK (delivery_state IN ('prepared','received','unknown','accepted','failed')),
  revision TEXT NOT NULL DEFAULT '1',
  change_sequence TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NULL,
  PRIMARY KEY (owner_identity_key, record_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_record ON history_records(owner_identity_key, record_key);
CREATE INDEX IF NOT EXISTS idx_owner_seq ON history_records(owner_identity_key, change_sequence, record_key);
CREATE INDEX IF NOT EXISTS idx_owner_box_created ON history_records(owner_identity_key, message_box, created_at, record_key);
CREATE INDEX IF NOT EXISTS idx_owner_dir_created ON history_records(owner_identity_key, direction, created_at, record_key);
CREATE INDEX IF NOT EXISTS idx_owner_expires ON history_records(owner_identity_key, expires_at, record_key);

CREATE TABLE IF NOT EXISTS history_changes (
  owner_identity_key TEXT NOT NULL,
  change_sequence TEXT NOT NULL,
  record_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upsert','state','delete')),
  version TEXT NOT NULL,
  deleted_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_identity_key, change_sequence)
);

CREATE INDEX IF NOT EXISTS idx_changes_owner_record_seq ON history_changes(owner_identity_key, record_key, change_sequence);
CREATE INDEX IF NOT EXISTS idx_changes_owner_seq_record ON history_changes(owner_identity_key, change_sequence, record_key);

CREATE TABLE IF NOT EXISTS history_audit_events (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  owner_identity_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_key TEXT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_owner_created ON history_audit_events(owner_identity_key, created_at);
`.trim()

export const MIGRATION_VERSION = '001-init'

/**
 * 002-snapshot-foundation (mbs-8g5.2.3.3): bounded snapshot materialization.
 * history_snapshot_items carry the materialized revision/state/sequence plus
 * stable ordering fields at W. No ciphertext is duplicated: bodies and
 * immutable metadata stay in history_records. Applied after 001-init on both
 * fresh and upgrade databases; every statement is idempotent.
 */
export const MIGRATION_SNAPSHOT_VERSION = '002-snapshot-foundation'

export const MYSQL_SNAPSHOT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_snapshots (
  snapshot_id VARCHAR(64) NOT NULL PRIMARY KEY,
  owner_identity_key VARCHAR(66) NOT NULL,
  epoch VARCHAR(128) NOT NULL,
  filter_hash CHAR(64) NOT NULL,
  watermark DECIMAL(20,0) UNSIGNED NOT NULL,
  status ENUM('active','invalidated') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at TIMESTAMP(6) NOT NULL,
  KEY idx_snapshots_owner_epoch (owner_identity_key, epoch, status),
  KEY idx_snapshots_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS history_snapshot_items (
  snapshot_id VARCHAR(64) NOT NULL,
  record_key CHAR(64) NOT NULL,
  revision_at_w DECIMAL(20,0) UNSIGNED NOT NULL,
  delivery_state_at_w ENUM('prepared','received','unknown','accepted','failed') NOT NULL,
  change_sequence_at_w DECIMAL(20,0) UNSIGNED NOT NULL,
  created_at_at_w TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (snapshot_id, record_key),
  KEY idx_snapshot_items_page (snapshot_id, created_at_at_w, record_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
`.trim()

export const SQLITE_SNAPSHOT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_snapshots (
  snapshot_id TEXT NOT NULL PRIMARY KEY,
  owner_identity_key TEXT NOT NULL,
  epoch TEXT NOT NULL,
  filter_hash TEXT NOT NULL,
  watermark TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalidated')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_owner_epoch ON history_snapshots(owner_identity_key, epoch, status);
CREATE INDEX IF NOT EXISTS idx_snapshots_expiry ON history_snapshots(expires_at);

CREATE TABLE IF NOT EXISTS history_snapshot_items (
  snapshot_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  revision_at_w TEXT NOT NULL,
  delivery_state_at_w TEXT NOT NULL CHECK (delivery_state_at_w IN ('prepared','received','unknown','accepted','failed')),
  change_sequence_at_w TEXT NOT NULL,
  created_at_at_w TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, record_key)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_items_page ON history_snapshot_items(snapshot_id, created_at_at_w, record_key);
`.trim()

/**
 * 003-idempotency (mbs-8g5.2.3.1.1): persisted idempotency identity for
 * patchState/deleteRecord/deleteAll. Same-key + same-params replays the
 * stored result with no new sequence/event/quota/epoch; same-key +
 * different-params fails with ERR_IDEMPOTENCY_CONFLICT. Stored in the same
 * transaction as the mutation so rollback leaves no partial idempotency row.
 */
export const MYSQL_IDEMPOTENCY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_idempotency (
  owner_identity_key VARCHAR(66) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  operation VARCHAR(32) NOT NULL,
  params_hash CHAR(64) NOT NULL,
  result_json MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (owner_identity_key, idempotency_key),
  KEY idx_idempotency_created (owner_identity_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
`.trim()

export const SQLITE_IDEMPOTENCY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_idempotency (
  owner_identity_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('patchState','deleteRecord','deleteAll')),
  params_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_identity_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON history_idempotency(owner_identity_key, created_at);
`.trim()

export const MIGRATION_IDEMPOTENCY_VERSION = '003-idempotency'

/**
 * 004-tombstones (mbs-8g5.2.4.1/.2.4.2/.2.4.3): persistent deletion fences
 * plus per-event delivery-state for fixed-W pages.
 * - history_tombstones persists (owner, record_key) deletion fences beyond
 *   change-retention purge so reupload after purge cannot resurrect deleted
 *   ciphertext (memory already had in-memory tombstones).
 * - history_change_details stores delivery_state per upsert/state event so
 *   fixed-W change pages return the event version, not the current live row.
 * Backfills tombstones from existing delete events (latest numeric sequence
 * wins). Pre-migration versioned events cannot be reconstructed faithfully,
 * so history_change_boundaries records an explicit resync floor. Read paths
 * fail closed instead of substituting later live state.
 */
export const MYSQL_TOMBSTONE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_tombstones (
  owner_identity_key VARCHAR(66) NOT NULL,
  record_key CHAR(64) NOT NULL,
  deleted_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  change_sequence DECIMAL(20,0) UNSIGNED NOT NULL,
  PRIMARY KEY (owner_identity_key, record_key),
  KEY idx_tombstones_owner_seq (owner_identity_key, change_sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS history_change_details (
  owner_identity_key VARCHAR(66) NOT NULL,
  change_sequence DECIMAL(20,0) UNSIGNED NOT NULL,
  delivery_state ENUM('prepared','received','unknown','accepted','failed') NOT NULL,
  PRIMARY KEY (owner_identity_key, change_sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS history_change_boundaries (
  owner_identity_key VARCHAR(66) NOT NULL PRIMARY KEY,
  resync_through_sequence DECIMAL(20,0) UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT IGNORE INTO history_change_boundaries (owner_identity_key, resync_through_sequence)
SELECT owner_identity_key, MAX(change_sequence) FROM history_changes GROUP BY owner_identity_key;

INSERT INTO history_tombstones (owner_identity_key, record_key, deleted_at, change_sequence)
SELECT c.owner_identity_key, c.record_key, COALESCE(c.deleted_at, c.created_at), c.change_sequence
FROM history_changes c
JOIN (SELECT owner_identity_key, record_key, MAX(change_sequence) AS change_sequence FROM history_changes WHERE kind = 'delete' GROUP BY owner_identity_key, record_key) latest
  ON latest.owner_identity_key = c.owner_identity_key AND latest.record_key = c.record_key AND latest.change_sequence = c.change_sequence
ON DUPLICATE KEY UPDATE deleted_at = VALUES(deleted_at), change_sequence = VALUES(change_sequence);
`.trim()

export const SQLITE_TOMBSTONE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_tombstones (
  owner_identity_key TEXT NOT NULL,
  record_key TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  change_sequence TEXT NOT NULL,
  PRIMARY KEY (owner_identity_key, record_key)
);

CREATE INDEX IF NOT EXISTS idx_tombstones_owner_seq ON history_tombstones(owner_identity_key, change_sequence);

CREATE TABLE IF NOT EXISTS history_change_details (
  owner_identity_key TEXT NOT NULL,
  change_sequence TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('prepared','received','unknown','accepted','failed')),
  PRIMARY KEY (owner_identity_key, change_sequence)
);

CREATE TABLE IF NOT EXISTS history_change_boundaries (
  owner_identity_key TEXT NOT NULL PRIMARY KEY,
  resync_through_sequence TEXT NOT NULL
);

INSERT OR IGNORE INTO history_change_boundaries (owner_identity_key, resync_through_sequence)
SELECT owner_identity_key, change_sequence FROM history_changes c
WHERE NOT EXISTS (
  SELECT 1 FROM history_changes newer
  WHERE newer.owner_identity_key = c.owner_identity_key
    AND (length(newer.change_sequence) > length(c.change_sequence)
      OR (length(newer.change_sequence) = length(c.change_sequence) AND newer.change_sequence > c.change_sequence))
);

INSERT OR REPLACE INTO history_tombstones (owner_identity_key, record_key, deleted_at, change_sequence)
SELECT c.owner_identity_key, c.record_key, COALESCE(c.deleted_at, c.created_at), c.change_sequence
FROM history_changes c
WHERE c.kind = 'delete' AND NOT EXISTS (
  SELECT 1 FROM history_changes newer
  WHERE newer.owner_identity_key = c.owner_identity_key AND newer.record_key = c.record_key AND newer.kind = 'delete'
    AND (length(newer.change_sequence) > length(c.change_sequence)
      OR (length(newer.change_sequence) = length(c.change_sequence) AND newer.change_sequence > c.change_sequence))
);
`.trim()

export const MIGRATION_TOMBSTONE_VERSION = '004-tombstones'

/** Split SQL into runnable statements (naive, sufficient for controlled DDL). */
export function splitStatements(sql) {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.endsWith(';') ? s : `${s};`))
}

export { splitStatements as splitMigrationStatements }

/**
 * Ordered versioned migration chains (mbs-8g5.2.3.2). Runners apply missing
 * versions in order, verify the schema, and only then record the version —
 * so an interrupted run reruns safely and a half-applied version is never
 * stamped. Checksums are tamper-evident: any edit to shipped SQL must
 * deliberately update EXPECTED_MIGRATION_CHECKSUMS.
 */
export const MYSQL_MIGRATION_CHAIN = Object.freeze([
  Object.freeze({ version: '001-init', sql: MYSQL_SCHEMA_SQL }),
  Object.freeze({ version: '002-snapshot-foundation', sql: MYSQL_SNAPSHOT_SCHEMA_SQL }),
  Object.freeze({ version: '003-idempotency', sql: MYSQL_IDEMPOTENCY_SCHEMA_SQL }),
  Object.freeze({ version: '004-tombstones', sql: MYSQL_TOMBSTONE_SCHEMA_SQL }),
])

export const SQLITE_MIGRATION_CHAIN = Object.freeze([
  Object.freeze({ version: '001-init', sql: SQLITE_SCHEMA_SQL }),
  Object.freeze({ version: '002-snapshot-foundation', sql: SQLITE_SNAPSHOT_SCHEMA_SQL }),
  Object.freeze({ version: '003-idempotency', sql: SQLITE_IDEMPOTENCY_SCHEMA_SQL }),
  Object.freeze({ version: '004-tombstones', sql: SQLITE_TOMBSTONE_SCHEMA_SQL }),
])

export function checksumMigration(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

export const EXPECTED_MIGRATION_CHECKSUMS = Object.freeze({
  'mysql:001-init': 'bd0823c54f5393d3b3c78afcd30462b5695b4498a2f6334534488adcbc6895a0',
  'mysql:002-snapshot-foundation': '0edc8e585d6cb759dd5d0935c2817a76c08852659c2ddc800c1c718388eba355',
  'mysql:003-idempotency': '49e6082d539f360778660a04f5d596d5a6f4eb57a47e117b63e9b3913fc8b28f',
  'mysql:004-tombstones': 'dff22346ccb1d79fb1833925637a1fcfaba8f1d64ca6c7130bfbf26d0e621e4e',
  'sqlite:001-init': '91a48837f0ba122cfaba9ea619d2e243c05f164ae8b94e13efe529f31e6af600',
  'sqlite:002-snapshot-foundation': 'c35d6a3a30b340d9f8e6efedcc6d0fee943ec260811d57eff2c07b85ff719f8c',
  'sqlite:003-idempotency': '098ee55e6ebccf114b89f246809e0f1d70842c87d709d58365976a809e64ffbc',
  'sqlite:004-tombstones': '39f57c0e9a102227336c15fced4863d28e3ea3b495ae821d2db0418e84b3aad5',
})

export function verifyMigrationChecksums() {
  const actual = {
    'mysql:001-init': checksumMigration(MYSQL_SCHEMA_SQL),
    'mysql:002-snapshot-foundation': checksumMigration(MYSQL_SNAPSHOT_SCHEMA_SQL),
    'mysql:003-idempotency': checksumMigration(MYSQL_IDEMPOTENCY_SCHEMA_SQL),
    'mysql:004-tombstones': checksumMigration(MYSQL_TOMBSTONE_SCHEMA_SQL),
    'sqlite:001-init': checksumMigration(SQLITE_SCHEMA_SQL),
    'sqlite:002-snapshot-foundation': checksumMigration(SQLITE_SNAPSHOT_SCHEMA_SQL),
    'sqlite:003-idempotency': checksumMigration(SQLITE_IDEMPOTENCY_SCHEMA_SQL),
    'sqlite:004-tombstones': checksumMigration(SQLITE_TOMBSTONE_SCHEMA_SQL),
  }
  for (const [key, digest] of Object.entries(actual)) {
    if (EXPECTED_MIGRATION_CHECKSUMS[key] !== digest) {
      const error = new Error(`migration checksum mismatch for ${key}: shipped SQL differs from reviewed text`)
      error.code = 'ERR_MIGRATION_CHECKSUM'
      throw error
    }
  }
  return actual
}

const REQUIRED_TABLES = Object.freeze([
  'schema_migrations',
  'history_owner_state',
  'history_resource_locks',
  'history_records',
  'history_changes',
  'history_audit_events',
  'history_snapshots',
  'history_snapshot_items',
  'history_idempotency',
  'history_tombstones',
  'history_change_details',
  'history_change_boundaries',
])

/** Tables each chain version introduces; used for per-version pre-record checks. */
export const VERSION_TABLES = Object.freeze({
  '001-init': Object.freeze([
    'schema_migrations',
    'history_owner_state',
    'history_resource_locks',
    'history_records',
    'history_changes',
    'history_audit_events',
  ]),
  '002-snapshot-foundation': Object.freeze(['history_snapshots', 'history_snapshot_items']),
  '003-idempotency': Object.freeze(['history_idempotency']),
  '004-tombstones': Object.freeze(['history_tombstones', 'history_change_details', 'history_change_boundaries']),
})

const SQLITE_TABLES = Object.freeze({
  schema_migrations: { columns: { version: ['TEXT', 1, 1], checksum: ['TEXT', 1, 0], applied_at: ['TEXT', 1, 0] }, indexes: {} },
  history_owner_state: { columns: { owner_identity_key: ['TEXT', 1, 1], epoch: ['TEXT', 1, 0], next_sequence: ['TEXT', 1, 0], record_count: ['INTEGER', 1, 0], byte_count: ['INTEGER', 1, 0], updated_at: ['TEXT', 1, 0] }, indexes: {} },
  history_resource_locks: { columns: { owner_identity_key: ['TEXT', 1, 1], locked_at: ['TEXT', 0, 0], holder: ['TEXT', 0, 0] }, indexes: {} },
  history_records: { columns: { owner_identity_key: ['TEXT', 1, 1], record_key: ['TEXT', 1, 2], message_id: ['TEXT', 1, 0], message_box: ['TEXT', 1, 0], direction: ['TEXT', 1, 0], sender: ['TEXT', 1, 0], recipient: ['TEXT', 1, 0], body: ['TEXT', 1, 0], body_hash: ['TEXT', 1, 0], body_bytes: ['INTEGER', 1, 0], delivery_state: ['TEXT', 1, 0], revision: ['TEXT', 1, 0], change_sequence: ['TEXT', 1, 0], created_at: ['TEXT', 1, 0], archived_at: ['TEXT', 1, 0], expires_at: ['TEXT', 0, 0] }, indexes: { uq_owner_record: ['owner_identity_key', 'record_key'], idx_owner_seq: ['owner_identity_key', 'change_sequence', 'record_key'], idx_owner_box_created: ['owner_identity_key', 'message_box', 'created_at', 'record_key'], idx_owner_dir_created: ['owner_identity_key', 'direction', 'created_at', 'record_key'], idx_owner_expires: ['owner_identity_key', 'expires_at', 'record_key'] } },
  history_changes: { columns: { owner_identity_key: ['TEXT', 1, 1], change_sequence: ['TEXT', 1, 2], record_key: ['TEXT', 1, 0], kind: ['TEXT', 1, 0], version: ['TEXT', 1, 0], deleted_at: ['TEXT', 0, 0], created_at: ['TEXT', 1, 0] }, indexes: { idx_changes_owner_record_seq: ['owner_identity_key', 'record_key', 'change_sequence'], idx_changes_owner_seq_record: ['owner_identity_key', 'change_sequence', 'record_key'] } },
  history_audit_events: { columns: { id: ['INTEGER', 1, 1], owner_identity_key: ['TEXT', 1, 0], kind: ['TEXT', 1, 0], record_key: ['TEXT', 0, 0], detail: ['TEXT', 1, 0], created_at: ['TEXT', 1, 0] }, indexes: { idx_audit_owner_created: ['owner_identity_key', 'created_at'] } },
  history_snapshots: { columns: { snapshot_id: ['TEXT', 1, 1], owner_identity_key: ['TEXT', 1, 0], epoch: ['TEXT', 1, 0], filter_hash: ['TEXT', 1, 0], watermark: ['TEXT', 1, 0], status: ['TEXT', 1, 0], created_at: ['TEXT', 1, 0], expires_at: ['TEXT', 1, 0] }, indexes: { idx_snapshots_owner_epoch: ['owner_identity_key', 'epoch', 'status'], idx_snapshots_expiry: ['expires_at'] } },
  history_snapshot_items: { columns: { snapshot_id: ['TEXT', 1, 1], record_key: ['TEXT', 1, 2], revision_at_w: ['TEXT', 1, 0], delivery_state_at_w: ['TEXT', 1, 0], change_sequence_at_w: ['TEXT', 1, 0], created_at_at_w: ['TEXT', 1, 0] }, indexes: { idx_snapshot_items_page: ['snapshot_id', 'created_at_at_w', 'record_key'] } },
  history_idempotency: { columns: { owner_identity_key: ['TEXT', 1, 1], idempotency_key: ['TEXT', 1, 2], operation: ['TEXT', 1, 0], params_hash: ['TEXT', 1, 0], result_json: ['TEXT', 1, 0], created_at: ['TEXT', 1, 0] }, indexes: { idx_idempotency_created: ['owner_identity_key', 'created_at'] } },
  history_tombstones: { columns: { owner_identity_key: ['TEXT', 1, 1], record_key: ['TEXT', 1, 2], deleted_at: ['TEXT', 1, 0], change_sequence: ['TEXT', 1, 0] }, indexes: { idx_tombstones_owner_seq: ['owner_identity_key', 'change_sequence'] } },
  history_change_details: { columns: { owner_identity_key: ['TEXT', 1, 1], change_sequence: ['TEXT', 1, 2], delivery_state: ['TEXT', 1, 0] }, indexes: {} },
  history_change_boundaries: { columns: { owner_identity_key: ['TEXT', 1, 1], resync_through_sequence: ['TEXT', 1, 0] }, indexes: {} },
})

function verifySqliteTableStructure(db, table, { allowMissingChecksum = false } = {}) {
  const definition = SQLITE_TABLES[table]
  const sqlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  if (!sqlRow) throw new Error(`sqlite schema missing table ${table}`)
  const columns = new Map(db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => [row.name, row]))
  for (const [name, [type, notnull, pk]] of Object.entries(definition.columns)) {
    const row = columns.get(name)
    if (!row && allowMissingChecksum && table === 'schema_migrations' && name === 'checksum') continue
    if (!row) throw new Error(`sqlite schema missing column ${table}.${name}`)
    if (String(row.type).toUpperCase() !== type || Number(row.notnull) !== notnull || Number(row.pk) !== pk) {
      throw new Error(`sqlite column ${table}.${name} has unexpected type, nullability or primary-key position`)
    }
  }
  for (const [index, expectedColumns] of Object.entries(definition.indexes)) {
    const indexes = db.prepare(`PRAGMA index_list('${table}')`).all()
    if (!indexes.some((row) => row.name === index)) throw new Error(`sqlite schema missing index ${table}.${index}`)
    const actual = db.prepare(`PRAGMA index_info('${index}')`).all().sort((a, b) => a.seqno - b.seqno).map((row) => row.name)
    if (actual.length !== expectedColumns.length || actual.some((name, i) => name !== expectedColumns[i])) throw new Error(`sqlite schema altered index ${table}.${index}`)
  }
  const sql = String(sqlRow.sql ?? '')
  if (table === 'history_records' && (!/CHECK\s*\(direction IN \('inbound','outbound'\)\)/i.test(sql) || !/CHECK\s*\(delivery_state IN \('prepared','received','unknown','accepted','failed'\)\)/i.test(sql) || !/CHECK\s*\(body_hash GLOB/i.test(sql))) throw new Error('sqlite history_records constraints are missing or altered')
  if (table === 'history_changes' && !/CHECK\s*\(kind IN \('upsert','state','delete'\)\)/i.test(sql)) throw new Error('sqlite history_changes.kind constraint is missing or altered')
  if (table === 'history_snapshots' && !/CHECK\s*\(status IN \('active','invalidated'\)\)/i.test(sql)) throw new Error('sqlite history_snapshots.status constraint is missing or altered')
  if (table === 'history_snapshot_items' && !/CHECK\s*\(delivery_state_at_w IN \('prepared','received','unknown','accepted','failed'\)\)/i.test(sql)) throw new Error('sqlite history_snapshot_items delivery-state constraint is missing or altered')
  if (table === 'history_idempotency' && !/CHECK\s*\(operation IN \('patchState','deleteRecord','deleteAll'\)\)/i.test(sql)) throw new Error('sqlite history_idempotency.operation constraint is missing or altered')
  if (table === 'history_change_details' && !/CHECK\s*\(delivery_state IN \('prepared','received','unknown','accepted','failed'\)\)/i.test(sql)) throw new Error('sqlite history_change_details delivery-state constraint is missing or altered')
  return true
}

export function verifySqliteVersion(db, version, options = {}) {
  const tables = VERSION_TABLES[version]
  if (!tables) throw new Error(`unknown sqlite migration version ${version}`)
  for (const table of tables) verifySqliteTableStructure(db, table, options)
  return true
}

/** Canonical MySQL structure expectations. These are deliberately explicit
 * rather than inferred from the live database, so a recorded version cannot
 * be trusted merely because its tables happen to exist. */
const MYSQL_VERSION_COLUMNS = Object.freeze({
  'schema_migrations': Object.freeze({
    version: 'varchar(64)',
    checksum: 'char(64)',
    applied_at: 'timestamp(6)',
  }),
  history_owner_state: Object.freeze({
    owner_identity_key: 'varchar(66)',
    epoch: 'varchar(128)',
    next_sequence: 'decimal(20,0) unsigned',
    record_count: 'int unsigned',
    byte_count: 'bigint unsigned',
    updated_at: 'timestamp(6)',
  }),
  history_resource_locks: Object.freeze({
    owner_identity_key: 'varchar(66)',
    locked_at: 'timestamp(6)',
    holder: 'varchar(128)',
  }),
  history_records: Object.freeze({
    owner_identity_key: 'varchar(66)',
    record_key: 'char(64)',
    message_id: 'varchar(256)',
    message_box: 'varchar(128)',
    direction: "enum('inbound','outbound')",
    sender: 'varchar(66)',
    recipient: 'varchar(66)',
    body: 'mediumtext',
    body_hash: 'char(64)',
    body_bytes: 'int unsigned',
    delivery_state: "enum('prepared','received','unknown','accepted','failed')",
    revision: 'decimal(20,0) unsigned',
    change_sequence: 'decimal(20,0) unsigned',
    created_at: 'timestamp(6)',
    archived_at: 'timestamp(6)',
    expires_at: 'timestamp(6)',
  }),
  history_changes: Object.freeze({
    owner_identity_key: 'varchar(66)',
    change_sequence: 'decimal(20,0) unsigned',
    record_key: 'char(64)',
    kind: "enum('upsert','state','delete')",
    version: 'decimal(20,0) unsigned',
    deleted_at: 'timestamp(6)',
    created_at: 'timestamp(6)',
  }),
  history_audit_events: Object.freeze({
    id: 'bigint unsigned',
    owner_identity_key: 'varchar(66)',
    kind: 'varchar(64)',
    record_key: 'char(64)',
    detail: 'varchar(512)',
    created_at: 'timestamp(6)',
  }),
  history_snapshots: Object.freeze({
    snapshot_id: 'varchar(64)',
    owner_identity_key: 'varchar(66)',
    epoch: 'varchar(128)',
    filter_hash: 'char(64)',
    watermark: 'decimal(20,0) unsigned',
    status: "enum('active','invalidated')",
    created_at: 'timestamp(6)',
    expires_at: 'timestamp(6)',
  }),
  history_snapshot_items: Object.freeze({
    snapshot_id: 'varchar(64)',
    record_key: 'char(64)',
    revision_at_w: 'decimal(20,0) unsigned',
    delivery_state_at_w: "enum('prepared','received','unknown','accepted','failed')",
    change_sequence_at_w: 'decimal(20,0) unsigned',
    created_at_at_w: 'timestamp(6)',
  }),
  history_idempotency: Object.freeze({
    owner_identity_key: 'varchar(66)',
    idempotency_key: 'varchar(128)',
    operation: 'varchar(32)',
    params_hash: 'char(64)',
    result_json: 'mediumtext',
    created_at: 'timestamp(6)',
  }),
  history_tombstones: Object.freeze({
    owner_identity_key: 'varchar(66)',
    record_key: 'char(64)',
    deleted_at: 'timestamp(6)',
    change_sequence: 'decimal(20,0) unsigned',
  }),
  history_change_details: Object.freeze({
    owner_identity_key: 'varchar(66)',
    change_sequence: 'decimal(20,0) unsigned',
    delivery_state: "enum('prepared','received','unknown','accepted','failed')",
  }),
  history_change_boundaries: Object.freeze({
    owner_identity_key: 'varchar(66)',
    resync_through_sequence: 'decimal(20,0) unsigned',
  }),
})

const MYSQL_VERSION_INDEXES = Object.freeze({
  schema_migrations: Object.freeze({ PRIMARY: ['version'] }),
  history_owner_state: Object.freeze({ PRIMARY: ['owner_identity_key'] }),
  history_resource_locks: Object.freeze({ PRIMARY: ['owner_identity_key'] }),
  history_records: Object.freeze({
    PRIMARY: ['owner_identity_key', 'record_key'],
    uq_owner_record: ['owner_identity_key', 'record_key'],
    idx_owner_seq: ['owner_identity_key', 'change_sequence', 'record_key'],
    idx_owner_box_created: ['owner_identity_key', 'message_box', 'created_at', 'record_key'],
    idx_owner_dir_created: ['owner_identity_key', 'direction', 'created_at', 'record_key'],
    idx_owner_expires: ['owner_identity_key', 'expires_at', 'record_key'],
  }),
  history_changes: Object.freeze({
    PRIMARY: ['owner_identity_key', 'change_sequence'],
    idx_owner_record_seq: ['owner_identity_key', 'record_key', 'change_sequence'],
    idx_owner_seq_record: ['owner_identity_key', 'change_sequence', 'record_key'],
  }),
  history_audit_events: Object.freeze({
    PRIMARY: ['id'],
    idx_owner_created: ['owner_identity_key', 'created_at'],
  }),
  history_snapshots: Object.freeze({
    PRIMARY: ['snapshot_id'],
    idx_snapshots_owner_epoch: ['owner_identity_key', 'epoch', 'status'],
    idx_snapshots_expiry: ['expires_at'],
  }),
  history_snapshot_items: Object.freeze({
    PRIMARY: ['snapshot_id', 'record_key'],
    idx_snapshot_items_page: ['snapshot_id', 'created_at_at_w', 'record_key'],
  }),
  history_idempotency: Object.freeze({
    PRIMARY: ['owner_identity_key', 'idempotency_key'],
    idx_idempotency_created: ['owner_identity_key', 'created_at'],
  }),
  history_tombstones: Object.freeze({
    PRIMARY: ['owner_identity_key', 'record_key'],
    idx_tombstones_owner_seq: ['owner_identity_key', 'change_sequence'],
  }),
  history_change_details: Object.freeze({
    PRIMARY: ['owner_identity_key', 'change_sequence'],
  }),
  history_change_boundaries: Object.freeze({ PRIMARY: ['owner_identity_key'] }),
})

const MYSQL_VERSION_TEXT_COLUMNS = Object.freeze({
  schema_migrations: ['version', 'checksum'],
  history_owner_state: ['owner_identity_key', 'epoch'],
  history_resource_locks: ['owner_identity_key', 'holder'],
  history_records: ['owner_identity_key', 'record_key', 'message_id', 'message_box', 'sender', 'recipient', 'body', 'body_hash', 'delivery_state'],
  history_changes: ['owner_identity_key', 'record_key', 'kind'],
  history_audit_events: ['owner_identity_key', 'kind', 'record_key', 'detail'],
  history_snapshots: ['snapshot_id', 'owner_identity_key', 'epoch', 'filter_hash', 'status'],
  history_snapshot_items: ['snapshot_id', 'record_key', 'delivery_state_at_w'],
  history_idempotency: ['owner_identity_key', 'idempotency_key', 'operation', 'params_hash', 'result_json'],
  history_tombstones: ['owner_identity_key', 'record_key'],
  history_change_details: ['owner_identity_key', 'delivery_state'],
  history_change_boundaries: ['owner_identity_key'],
})

const MYSQL_VERSION_REQUIRED_TABLES = Object.freeze({
  '001-init': Object.freeze(['schema_migrations', 'history_owner_state', 'history_resource_locks', 'history_records', 'history_changes', 'history_audit_events']),
  '002-snapshot-foundation': Object.freeze(['history_snapshots', 'history_snapshot_items']),
  '003-idempotency': Object.freeze(['history_idempotency']),
  '004-tombstones': Object.freeze(['history_tombstones', 'history_change_details', 'history_change_boundaries']),
})

function normalizeMysqlType(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function mysqlCreateSql(rows) {
  const row = rows?.[0]?.[0] ?? {}
  return String(row['Create Table'] ?? row['CREATE TABLE'] ?? Object.values(row)[1] ?? '')
}

async function verifyMysqlTableStructure(knex, table) {
  const tableRows = (await knex.raw(
    `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  ))[0]
  const tableInfo = tableRows[0]
  if (!tableInfo) throw new Error(`mysql schema missing table ${table}`)
  if (String(tableInfo.engine).toUpperCase() !== 'INNODB') throw new Error(`mysql table ${table} must use InnoDB`)
  if (tableInfo.collation !== 'utf8mb4_bin') throw new Error(`mysql table ${table} must use utf8mb4_bin`)

  const columnRows = (await knex.raw(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLLATION_NAME AS collation
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  ))[0]
  const columns = new Map(columnRows.map((row) => [row.name, row]))
  const expectedColumns = MYSQL_VERSION_COLUMNS[table] ?? {}
  for (const [name, expectedType] of Object.entries(expectedColumns)) {
    const row = columns.get(name)
    if (!row) throw new Error(`mysql schema missing column ${table}.${name}`)
    if (normalizeMysqlType(row.type) !== normalizeMysqlType(expectedType)) {
      throw new Error(`mysql column ${table}.${name} has unexpected type`)
    }
  }
  const expectedTextColumns = MYSQL_VERSION_TEXT_COLUMNS[table] ?? []
  for (const name of expectedTextColumns) {
    const row = columns.get(name)
    if (!row || row.collation !== 'utf8mb4_bin') throw new Error(`mysql column ${table}.${name} must use utf8mb4_bin`)
  }

  const indexRows = (await knex.raw(`SHOW INDEX FROM \`${table}\``))[0]
  const actualIndexes = new Map()
  for (const row of indexRows) {
    const name = row.Key_name
    const seq = Number(row.Seq_in_index)
    const columnsForIndex = actualIndexes.get(name) ?? []
    columnsForIndex[seq - 1] = row.Column_name
    actualIndexes.set(name, columnsForIndex)
  }
  const expectedIndexes = MYSQL_VERSION_INDEXES[table] ?? {}
  for (const [name, expectedColumns] of Object.entries(expectedIndexes)) {
    const actualColumns = actualIndexes.get(name)
    if (!actualColumns || actualColumns.length !== expectedColumns.length || actualColumns.some((value, index) => value !== expectedColumns[index])) {
      throw new Error(`mysql schema missing index ${table}.${name} (missing or altered)`)
    }
  }

  const createSql = mysqlCreateSql(await knex.raw(`SHOW CREATE TABLE \`${table}\``))
  if (!createSql) throw new Error(`mysql schema cannot inspect table ${table}`)
  if (table === 'history_records' && !/CONSTRAINT\s+`?chk_body_hash`?\s+CHECK\s*\(/i.test(createSql)) {
    throw new Error('mysql schema missing history_records.body_hash CHECK constraint')
  }
  // The enum types above are part of the canonical constraint surface. This
  // check makes a replacement VARCHAR or altered enum fail closed even if the
  // information-schema type comparison is normalized by the driver.
  if (table === 'history_records' && !/enum\('inbound','outbound'\)/i.test(createSql)) throw new Error('mysql schema missing history_records.direction constraint')
  if (table === 'history_records' && !/enum\('prepared','received','unknown','accepted','failed'\)/i.test(createSql)) throw new Error('mysql schema missing history_records.delivery_state constraint')
  if (table === 'history_changes' && !/enum\('upsert','state','delete'\)/i.test(createSql)) throw new Error('mysql schema missing history_changes.kind constraint')
  if (table === 'history_snapshot_items' && !/enum\('prepared','received','unknown','accepted','failed'\)/i.test(createSql)) throw new Error('mysql schema missing snapshot delivery-state constraint')
  if (table === 'history_snapshots' && !/enum\('active','invalidated'\)/i.test(createSql)) throw new Error('mysql schema missing snapshot status constraint')
  if (table === 'history_change_details' && !/enum\('prepared','received','unknown','accepted','failed'\)/i.test(createSql)) throw new Error('mysql schema missing change-details delivery-state constraint')
  return true
}

/** Structural verification, run before any version is recorded. */
export async function verifyMysqlSchema(knex) {
  for (const table of REQUIRED_TABLES) await verifyMysqlTableStructure(knex, table)
  return true
}

/** Per-version table check used between ordered steps. */
export async function verifyMysqlTables(knex, tables) {
  const present = (await knex.raw(`SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()`))[0].map((r) => r.name)
  for (const table of tables) {
    if (!present.includes(table)) throw new Error(`mysql schema missing table ${table}`)
  }
  return true
}

/** Thorough per-version verification: tables, columns, indexes, collations,
 * constraints and snapshot structures. Runs before a version is recorded. */
export async function verifyMysqlVersion(knex, version) {
  const tablesFor = MYSQL_VERSION_REQUIRED_TABLES[version] ?? VERSION_TABLES[version] ?? []
  await verifyMysqlTables(knex, tablesFor)
  for (const table of tablesFor) await verifyMysqlTableStructure(knex, table)
  return true
}

/** Structural verification for SQLite handles, run before versions are recorded. */
export function verifySqliteSchema(db) {
  for (const version of Object.keys(VERSION_TABLES)) verifySqliteVersion(db, version)
  return true
}
