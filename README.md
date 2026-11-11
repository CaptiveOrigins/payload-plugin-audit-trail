# payload-plugin-audit-trail

A tamper-evident audit trail for Payload: who changed which fields of which record, from where and through whom, never the values. Each record's entries are hash-chained, a seal chains them across the site, and a verify reports the first break.

**Status:** early, 0.1.0, not on npm yet. 55 tests pass against a real Payload 3.92 with an in-memory MongoDB (a replica set). They cover what's recorded, failing closed with and without transactions, the value log and its startup refusals, read access, drafts, autosave and restores, the sink for other plugins, retention, and the chain: 40 changes at once without a fork, two seals at once, and tampering caught each way (an entry edited, the newest deleted, one removed or forged, a whole record's chain deleted after a seal, values edited, the first entry after a prune deleted), and adopting a log kept before the plugin (verify after it, each kind of tampering with adopted entries, entries written around the plugin, running it twice, and pruning). It isn't in use on any site yet.

## What it does

- **Field names, never values.** On create, update and delete in the collections you list, an entry records the record, the action, which top-level fields changed, who did it (`actor`), how (`via`: switched in, a guardian, masquerading), and where from (manual, import, sync, job…).
  - An update that changes nothing records nothing. Sign-in internals, timestamps and join fields are never listed.
  - `context: { audit: false }` skips bookkeeping writes. `context: { audit: { origin, system, run, reason } }` describes automated work. `reason` is free text you write: never put values in it.
- **In the same transaction as the change.** If the entry can't be written, the change fails. That needs transactions, so without a replica set the plugin refuses to start unless you set `onWriteError: 'log'`.
- **Tamper-evident.**
  - Each entry carries the hash of the entry before it for the same record, and a head per record says which entry is newest.
  - `sealAuditTrail(payload)`, run from your job every `sealEveryHours` (default 24; hourly suits a busy site), chains every entry since the last seal into one digest.
  - `verifyAuditTrail(payload)` recomputes all of it and reports the first break, or warnings for entries waiting too long for a seal.
  - **A change is fully protected once it's sealed.** Before that, the record's head still shows a deleted or changed newest entry, but not a whole record removed along with its head.
- **An opt-in value log** for fields you name (`values`), such as a studbook number. It keeps their old and new values. The plugin refuses at startup to log anything hidden, read-restricted, marked secret or encrypted, inside an array, a sign-in field, on your `personal` list, or a link to people not in `allowPeople`. Values are capped at 2 KB a field, readable only by `access.values` (nobody by default), and hashed separately, so clearing them keeps the chain whole.
- **A sink for other plugins.** `recordEvent(payload, { action, subject, req, … })` writes one entry with the same rules. `fromPluginEvent(mapper)` adapts another plugin's `onEvent` in one line. It throws if the event can't be recorded, unless you choose `{ onError: 'log' }`.
- **Retention you run.** `pruneAuditTrail(payload, { valuesOlderThanDays, olderThanDays })` from your job; nothing is deleted without arguments. Entries are cut only at the end of a seal no later than the age you ask for, and a checkpoint seal records the cut first. With no such seal yet, nothing is deleted.

## Install

```bash
npm install @captiveorigins/payload-plugin-audit-trail
```

```ts
import { auditTrail } from '@captiveorigins/payload-plugin-audit-trail'

export default buildConfig({
  plugins: [
    auditTrail({
      collections: ['users', 'animals', 'pages'],
      actions: ['masquerade', 'export'],
      access: { read: isAdmin, values: isAdmin },
      via: ({ req }) => (req.context.switchedFrom ? { kind: 'hats', id: String(req.context.switchedFrom) } : null),
      values: { animals: ['studbookNumber'] },
      personal: ['email', 'name', 'location'],
      onSeal: ({ digest, upTo }) => sendToOwner(`Audit seal ${upTo}: ${digest}`),
    }),
  ],
})
```

## Keeping it honest

- **Copy each seal out.** A hash chain only shows tampering if its newest digest is also kept somewhere the database's writers can't reach. Without `onSeal`, anyone with write access to the database can rewrite every entry, head and seal consistently, and verify would pass.
- **`access.values` must be at least as strict as reading the records themselves.** On a multi-site install, `access.read` must filter by site.
- **Writes that skip Payload** (`payload.db.*`, or a database client) aren't recorded, and neither is the plugin's own bookkeeping.
- **Drafts:** a draft autosave of a record isn't recorded; publishing and saving are, and so is any other record a hook changes during an autosave. An autosave flag on a collection without drafts, or on a non-draft save, doesn't skip anything. Restoring a version is recorded as an update with `restored version <id>` as its reason.

## Switching from your own audit log

If the collection already holds entries written before this plugin, they have no hash, and verify reports each one as a break. Run `adoptExistingEntries(payload)` once, as a script, after switching:

- It writes an "adoption" seal into the seal chain. The seal's digest covers every unhashed entry up to the newest of them, by its content. Logged values get their own hash first, and the digest covers that hash: clearing values by age still works, editing them doesn't.
- From then on, verify checks those entries against the digest. Editing, deleting or adding one within that range is a break. An unhashed entry dated after the adoption is a break too, because something wrote around the plugin.
- Running it again does nothing. It refuses if unhashed entries appeared after the adoption, or once the trail has been pruned at all (before or after an adoption), because then they can only be a break. It reads and writes inside the seal's own transaction, so a seal or prune at the same moment can't slip in between.
- Your seal job may run before the script: regular seals skip unhashed entries, and each seal continues from the newest end of any regular seal or checkpoint.
- The whole old log is adopted in one database transaction. MongoDB ends transactions after 60 seconds by default, so a very large log may need that raised for the run.
- Pruning keeps adopted entries until a cut passes all of them, then removes them with the adoption seal, and the checkpoint records the cut.
- What the old entries said before the adoption can't be proven: the seal makes them tamper-evident only from the moment it's written. Copy its digest out with `onSeal`, as with any seal.

## Limits

- MongoDB only for now (it relies on transactions and the adapter's conditional updates).
- Verify reads the whole trail into memory; for very large trails, run it with `since`.
- Two changes to the same record at the same moment already conflict in Payload, so one of them fails, as without this plugin. The same goes for two entries for one record written from different transactions at once (say, a change and a `recordEvent`): the loser fails closed and its change is rolled back. Changes to different records never wait on each other.

## Commands

```bash
npm test          # Vitest, in-memory MongoDB replica set
npm run typecheck
npm run build
```

## License

MIT
