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
| Autosave skips only a real draft autosave of that record: no-drafts collections, `draft: false`, and other records changed by hooks are recorded | "autosave can’t hide a change" |
| Sink, unknown actions refused, mapper errors fail unless `log` | "records named events…" |
| Retention: values cleared, entries deleted only up to a seal, nothing without arguments | "clears old values and deletes…" |
| Chain links in order; untouched history verifies | chain: "links each record's entries…" |
| No fork under 40 changes at once and 10 on one record | "doesn't fork…" |
| Tampering caught: edited, newest deleted, middle deleted or forged, whole chain deleted after a seal, values edited | "catching tampering" (the head check fails its test when removed) |
| Two seals at once don't fork | "two seals at once…" (fails when the seal head is unconditional) |
| Seals refuse the grace; overdue entries warn | "refuses to reach closer than the grace…" |
| Pruning cuts at a seal’s end with a checkpoint; what remains verifies; deleting the first entry after the cut is caught | "pruning cuts at a seal’s end…" |
| Hash stable on read back; missing equals null; extra fields added later | "the hash itself" |

Gaps, skipped with reason: Postgres (not supported in 0.1, said in Limits); a verify over a very large trail (`since` exists, a scale test belongs to the site).

## 2026-11-10: adopting a log kept before the plugin (K26)

| Promise | Test |
| --- | --- |
| Verify fails before adoption and passes after; later entries are sealed around the adopted ones | `adopt > fails verify before adoption…` |
| A second run does nothing; an empty trail adopts nothing | `adopt > does nothing on a second run…` |
| Editing, deleting or adding an adopted-range entry breaks verify | `adopt > breaks when an adopted entry is changed…` |
| An unhashed entry after the adoption breaks verify and can't be adopted | `adopt > breaks on an unhashed entry written after…` |
| Clearing logged values by age keeps adopted entries valid | `adopt > keeps logged values out…` |
| Regular seals leave unhashed entries out; a prune cutting inside the adoption keeps adopted entries | `adopt > keeps unhashed entries out of a regular seal…` |
| A prune past the adoption removes adopted entries and the adoption seal; adopting after a prune is refused | `adopt > keeps adopted entries through a prune…` |

| A seal job before the script, then adoption, a later seal and a prune: nothing reported missing | `adopt > seals after an adoption continue…` |
| Adopted entries' values: clearing is fine, editing or removing their hash is a break | `adopt > covers adopted entries' logged values…` |
| A hashed entry's values hash is covered by its own hash | `adopt > a hashed entry's values hash…` |
| An adoption seal left behind after a prune past it still makes leftover unhashed entries a break | `adopt > still checks unhashed entries…` |

| A hashed entry dated before the newest old entry is still sealed | `adopt > still seals a hashed entry…` |
| An empty hash counts as unhashed in adoption and verify | `adopt > treats an empty hash…` |

Gaps added: thirteen tests in all; the last two after the second read (b104d3b); the last four after the security read of 0d94668 found the seal-continuation blocker, the values gap and the untested leftover check. A mutation check catches every guard but one: leaving the values hash out of the adoption digest survives, because verify's own values check on unhashed entries already catches the same edits. Gaps skipped: an adoption racing a prune isn't tested directly (its reads moved into the seal's transaction, whose head move decides the race, as for seals).
