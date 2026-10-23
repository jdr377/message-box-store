# Dependency refresh candidate — 23 October 2026

Candidate: @jdr377/message-box-store@0.1.1, based on 84a5c66.
The owner selected stable version 0.1.1 under latest instead of the preliminary
beta.1 candidate. Runtime files and dependency versions are unchanged by this
version/tag adjustment. Registry publication and live activation are recorded
separately by the release coordinator.

| Dependency | Previous | Candidate |
| --- | --- | --- |
| SDK | 2.7.1 | 3.2.1 |
| Auth middleware | 2.2.3 | 2.2.9 |
| Message Box Client | 2.5.1 | 2.6.0 |
| Express | 5.2.1 | 5.3.0 |
| AuthSocket (test only) | 2.1.7 | 2.1.9 |

The standalone graph satisfies upstream SDK 2/3 peer ranges without overrides.
MapApp currently overrides the SDK to @bopen-io/sdk 4.0.1; its effective
consumer graph requires separate qualification. That application-specific
result does not expand upstream peer support.

No runtime transaction, wire, database migration, ciphertext, epoch, cursor
or wallet-key contract changes. Current SDK rejects completed-request replay
and unsigned redirects before the former application error path. Tests retain
401/no-mutation, exact ciphertext, zero-payment and unknown-send no-retry checks.
The test HTTP and WebSocket fixtures now use one server identity per origin;
the new client correctly rejected their former mismatched identities.

Focused qualification: 115 passed, zero failed across twelve affected files;
one gated live-MySQL check was intentionally skipped. Build, typecheck, lint,
and the 114-package packed ESM/CJS/browser/declaration consumer passed.
Production audit returned zero findings. Clean SDK3/MapApp4 tarball consumers
are a separate release gate, recorded by the downstream application.

Logs are retained in the ignored
.local/dependency-refresh-20261023 directory. No live MySQL tests, service
restart, full suite, wallet action, publication, commit or push is authorized
by this candidate preparation.
