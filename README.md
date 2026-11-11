# payload-plugin-audit-trail

A tamper-evident audit trail for Payload: who changed which fields of which record, from where and through whom, never the values. Each record's entries are hash-chained, a seal chains them across the site, and a verify reports the first break.

**Status:** early, 0.1.0, not on npm yet. 101 tests pass against a real Payload 3.92 with an in-memory MongoDB (a replica set). They cover what's recorded, failing closed with and without transactions, the value log and its startup refusals, read access, drafts, autosave and restores, the sink for other plugins, retention, and the chain: 40 changes at once without a fork, two seals at once, and tampering caught each way (an entry edited, the newest deleted, one removed or forged, a whole record's chain deleted after a seal, values edited, the first entry after a prune deleted), adopting a log kept before the plugin (verify after it, each kind of tampering with adopted entries, entries written around the plugin, running it twice, and pruning), passwords recorded by name with the password, hash and salt found nowhere in the trail or the logs, hidden fields changed by hooks, restores and bulk updates, concurrent and nested writes sharing a context, and a hook fanning out several account updates at once on one request. Verify is tested a page at a time against the answer the old read-it-all verify gave, for each kind of tampering, on a made-up trail of 3,130 entries read 50 at a time, starting from a seal, stopping early, and with reads that fail or come back out of order. A separate branch tests it with MFA, Hats and Masq installed from npm. It isn't in use on any site yet.

## What it does

- **Field names, never values.** On create, update and delete in the collections you list, an entry records the record, the action, which top-level fields changed, who did it (`actor`), how (`via`: switched in, a guardian, masquerading), and where from (manual, import, sync, job…).
  - An update that changes nothing records nothing. Sign-in internals, timestamps and join fields are never listed.
  - **Passwords by name only.** When a write (a create, an update or a reset by emailed link) changes the stored hash or salt, the entry lists `password`. It's decided from what the database holds, so a site hook that sets or strips the password counts as what really happened. The password, hash and salt never reach an entry, a hash, a log or `req.context`.
  - **Hidden and read-restricted fields** are compared as stored: the plugin reads the record inside the write's transaction before and after it, keeps only a digest of each such field in memory, and lists a field whose stored value changed, whether the caller, a site hook or a restore changed it. The saved copy leaving one out is never a change by itself. This costs two extra reads per update, of those fields only, and only on collections with such fields or sign-in. When a hook writes the same record again inside a write, the inner entry is exact, and the outer entry may also list a hidden field or password the inner write changed: it can over-count, never drop. If either reading can't be made, the change fails, as it does when its entry can't be written; with `onWriteError: 'log'` it goes through, the log says so, and the entry lists what the saved copies show.
  - `context: { audit: false }` skips bookkeeping writes. `context: { audit: { origin, system, run, reason } }` describes automated work. `reason` is free text you write: never put values in it.
- **In the same transaction as the change.** If the entry can't be written, the change fails. That needs transactions, so without a replica set the plugin refuses to start unless you set `onWriteError: 'log'`.
- **With `onWriteError: 'log'`**, a failed entry is logged and the change goes through, with the chain left as it was. A database error inside the transaction itself (a write conflict, say) can still abort the transaction, change included, as any write in it would.
- **Tamper-evident.**
  - Each entry carries the hash of the entry before it for the same record, and a head per record says which entry is newest.
  - `sealAuditTrail(payload)`, run from your job every `sealEveryHours` (default 24; hourly suits a busy site), chains every entry since the last seal into one digest.
  - `verifyAuditTrail(payload)` recomputes all of it and reports the first break, or warnings for entries waiting too long for a seal.
    - It reads the trail a page at a time (`pageSize`, default 1,000) and keeps only the running state, so a very large trail doesn't have to fit in memory. A read that fails, returns more than asked or comes back out of order is a failed verification that names the place, never a pass.
    - `from: digest` checks only what was written after a seal or checkpoint you've verified before (the digest `onSeal` gave you). That seal is recomputed first, so its end can't be moved, and the entries before it are not read. The result says so: `partial: true`, `range`, and a `summary` such as "No break in entries 10,001–12,400 in time order, written after seal 41 (up to 2026-11-01T00:00:00.000Z). The 10,000 entries up to it were not checked." Run a full verify now and then as well: a partial check says nothing about what's before its seal.
    - `stopAfter: n` stops once `n` entries are read and more remain. The result is then `ok: false, finished: false`, with no break named: not finished is never ok.
    - `onProgress` is called after each page of entries and after each seal.
    - `ok` is true only when everything asked for was read and nothing was wrong.
  - **A change is fully protected once it's sealed.** Before that, the record's head still shows a deleted or changed newest entry, but not a whole record removed along with its head.
- **An opt-in value log** for fields you name (`values`), such as a studbook number. It keeps their old and new values. The plugin refuses at startup to log anything hidden, read-restricted, marked secret or encrypted, inside an array, a sign-in field, on your `personal` list, or a link to people not in `allowPeople`. Values are capped at 2 KB a field, readable only by `access.values` (nobody by default), and hashed separately, so clearing them keeps the chain whole.
- **A sink for other plugins.** `recordEvent(payload, { action, subject, req, … })` writes one entry with the same rules. `fromPluginEvent(mapper)` adapts another plugin's `onEvent` in one line.
  - It finds Payload from the entry's or the event's `req` or `payload`, then from `{ payload }` if you bind one (a Payload or a function returning one), then from the one Payload the plugin started on in this process. With several running, it refuses to guess: bind one.
  - A mapper that throws, an unknown action or origin, or no Payload to be found always throws: those are wiring mistakes, so they show at once. A write that fails throws too when the event came with a `req`, so a plugin awaiting `onEvent` in its own transaction has its action undone. Only a write that fails with no `req` logs the error's name (never its message) and returns: there's no transaction to undo, and the action has already happened. `{ onError: 'fail' }` always throws; `{ onError: 'log' }` never does.
  - A dev server's hot reload reuses the same Payload, so it doesn't count twice. A process that starts another Payload without calling `destroy()` on the first makes events without a `req` refuse until you bind one.
- **Retention you run.** `pruneAuditTrail(payload, { valuesOlderThanDays, olderThanDays })` from your job; nothing is deleted without arguments. Entries are cut only at the end of a seal no later than the age you ask for, and a checkpoint seal records the cut first. With no such seal yet, nothing is deleted.

## On its own, and with others

**On its own:** it needs MongoDB with transactions (or `onWriteError: 'log'`), the collections you list, and a users collection for actors. With no other plugin, `via` stays empty and entries come from collection changes and your own `recordEvent` calls.

**Works with:**
- **Hats, Masq and Guardians:** your `via` resolver can use `hatsStateOf(req)`, `masqueraderOf(req)` and `viaGuardian(req)`, so an entry says how a change was made.
- **Age Gate, MFA, Hats and Guardians:** pass their `onEvent` through `fromPluginEvent`, and name their events in `actions`.
- **Masq:** its `onStart` and `onStop` can call `recordEvent` with a `masquerade` action.

The plugin imports none of them. The site connects them in its own config.

**Family:** It's part of the **Compliance** family (a working draft): plugins designed to sit together for records you can stand behind. The other member, Encrypted Fields, isn't built yet.

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
      // With Hats (import { hatsStateOf } from Hats in your site): the account that really signed in, when switched,
      // and the hat worn, as the label. Null on a plain sign-in with every role.
      via: ({ req }) => {
        const s = hatsStateOf(req)
        return s?.via || s?.hat ? { kind: 'hats', id: s.via ?? null, label: s.hat ?? null } : null
      },
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
- Verify reads a page at a time, but it still reads every entry it checks, twice (once along each record's chain, once along the seals), so a full verify of a very large trail takes a while: use `from` between full runs. Sealing reads one interval's entries at once, and adoption the whole old log.
- Verify's paging sorts by each record's chain, which the plugin indexes (`chainKey`, `seq`). The index is built at startup where Payload builds indexes.
- Changes written while a verify runs can show as a break in that run (a head moved after its chain was read). Run it again.
- Two changes to the same record at the same moment already conflict in Payload, so one of them fails, as without this plugin. The same goes for two entries for one record written from different transactions at once (say, a change and a `recordEvent`): the loser fails closed and its change is rolled back. Changes to different records never wait on each other.

## Commands

```bash
npm test          # Vitest, in-memory MongoDB replica set
npm run typecheck
npm run build
```

## License

MIT
