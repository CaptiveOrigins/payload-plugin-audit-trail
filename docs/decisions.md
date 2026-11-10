# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the ops starter kit, area `captive-origins`.
- 2026-11-10: Plugin Security leads this repo (assigned by Helm). Platform wires it into captive-origins and does the independent pre-publish security read. It goes public from the first push after that audit, with MIT.
- 2026-11-10: design proposed in docs/adr/0001-design.md, before any code (rules/build-it-right.md).
- 2026-11-10: ADR 0001 updated for Platform's pre-publish read (every Must and Should taken; see its last section).
- 2026-11-10: **Tamper-evident.** The owner, verbatim (Helm's chat, about 8:30 PM MST, relayed by Helm): "Audit Trail + tamper-evident (Recommended)". The name stays `payload-plugin-audit-trail`; each entry carries the hash of the previous one in its chain, with a verify command that reports any break (like ops' `ledger.py verify`); "audit log" is in its keywords. Design: ADR 0001's addendum, decisions 10–15.
- 2026-11-10: 0.1.0 built to ADR 0001 with the chain (decisions 10–15); 23 tests.
