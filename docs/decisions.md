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

- 2026-11-11 (fixes for the site wiring, K428 and the combo test; revised after the security read of ef35392): **`fromPluginEvent` stays strict except for a failed write with no `req`.** ADR 0001 decision 6 and Platform's Must 2 stand: a mapper that throws, an unknown action or origin, or no Payload to be found throws with or without a `req`. A failed write throws when the event has a `req`, so a plugin awaiting `onEvent` in its transaction is undone. Only a failed write with no `req` (MFA's `start(payload, { userId })`) logs the error's name, never its message, and returns: the plugin has already saved its state, there's nothing to undo, and rejecting only broke its call. `onError: 'fail'` throws always, `onError: 'log'` never.
- 2026-11-11: an event with no `req` and no `payload` uses `{ payload }` bound to `fromPluginEvent`, else the one Payload the plugin started on in the process (registered in `onInit`, forgotten on `destroy`). With several running it refuses rather than guess which site's trail to write. Payload's hot reload reuses its instance and doesn't rerun `onInit`, so a dev server doesn't grow the list.
- 2026-11-11 (security read of ef35392): **changes the saved copy can't show are decided from the database.** For fields that are hidden or read-restricted, and for the hash and salt, the plugin reads the record inside the write's transaction before it (`beforeChange`, or `beforeOperation` for a restore, whose `beforeChange` gets a copy of `req`) and after it (`afterChange`), and keeps only digests. A field counts when its stored digest changed, and `password` when the hash or salt did; the caller's data plays no part. Per-write state lives in a `WeakMap` keyed by `req`, one stack frame per operation, never in `req.context`, which a caller can share between concurrent writes (from the site lead's audit, PR #117).
- 2026-11-11: **a reset by emailed link is recorded from `afterLogin`, not `afterOperation`.** The site lead preferred `afterOperation` on `resetPassword`, inside the reset's transaction if Payload gives one. It doesn't: Payload commits before `afterOperation`, so an entry written there could fail after the password had already changed. `afterLogin` runs inside the reset's transaction, after the write. It's tied to the reset's own account (found in `beforeValidate`) and its success (the stored hash moved), so a failed reset, or a plain sign-in afterwards, records nothing.
- 2026-11-11 (re-read of 4fbe939): **before-write readings are keyed by request and record, and a missing one fails closed.** Each write adds its own reading under `collection:id` and takes its own back, so several writes at once on one request (a hook fanning out updates) can't drop each other's; creates need none. If an update reaches `afterChange` with no reading from before, or the reading after can't be made, the plugin doesn't fall back to the saved copies: it throws, which undoes the change, as ADR 0001 decision 3 does for an entry that can't be written. With `onWriteError: 'log'` the change goes through, an error is logged, and the entry lists what the copies show. Marking the watched fields "unknown" in the entry was the other choice; it was left out because an entry would then name fields that may not have changed.
- 2026-11-11: a reset's account is found by its link in `beforeOperation`, inside the reset's transaction, replacing the `beforeValidate` hook (a nested write in a site hook could have been taken for it). `afterLogin` records only for that account, and clears the state, so a second sign-in on the same request records nothing.
