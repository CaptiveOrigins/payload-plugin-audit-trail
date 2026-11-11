# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the ops starter kit, area `captive-origins`.
- 2026-11-10: Plugin Security leads this repo (assigned by Helm). Platform wires it into captive-origins and does the independent pre-publish security read. It goes public from the first push after that audit, with MIT.
- 2026-11-10: design proposed in docs/adr/0001-design.md, before any code (rules/build-it-right.md).
- 2026-11-10: ADR 0001 updated for Platform's pre-publish read (every Must and Should taken; see its last section).
- 2026-11-10: **Tamper-evident.** The owner, verbatim (Helm's chat, about 8:30 PM MST, relayed by Helm): "Audit Trail + tamper-evident (Recommended)". The name stays `payload-plugin-audit-trail`; each entry carries the hash of the previous one in its chain, with a verify command that reports any break (like ops' `ledger.py verify`); "audit log" is in its keywords. Design: ADR 0001's addendum, decisions 10–15.
- 2026-11-10: 0.1.0 built to ADR 0001 with the chain (decisions 10–15); 23 tests.

## From the decision feed (ops/decisions/all.md and captive-origins.md), applied 2026-11-10

- D1 decision feeds: this repo's lead reads the feed at startup and after a context summary.
- D2 build it right: the plugin stands alone. It depends on no other plugin; other plugins reach it only through optional adapters.
- D3 owner items: steps and tests for the owner go to ops/inbox/ (rules/owner-items.md).
- D4 priority order, D7 timeline order: work follows ops/timeline-captive-origins.md; nothing here is dated.
- D5 no private repos because of CI: public since 2026-11-10.
- D6 names: the name is on ops/plugin-names.md (owner, 2026-11-10).
- D8 Seed World: the collections this plugin adds were sent to Seed World ahead of the site wiring (2026-11-10). Platform's wiring PR sends the at-merge notice.
- D12 no family tags yet: `compliance` (a draft family name) removed from the keywords before the first publish; the categories stay `security` and `privacy`.
- D9, D10, D11, D13, D14, D15, D16: don't apply to this repo.

- 2026-11-10 (Plugins Lead, K26): `adoptExistingEntries`, as Web Platform asked for the Captive Origins switch. One adoption seal in the seal chain covers every unhashed entry by content (not values), so pre-chain history is tamper-evident from the cutover on. Unhashed entries after it are breaks. Adoption is allowed after regular seals (the site's seal job may run before the script), but refused once the trail has been pruned. Built on branch `adopt-existing`, merging after its security read, so the owner's first publish (N99) includes it.

- 2026-11-10 (K30 self-audit): in `onWriteError: 'log'` mode the entry is written through the database adapter, so a failed entry never undoes the change it records; `fail` mode keeps Payload's validation and undoes the change, as before.
