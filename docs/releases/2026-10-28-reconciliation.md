# Store milestone reconciliation — 28 October 2026

`mbs-p61` reconciles the September milestones against retained proof and the
owner-approved public 0.1.2 release. No runtime, dependency, schema, wallet,
service, credential or DNS setting changed. The npm artifact remains immutable.

Completed or retired:

- `.6`: downstream adoption proved by its closed installation, service,
  two-wallet exchange and exact seven-message restore children. WIF plus a
  compatible remote provider is distinct from key-only wallet-record recovery.
- `.6.5`: the obsolete deep hostname is already absent. Recursive DNS and both
  authoritative Cloudflare nameservers return NXDOMAIN; the active
  `history.town.space` health/readiness endpoints return 200. Read-only proof.
- `.5.2`, `.5` and root `mbs-8g5`: retired prerelease aggregates. This does not
  assert every original security or broader deployment criterion passed.

Two substantive follow-ups remain independently visible:

- `mbs-8g5.5.2.4`: independent security acceptance. Maintainer audits are not
  independent sign-off; their three bounded-storage findings were fixed.
- `mbs-8g5.5.2.5`: exact supported deployment matrix and measured capacity.
  Licensing, npm ownership/scope, stable versioning and artifact publication
  are completed decisions, not recurring prerequisites.

README, upgrade guidance and current release evidence now agree on official
SDK 4 and published 0.1.2. Dated security reports retain their findings and add
explicit later dispositions. One stale scaffold assertion still expected
`next`; it now checks the approved `latest` tag and a stable version while
retaining registry/access/license/export boundaries.

Focused verification: five scaffold tests, packed artifact inventory and
114-package ESM/CJS/browser/declaration closure, lint, 45 relative file links
and whitespace checks pass. No full suite was rerun. The original published
archive remains SHA-256
`dc08b8a624b360a9d5751e2b7214310425797cdbd1ab49c4efcd933f3bd1701d`;
public metadata still reports latest=0.1.2. Source documentation corrections
are not a rebuilt or republished version of that archive.

Tracker persistence is separate: `bd dolt remote list` reports no configured
remote. Current issues are retained in the local Dolt database; Git source
pushes alone do not prove remote Beads synchronization. A dedicated follow-up
records that gap; no remote/configuration or tracker migration was invented.

Raw focused logs and the reconciliation command receipt are ignored evidence
under `E:/mapApp/.local/store-reconciliation-20261028/`.
