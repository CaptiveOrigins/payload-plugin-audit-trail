# Changelog

## 0.1.0 (unreleased)

First version, extracted from Captive Origins' own audit trail, with the decisions in `docs/adr/0001-design.md` (including Platform's read and the owner's choice of a tamper-evident trail): field names never values, same-transaction writes that fail closed, `via`, the opt-in value log with startup refusals, the sink for other plugins, per-record hash chains, seals, retention with checkpoints, and `verifyAuditTrail`.

Tested: 23 tests. The head check and the conditional seal head were each checked to fail their tests when removed. Not yet used on a site.
