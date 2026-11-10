# ADR 0001: Audit trail for Payload, the design

Status: proposed, 2026-11-10. Lead: Plugin Security. Independent pre-publish security read: Platform. Approved as an agnostic plugin by the owner, 2026-11-10 (relayed by Helm).

## Context

Captive Origins keeps an append-only `audit-events` collection, written by a site plugin (`src/plugins/auditTrail.ts`). It records who changed which fields of which record, from where (manual, web, import, sync, job…), and **never the values**, so the trail can't leak what it records. Every newer plugin (Hats, age gate, Whitehat, account controls) hands its `onEvent` to the site, which writes `audit-events` by hand.

Under `rules/build-it-right.md`, this becomes its own plugin. Two owner decisions from 2026-11-10 shape it:
- a **studbook exception**: an opt-in log of old values for named fields, but "never people's personal details";
- a **"via"**, saying whether a change was made from the person's own account, through Hats, by a guardian or while masquerading, for the coming guardians plugin.

## Decisions

1. **One collection, append-only.** Slug `audit-events` (an option). Create, update and delete access are false for everyone; only the plugin writes, through the Local API. Read access is the site's `access.read` (default: nobody).
   - The field names match the site's collection today (`at`, `action`, `subjectCollection`, `subjectId`, `actor`, `system`, `origin`, `changedFields`, `reason`), so switching over needs **no migration**.
   - Site-only fields (the site's `tenant`, `run`, `subjectUid`, `masquerader`) come in through `extraFields` and an `extra({ req, doc })` resolver, not built in.

2. **What's recorded automatically.** For the collections the site lists (`collections`): create, update and delete, through `afterChange` and `afterDelete`.
   - On update: the names of the top-level fields whose value changed. Relationships compare by id, and array rows by content. An update that changes nothing records nothing.
   - Never listed, even by name: auth internals (`hash`, `salt`, `sessions`, reset tokens, login attempts, lock), timestamps, `_`-prefixed and join fields, plus the site's `ignore` list.
   - `context.audit = false` skips bookkeeping writes. `context.audit = { origin, system, run, reason }` describes automated work.
   - Direct database writes (`payload.db.*`) bypass hooks and aren't recorded. This is documented.

3. **Same transaction, failing closed.** Each entry is written with the change's own `req`, so it commits or rolls back with the change. If the entry can't be written, the change fails: no unaudited change. `onWriteError: 'fail'` (default) or `'log'` for a site that prefers availability, and has to say so explicitly.
   - **Failing closed needs transactions.** At startup (`onInit`) the plugin opens and rolls back a test transaction. If the database can't (no replica set, or transactions off), it **refuses to start unless `onWriteError: 'log'` is set explicitly**, because without transactions a failed entry can't undo the change.

4. **Actor and "via".** `actor` is `req.user` when it's an account of the site's auth collection (the `users` option), otherwise null with `system` set.
   - `via` is a small group `{ kind, id, label }` that the site's `via({ req })` resolver fills, for example `{ kind: 'hats', id: <the account switched from> }`, `{ kind: 'guardian', id }` or `{ kind: 'masquerade', id }`.
   - **The plugin imports none of those plugins.** The site composes the resolver from what it has installed; with none, `via` is empty (the person's own account).

5. **The old-value log (the studbook exception), opt-in and narrow.** `values: { <collection>: ['field', …] }` keeps the old and new value of **those fields only**, on update, in a separate `values` field.
   - The plugin **refuses to start** if a listed field is any of:
     - a relationship (or upload) to the auth collection, such as a studbook's holder, unless the site names it in an explicit `allowPeople` list (`personal` is a deny list, so people-links also need an explicit allow);
     - a password or an auth internal;
     - `hidden: true`, or has field `read` access set;
     - marked secret or encrypted (`custom.secret`, `custom.encrypted`, or the two-step plugin's group);
     - inside an array or block (only top-level and group fields can be named);
     - **named in the site's `personal` list** (for example email, names, location, date of birth). That's the owner's "never people's personal details".
   - Values are JSON, capped at `valueMaxBytes` (default 2 KB per field, marked truncated past it).
   - The `values` field has its own read access, `access.values` (default: nobody), separate from reading the trail.

6. **A sink for other plugins.** `recordEvent(payload, { action, subject: { collection, id }, actor?, via?, origin?, system?, reason?, fields?, req? })` writes one entry with the same rules (append-only, no values).
   - `fromPluginEvent(mapper)` adapts a plugin's `onEvent` (Hats, age gate, two-step, Whitehat) in one line. **If the mapper throws, or returns an unknown action, it throws** (it doesn't skip quietly), so a security event that can't be recorded fails the calling operation as decision 3 does. Whether that undoes the operation depends on the calling plugin awaiting `onEvent` inside its own transaction, and the README says so. `fromPluginEvent(mapper, { onError: 'log' })` is the explicit opt-out for events that are only informational.
   - `action` is `create | update | delete` plus the site's `actions` list (for example `masquerade`, `export`, `hats`, `two-step`). An unknown action is refused, not stored as free text.

7. **Retention as a function, no timers.** `pruneAuditTrail(payload, { olderThanDays?, valuesOlderThanDays })`, which the site calls from its daily job, like Sign-up's prune.
   - Clearing old values is separate from deleting entries: values can go after a year while the trail itself is kept.
   - With no arguments, nothing is deleted. The site states its retention.

8. **Reading it.** The admin list and REST and GraphQL read follow `access.read`, which the site gives (for example platform admins only). Filters on subject, actor, action and time are indexed, `at` on its own too, for prune.
   - The README says `access.values` must be at least as strict as reading the subject records themselves, and that on a multi-site install `access.read` must filter by site.

9. **Failing closed and safe defaults.**
   - Nobody reads by default, and nobody reads values by default.
   - Value fields are checked at startup.
   - An unknown action is refused.
   - A write error fails the change unless the site chose `'log'`.
   - The plugin won't start if `collections` names a collection that doesn't exist.

## What stays in the site

Which collections and fields; the `personal` list; `via` resolution (masq, Hats, guardians); the site-only fields (tenant, import run); who reads; the retention numbers; the admin wording.

## Tests, before 0.1

- Field names only by default, including for relationships, arrays and groups; nothing recorded for an update that changes nothing.
- Auth internals and join fields are never listed; `context.audit = false` skips; the context's origin, system, run and reason land.
- A failed write rolls back the change; `'log'` doesn't.
- `via` from a resolver, and empty without one.
- The value log keeps old and new for listed fields only.
- Startup refusals: hidden, read-restricted, secret or encrypted, in an array, `personal`, and an auth field.
- Truncation past the cap.
- `values` unreadable without `access.values`, and the trail unreadable without `access.read`.
- `recordEvent` and `fromPluginEvent`; an unknown action is refused.
- Prune: values cleared and entries deleted by age; nothing deleted without arguments.
- Compatibility: entries written by the site's current plugin read the same.

## Open

- Recording field paths inside groups (`address.city`) rather than the group's name: left for 0.2. 0.1 keeps the site's current top-level behavior.

## Changes after Platform's pre-publish read (2026-11-10)

Platform read this ADR at `d3f2c8b`. Each point, and what changed:

1. **Must: failing closed needs transactions.** Done in decision 3: a startup check, refusing without transactions unless `onWriteError: 'log'` is explicit. Tests: with transactions, a failed entry rolls back the change; without them, startup refuses, and with `'log'` it starts and logs.
2. **Must: `fromPluginEvent` when the mapper throws or returns an unknown action.** Done in decision 6: it throws by default, and `onError: 'log'` is the explicit opt-out. Tests for both cases.
3. **Should: links to people in the value log.** Done in decision 5: a relationship or upload to the auth collection is refused unless it's in `allowPeople`.
4. **Should: the README on access.** Done in decision 8.
5. **Should: autosave and restores.** Autosave writes of drafts are **not** recorded; publishing and manual saves are. Restoring a version is recorded as an `update`, with `reason: 'restored version <id>'`. Tests for both.
6. **Should: index `at` alone.** Done in decision 8.
7. **Note.** The README says `context.audit.reason` is free text a developer writes and must never carry values; the plugin never fills it from data.

Not changed: append-only access and the startup refusals. Platform agreed both are right.

## Addendum: a tamper-evident trail (2026-11-10)

The owner chose a hash-chained, tamper-evident trail (relayed by Platform, 2026-11-10; the exact words go in `docs/decisions.md` once Platform sends them). Platform listed five points to design in first, since the two-step races came from the same read-then-write pattern. The decisions:

10. **Chains per record, sealed daily across the site.**
    - Each entry joins the chain of its subject (`collection:id`). A small `audit-heads` document per subject holds that chain's last hash and a sequence number. The entry is written and the head moved in **one conditional update**, matched on the previous hash, **inside the change's own transaction**. If the head moved meanwhile, the plugin reads it again and retries a few times.
    - Two changes to the same record at once already conflict in Payload, so this adds no new way to fail. Changes to different records never contend.
    - **Why not one site-wide head per write:** in a transaction, two writers conflicting on one document makes one of them abort. That would make any two simultaneous edits on the site fail.
    - Site-wide ordering comes from a **daily seal** instead. `sealAuditTrail(payload)`, from the site's daily job, takes the entries since the last seal, in order by time then id, up to a grace window (default 10 minutes ago, so transactions still open are left for the next seal). It writes a seal record: `digest = H(previous seal's digest, every entry hash in order)`, plus the count and the range.
    - So within a sealed range an entry can't be added, removed or reordered unnoticed, and within a subject's chain no entry can be changed or dropped.
    - Test: 40 changes at once (to one record and to many) give no fork, and verify passes.

11. **Canonical form.** The hash covers a canonical JSON of the entry: keys sorted, dates as ISO strings, ids and relationship values as strings, missing values as null, `changedFields` sorted. It includes the site's `extraFields`. It never hashes Mongo's stored shape, so re-saving or reading back doesn't change it. Test: a document re-saved unchanged still verifies.

12. **What retention may change.**
    - `values` is **not** in the entry's hash. It has its own `valuesHash` in the entry, so clearing old values (retention) keeps the chain whole while still proving values existed. Verify checks `valuesHash` only where values are still present.
    - **Deleting entries** (`olderThanDays`) cuts history at a recorded point. The prune first writes a **checkpoint seal** recording the last seal digest and the cut-off. Afterwards verify accepts each subject chain's oldest remaining link as its start, and checks seals from the checkpoint on.
    - Tests: values cleared, then verify passes; entries pruned, then verify passes from the checkpoint.

13. **Anchoring outside the database.** A chain only shows tampering if its head is also kept somewhere the database's writers can't reach. `onSeal({ digest, upTo, count })` is called after each seal, so the site can copy it out (a log line, an email to the owner, an object store). The README says plainly: without an anchor, anyone with write access to the database can rewrite the whole chain and every seal consistently.

14. **Verifying.** `verifyAuditTrail(payload, { since? })` recomputes each entry's hash and its link to its subject's previous entry, then each seal's digest. It returns `{ ok, checked, firstBreak?: { id, reason } }`, reporting the first break and never guessing.
    - Tests: an entry edited directly in the database (a field changed, a link changed, an entry deleted within a sealed range) is caught; untouched history passes.

Choices left as stated: SHA-256, hex. `audit-heads` and seals are append-only (access false; only the plugin writes). With `onWriteError: 'log'`, a failed entry also leaves its chain untouched.
