# Test audit

## 2026-11-10: full self-audit (K30)

Every promise in the README, docs/decisions.md and ADR 0001, against the tests at b7a70e8 plus the ones added here (marked K30). Baseline: 38 tests. Now: 52.

| Promise | Test |
| --- | --- |
| Field names only, never values; nothing for a no-op update | audit-trail: "names the fields that changed…" |
| Create and update recorded | the same, and chain: "links each record's entries…" |
| Delete recorded, with no fields | audit-trail: "records a delete, with no fields (K30)" |
| Sign-in internals, timestamps and join fields never listed | "never lists sign-in internals…" |
| `audit: false` skips; origin, system, reason land | "skips bookkeeping writes…" |
| `via` from the resolver, empty without | "says how the change was made…" |
| A failed entry undoes the change (`fail`, with transactions) | "a change whose entry can't be written is undone" |
| No transactions: refuses to start unless `log` | "won't start without transactions…" |
| Value log: named fields only, people only in `allowPeople`, capped at 2 KB | "keeps old and new values…" |
| Startup refusals: hidden, `admin.hidden`, read access, secret, encrypted, personal (by name and as `collection.field`), people links (single and polymorphic), inside an array, sign-in fields (`email`, `password`, `hash`), a missing field | "refuses at startup to log…" and "refuses the rest of its startup cases too (K30)" |
| Startup refusals: `values` naming a missing collection or one not in `collections`, `collections` naming a missing collection, a slug clash | "refuses the rest of its startup cases too (K30)" |
| Nobody reads the trail by default | chain: "nobody reads it by default… (K30)" |
| Reading the trail isn't reading values (`access.values` defaults to nobody) | the same (K30); "shows values only to access.values…" for the admin side |
| The trail, heads and seals refuse create, update and delete for everyone; heads and seals refuse reads | the same (K30) |
| Drafts: autosave not recorded, publish and save are, restore recorded with its reason | "records publishing and saving…" |
| Autosave can't hide a change (no drafts, `draft: false`, other records changed by hooks) | "autosave can't hide a change" (both tests) |
| Sink: named events, unknown actions refused, mapper errors fail unless `log` | "records named events…" |
| Events outside a request open their own transaction, so a failed entry leaves the head alone | chain: "events recorded outside a request… (K30)" |
| No fork under 40 changes at once and 10 on one record | chain: "doesn't fork…" |
| Two seals at once don't fork | "two seals at once…" |
| Seals refuse the grace; overdue entries warn | "refuses to reach closer than the grace…" |
| `onSeal` gets each digest as stored, and the checkpoint too | "a seal's digest edited…" and "a checkpoint moved later…" (K30) |
| Tampering: an entry edited | "an entry changed in the database" |
| Tampering: a site field (`extraFields`) or the stored hash edited | "a site field (extraFields) or the stored hash edited" (K30) |
| Tampering: the newest entry deleted before a seal | "the newest entry deleted…" |
| Tampering: a middle entry deleted, or a forged one put back | "an entry in the middle deleted…" |
| Tampering: an entry relinked, hash recomputed | "an entry relinked…" (K30) |
| Tampering: a first entry made to link to something | "a first entry made to link…" (K30) |
| Tampering: a whole chain deleted before a seal, head kept; a head deleted, chain kept | "a record's whole chain deleted before a seal…" (K30) |
| Tampering: a whole chain and its head deleted after a seal | "a whole record's chain deleted, head and all, after a seal" |
| Tampering: a well-formed entry, with its own chain and head, added in a sealed range | "a well-formed entry… slipped into a sealed range" (K30) |
| Tampering: a seal's digest edited, the newest seal deleted, a middle seal deleted | "a seal's digest edited…" (K30) |
| Tampering: a checkpoint moved later | "a checkpoint moved later…" (K30) |
| Tampering: values edited; clearing them keeps the chain whole | "logged values changed…" |
| Tampering: the first entry after a prune deleted | "pruning cuts at a seal's end…" |
| `since` still checks links and heads | "with `since`, links and heads are still checked…" (K30) |
| Retention: nothing without arguments; values cleared; entries cut only at a seal's end with a checkpoint | "clears old values and deletes…", "pruning cuts at a seal's end…" |
| Retention: nothing deleted with no seal yet | "deletes nothing with no seal yet…" (K30) |
| Retention: entries after the last seal's end kept, even when older than asked | "keeps entries after the last seal's end…" (K30) |
| Hash stable on read back; missing equals null; extra fields added later | "the hash itself" |
| Adoption (the whole section) | adopt.test.ts, mapped in the K26 section below |

**Gaps added (K30), 14 tests:** the tamper cases verify names but no test reached (a relinked entry, a first entry that links, an edited site field or hash, a chain without entries or without a head, an entry slipped into a sealed range, an edited or missing seal, a moved checkpoint, `since`); append-only access on all three collections and the default read and values access; prune with no seal, and prune keeping entries newer than the cut; a delete; the rest of the startup refusals; an event outside a request rolling back its head.

**Mutation check.** Each guard below was broken by a string replace in `src/index.ts`, the matching test file run, and the file restored. Every one made a test fail:

| Guard broken | Caught by |
| --- | --- |
| Verify: an entry's link to the one before | "an entry relinked…" |
| Verify: a first entry with a link | "a first entry made to link…" |
| Verify: a chain with no head | "a record's whole chain deleted before a seal…" |
| Verify: a head with no chain | the same |
| Verify: each seal's link to the one before | "a seal's digest edited…" |
| Verify: the seal head | the same |
| Verify: the checkpoint's digest | "a checkpoint moved later…" |
| Verify: a seal's digest over its range | "a seal's digest edited…" |
| Verify: `extraFields` in the hash | "a site field (extraFields) or the stored hash edited" |
| Prune: no seal, no cut | "deletes nothing with no seal yet…" |
| Prune: cut at a seal's end, not the age asked | "keeps entries after the last seal's end…" and "a checkpoint moved later…" |
| Access: the trail's create, update and delete | "nobody reads it by default…" |
| Access: the trail's default read | the same |
| Access: heads and seals, read and create | the same |
| Access: the values field's default read | the same |
| An event outside a request opening its own transaction | "open their own transaction…" |
| Startup: encrypted, `admin.hidden`, polymorphic people link, `password` and `hash`, `collection.field` in `personal`, `values` outside `collections`, `collections` naming a missing collection, a slug clash | "refuses the rest of its startup cases too" (each guard broken on its own) |

One mutation survived, as expected: dropping the seal's count check. The digest covers every hash in the range, so the count adds nothing verify needs; dropping the digest instead is caught.

**Gaps skipped, and why:**

- "The trail can't record itself": that check can't be reached. `collections` naming the trail fails the "isn't a collection" check first, and a collection with the trail's slug fails "already exists". Both are tested.
- A database writer who rewrites entries, heads and seals consistently: verify can't catch that, by design. The README says so; `onSeal` is the defense, and its digest is tested.
- An unsealed chain deleted after a prune, with its head's `at` backdated: the head's `at` isn't hashed, so this passes verify. It's the README's stated limit (a change is fully protected only once sealed), not a new gap.
- REST and GraphQL access: they run the same access functions as the Local API with `overrideAccess: false`, which is what the tests use.
- Relationship and array comparison (`same`): covered indirectly by the no-op update test; testing it alone would be testing a helper.
- Postgres, a very large trail, and an adoption racing a prune: as in the sections below.

**For the lead (found here, not fixed; `src/` is unchanged):**

1. **`onWriteError: 'log'` with transactions can lose a change silently.** If `payload.create` of the entry fails after the head moved (for example a required `extraFields` field the `extra` resolver left empty), Payload kills the shared transaction. The change is rolled back, but `payload.update` returns as if it worked. The README promises `log` lets the change through.
2. **`onWriteError: 'log'` without transactions leaves a false break.** The same failure moves the head with no entry behind it, so verify reports "the newest entries… are missing or changed" for good. ADR 0001 says a failed entry under `log` leaves its chain untouched.
3. **`recordEvent` doesn't run the site's `extra` resolver.** Sink entries get no site fields (such as `tenant`) unless the caller passes `extra`. On a multi-site install whose `access.read` filters by site, those entries are hidden from that site, or shown to every site if the filter lets an empty site through. Worth a decision.
4. Tests for 1 and 2 once fixed: a no-transaction site with `log` and a required extra field, where verify must still pass; and the same with transactions, where the change must either stick or the call must throw.

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

## 2026-11-10: the self-audit's bugs, fixed

- `onWriteError: 'log'` with transactions: a change whose entry would fail validation is kept, and its entry written (`log-mode > with transactions…`).
- `onWriteError: 'log'` without transactions: the head is put back when an entry fails, and verify stays green; the chain carries on (`log-mode > without transactions…`). The check awaits `req.transactionID`, which Payload can leave as a promise of nothing.
- `recordEvent` fills the site's own fields from `extra`, and the caller's own values win (`log-mode > fills the site's own fields…`).
- With transactions too, a failed entry in 'log' mode puts the head back inside the transaction (`log-mode > with transactions, also puts the head back…`), found by the security read of 77186de.

## 2026-11-11: passwords, unreadable fields and events without a request

From the Captive Origins site's own trail (K428, its tests ported) and the combo test with MFA, Hats and Masq (branch `combo-tests`). Baseline 56 tests, now 64 on main.

| Promise | Test |
| --- | --- |
| A password change is recorded as `password`, and nothing else on an account whose hidden fields weren't read back | audit-trail: "records a password change by name only…" |
| The password, hash and salt are nowhere in the stored entries, heads, seals, request context or logs; verify passes, so no hash input held them either | the same |
| An email change by name, never either address | "records an email change by name only…" (ported) |
| A two-step change by name, never the secret | "records a two-step change by name only…" (ported) |
| Hidden or read-restricted fields count only when the write set them | "counts a hidden or read-restricted field only when the write set it" |
| A password on create and a reset by emailed link are recorded by name; a later sign-in records nothing | "records a password set on a new account, and a reset…" |
| `fromPluginEvent` takes Payload from the event or a binding | "takes Payload from the event, or from a binding" |
| Without a `req`, a failure logs the error's name only and resolves; `onError: 'fail'` rejects; with a `req` the default still rejects | "never rejects the plugin's own action without a request…" |
| Finds the one Payload it started on; refuses to guess between two; forgets one that stopped | log-mode: "refuses to guess between two running Payloads…"; combo: the MFA event without `req` |
| The README's `via` records the hat worn | combo: "records which hat was worn…" |

Mutation-checked: each guard removed fails at least one of these tests (see the commit message). Gaps skipped: a password set by a bulk `update` with `where` is covered by the same code path as an update by id (keyed `collection:*`) and isn't tested separately.

## 2026-11-11: after the security read of ef35392 and the site lead's audit (PR #117)

Now 72 tests on main. Each new test below failed on ef35392 first, except two kept as guards (marked).

| Promise | Test |
| --- | --- |
| A hidden field a site hook changed is recorded; one set to what it was isn't; a user create doesn't list `collection` | "records a hidden field a site hook changed…" |
| A restore that puts a hidden field back is recorded | "records a restore that puts a hidden field back" |
| A bulk update records a read-restricted field per record, and leaves it out where only a readable field changed (guard: passed on ef35392) | "records a bulk update of a read-restricted field…" |
| `password` comes from the stored hash: a field hook that strips it records nothing for it, one that sets it records it | "decides a password changed from the stored hash…" |
| A sign-in after a failed reset on the same request records nothing | "records no password change for a sign-in after a failed reset…" |
| A reset is recorded once; a plain sign-in records nothing (guard) | "records a successful reset once…" |
| Concurrent creates and updates sharing one context object each record their own fields | "two concurrent writes sharing one context object…" |
| A nested write in a hook doesn't clobber the outer one (guard: passed on ef35392, whose keys were per record) | "a nested write inside a hook…" |
| Without a `req`, mapper errors and unknown actions still throw; only a failed write logs its name and returns | "without a request, a failed write logs…" |
