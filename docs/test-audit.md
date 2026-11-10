# Test audit

## 2026-11-10 (0.1.0)

Each promise in the README and ADR 0001, and the test that proves it:

| Promise | Test |
| --- | --- |
| Field names only; nothing for a no-op update | audit-trail: "names the fields that changed…" |
| Sign-in internals and joins never listed | "never lists sign-in internals…" |
| `audit: false` skips; origin, system, reason land | "skips bookkeeping writes…" |
| `via` from the resolver, empty without | "says how the change was made…" |
| A failed entry undoes the change | "a change whose entry can't be written is undone" |
| No transactions: refuses unless `log`; `log` lets it through | "won't start without transactions…" |
| Value log: named fields only, people only where allowed, capped | "keeps old and new values…" |
| Startup refusals (hidden, read access, secret, personal, people, missing, sign-in) | "refuses at startup to log…" |
| Values and the trail read only with their access | "shows values only to access.values…" |
| Autosave not recorded; restore recorded with its reason | "records publishing and saving…" |
| Sink, unknown actions refused, mapper errors fail unless `log` | "records named events…" |
| Retention: values cleared, entries deleted, nothing without arguments | "clears old values and deletes…" |
| Chain links in order; untouched history verifies | chain: "links each record's entries…" |
| No fork under 40 changes at once and 10 on one record | "doesn't fork…" |
| Tampering caught: edited, newest deleted, middle deleted or forged, whole chain deleted after a seal, values edited | "catching tampering" (the head check fails its test when removed) |
| Two seals at once don't fork | "two seals at once…" (fails when the seal head is unconditional) |
| Seals refuse the grace; overdue entries warn | "refuses to reach closer than the grace…" |
| Pruning writes a checkpoint, and what remains verifies | "pruning old entries…" |
| Hash stable on read back; missing equals null; extra fields added later | "the hash itself" |

Gaps, skipped with reason: Postgres (not supported in 0.1, said in Limits); a verify over a very large trail (`since` exists, a scale test belongs to the site).
