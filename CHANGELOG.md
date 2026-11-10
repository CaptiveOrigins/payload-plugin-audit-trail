# Changelog

## 0.1.0 (unreleased)

- `adoptExistingEntries(payload)`: a one-time adoption seal for a site switching from its own audit log, so its unhashed entries pass verify and are tamper-evident from then on (asked for by the Captive Origins site wiring, 2026-11-10). Regular seals cover only hashed entries; prune keeps adopted entries until a cut passes them all.

First version, extracted from Captive Origins' own audit trail, with the decisions in `docs/adr/0001-design.md` (including Platform's read and the owner's choice of a tamper-evident trail): field names never values, same-transaction writes that fail closed, `via`, the opt-in value log with startup refusals, the sink for other plugins, per-record hash chains, seals, retention with checkpoints, and `verifyAuditTrail`. After Platform's read of `21b195e`: autosave is skipped only for a real draft autosave of that record; entries written outside a request transaction get their own; each entry hashes when the one before it was written; pruning cuts only at a seal's end.

Tested: 25 tests. The head check and the conditional seal head were each checked to fail their tests when removed. Not yet used on a site.
