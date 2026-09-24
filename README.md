# @jdr377/message-box-store

Encrypted message history for BSV Message Box clients. The package provides an
authenticated history service, client-side archive and synchronization helpers,
and a local replica contract. It stores ciphertext and routing metadata; wallets
keep the keys and decrypt retrieved messages locally.

Message Box remains the delivery transport. History is best effort: it can be
unavailable, purged, or restored from an older backup. An uncertain outbound
send is not retried automatically, and an inbound message is acknowledged only
after its encrypted body is archived.

## Package status

`0.1.0-beta.0` is a proposed public npm prerelease for evaluation. It is
not a production availability promise. Node.js 22+ is
supported; the standalone service uses MySQL 8 with Knex and mysql2. The
browser-facing entry points have no server or database imports.

## Install

After publication to npmjs.com:

```sh
npm install @jdr377/message-box-store@next
```

See [public package paths](docs/PUBLIC_SUBPATHS.md) for the
browser, server, and raw ESM exports.

## Client example

```ts
import { MessageBoxStoreClient, syncHistory } from '@jdr377/message-box-store'

const owner = (await walletClient.getPublicKey({ identityKey: true })).publicKey
const historyClient = new MessageBoxStoreClient({
  walletClient,
  host: 'https://history.example.com',
})

await syncHistory({ owner, historyClient, localReplica })
```

`localReplica` implements the package's `LocalReplica` contract. See the
[complete example](examples/private-history.ts) for synchronization and local
decryption. For delivery, use `createFreeOnlyMessageBoxClient`,
`prepareEncryptedBody`, and `sendPreparedHttpOnce`; the outbound path supports
free transport only.

## Service

The installed `message-box-store` command accepts `check-config`, `migrate`, and
`start`. Configure `MESSAGE_BOX_STORE_SERVER_SECRET` and a dedicated MySQL 8
database through `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, and
`MYSQL_DATABASE`. Run migration before starting the service:

```sh
message-box-store check-config
message-box-store migrate
message-box-store start
```

The [operator runbook](docs/RUNBOOK.md) covers configuration, readiness,
backup and restore, deletion receipts, and failure handling. The
[protocol decisions](docs/M0-DECISIONS.md) and [threat model](docs/M0-THREAT-MODEL.md)
record the security and compatibility boundaries.

## Development

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run test
bun run test:pack
```

The curated `bun run test` suite disables live MySQL tests. Use a dedicated
test database and `node --env-file=.env --test --test-concurrency=1 tests/*.test.mjs`
to run the full database suite. Never point these tests at a service database.

See [release evidence](docs/RELEASE_EVIDENCE.md),
[upgrade guidance](docs/UPGRADING.md), and
[third-party notices](THIRD_PARTY_NOTICES.md).

## License

The original package code is licensed under [Open BSV License Version 6](LICENSE.txt)
by jdr377 for use on the BSV blockchain. Dependencies retain their own
licenses and copyright notices in
[third-party notices](THIRD_PARTY_NOTICES.md).
