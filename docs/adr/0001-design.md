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

4. **Actor and "via".** `actor` is `req.user` when it's an account of the site's auth collection (the `users` option), otherwise null with `system` set.
   - `via` is a small group `{ kind, id, label }` that the site's `via({ req })` resolver fills, for example `{ kind: 'hats', id: <the account switched from> }`, `{ kind: 'guardian', id }` or `{ kind: 'masquerade', id }`.
   - **The plugin imports none of those plugins.** The site composes the resolver from what it has installed; with none, `via` is empty (the person's own account).

5. **The old-value log (the studbook exception), opt-in and narrow.** `values: { <collection>: ['field', …] }` keeps the old and new value of **those fields only**, on update, in a separate `values` field.
   - The plugin **refuses to start** if a listed field is any of:
     - a password or an auth internal;
     - `hidden: true`, or has field `read` access set;
     - marked secret or encrypted (`custom.secret`, `custom.encrypted`, or the two-step plugin's group);
     - inside an array or block (only top-level and group fields can be named);
     - **named in the site's `personal` list** (for example email, names, location, date of birth). That's the owner's "never people's personal details".
   - Values are JSON, capped at `valueMaxBytes` (default 2 KB per field, marked truncated past it).
   - The `values` field has its own read access, `access.values` (default: nobody), separate from reading the trail.

6. **A sink for other plugins.** `recordEvent(payload, { action, subject: { collection, id }, actor?, via?, origin?, system?, reason?, fields?, req? })` writes one entry with the same rules (append-only, no values).
   - `fromPluginEvent(mapper)` adapts a plugin's `onEvent` (Hats, age gate, two-step, Whitehat) in one line.
   - `action` is `create | update | delete` plus the site's `actions` list (for example `masquerade`, `export`, `hats`, `two-step`). An unknown action is refused, not stored as free text.

7. **Retention as a function, no timers.** `pruneAuditTrail(payload, { olderThanDays?, valuesOlderThanDays })`, which the site calls from its daily job, like Sign-up's prune.
   - Clearing old values is separate from deleting entries: values can go after a year while the trail itself is kept.
   - With no arguments, nothing is deleted. The site states its retention.

8. **Reading it.** The admin list and REST and GraphQL read follow `access.read`, which the site gives (for example platform admins only). Filters on subject, actor, action and time are indexed.

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
