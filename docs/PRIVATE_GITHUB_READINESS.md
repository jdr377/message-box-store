# Private GitHub package readiness

Source repository: `jdr377/message-box-store`, created and verified **private**.
Target registry artifact: `@jdr377/message-box-store@0.1.0-private.0` on
`https://npm.pkg.github.com`. The registry package has not been published yet.
The package is for private evaluation; this does not approve a public release,
production deployment, license change, or independent security sign-off.

## Proposed first Git push

Commit the current independent repository tree after reviewing `git diff` and
untracked files. Include source, tests, package metadata, README, changelog,
third-party notices, product/decision documents, and the Beads records required
for project continuity. Do not include `.env`, `.local/`, `dist/`, `node_modules/`,
`coverage/`, `package-lock.json`, database files, or credentials; `.gitignore`
excludes them. The package artifact uses an explicit `files` allowlist, and
`bun run test:pack` checks that pack inventory and a clean consumer.

The Git history has 16 commits. A local scan found no tracked sensitive-looking
paths and no private-key, GitHub-token, or AWS-key patterns in commit changes.
Password-assignment pattern hits were confined to runbook examples and tests;
no live credential was printed or committed by this scan. This is a pattern
scan, not an independent security review. Historical product documents mention
MapApp as the first consumer; the package has no MapApp runtime dependency.

## Repository settings

The repository was created under `jdr377` and its private visibility was verified before push.
Keep package access private and verify visibility separately after first npm
publication. Give only the owner write access initially. Require pull-request
review and passing build, typecheck, lint, pack, and full test gates on the
default branch once CI has a dedicated MySQL service. Do not pretend the normal
curated test command covers MySQL; it sets `MESSAGE_BOX_STORE_MYSQL=0`.

## Local validation receipt

- `bun run build`, `bun run typecheck`, `bun run lint`, and `bun run test:pack`: passed.
- Full suite with dedicated MySQL via `node --env-file=.env --test --test-concurrency=1 tests/*.test.mjs`: 349 passed, zero failed, zero skipped.
- Candidate tarball: `.local/jdr377-message-box-store-0.1.0-private.0.tgz`.
- Candidate SHA-256: `286CE8486924A57F68FFD025556B7AD1287E8817F41CEA40308B9C2D6769DF07`.
- `gh auth status` succeeds outside the sandbox as `jdr377`; the token has `repo`
  and `workflow`, but no `read:packages` or `write:packages` scope. Package
  publication and private installation need suitable package credentials in the
  operator environment. Never commit or paste the token.

## Consumer switch

The MapApp proof branch still uses its working local tarball. Once the exact
private version is published, verify its visibility and digest, install it with
an authenticated `bun install`, replace both source imports, pin the exact
version in `package.json` and `bun.lock`, remove the vendor tarball, and run
MapApp's applicable checks. Do not merge the proof branch before that passes.

The private repository was created; no commit, push, npm publication, or MapApp merge is
recorded in this readiness snapshot. Those GitHub writes still require explicit user approval under
Bead `mbs-8g5.5.3` and the private package task `mbs-ikl`.
