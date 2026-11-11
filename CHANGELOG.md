# Changelog

## Unreleased

- `verifyAuditTrail` no longer reads the whole trail into memory (K33). It reads a page at a time (`pageSize`, default 1,000), keeps only the running state, and gives the same answer as before for every case tested. A read that fails, returns more than asked or comes back out of order now gives a failed result naming the place (`ok: false, finished: false`) where a failed read used to throw. Existing calls work unchanged.
- New verify options: `from` (a seal's or checkpoint's digest: check only what was written after it), `stopAfter` (stop after that many entries; the result is not finished, never ok) and `onProgress`. The result gains `finished`, `partial`, `range` and `summary`, so a partial check can't be read as a full one.
- The trail gets a compound index on `chainKey` and `seq`, which verify's paging sorts by. It's declared in the collection's `indexes`, not created by the plugin at startup.
- Fixed: after a second prune, verify reported "a seal doesn't link to the seal before it" on an intact trail. A checkpoint now records, inside its digest, the digest of each seal its cut removes that a remaining seal links to (`pins`), and verify accepts a seal whose predecessor is gone only where a checkpoint recorded it. This also closes a gap: the oldest seal could be removed with its entries, and verify passed. A checkpoint written before this change records nothing, so a trail pruned by an earlier build reports a link break; no version was published with the old format.
- Setting a password (create, update, or a reset by emailed link) records `password` by name, when the stored hash or salt changed. They're never listed, so it used to leave no entry. Found by the Captive Origins site (K428); its tests are ported.
- A hidden or read-restricted field no longer shows as changed on every update. It's compared as stored, read inside the write's transaction before and after, so a change made by a site hook or a restore is still recorded and an unchanged one isn't. Only digests are kept, in memory, per request and per write (a stack, so nested and concurrent writes don't mix), never in `req.context`.
- Several writes at once on one request (a hook fanning out updates) each keep their own reading, keyed by record. An update whose earlier reading is missing fails, or with `onWriteError: 'log'` is logged and recorded from the saved copies; it's never guessed quietly.
- A reset that fails leaves nothing behind on the request: a later sign-in on it forgets the reset's reading.
- An auth collection's create no longer lists `collection`.
- `onWriteError: 'log'` logs the error's name, not its message.
- `fromPluginEvent` finds Payload when an event has no `req`: from the event's `payload`, a `{ payload }` binding, or the one Payload the plugin started on (it refuses to guess between several). MFA's `start(payload, { userId })` raises such an event.
- `fromPluginEvent` no longer rejects a plugin's action when the write fails for an event without a `req`: there's no transaction to undo, so it logs the error's name and returns. A mapper error, an unknown action or origin, or no Payload found still throw, with or without a `req`, as do failed writes with a `req`. `onError: 'fail'` throws always; `onError: 'log'` is as before, now logging the name only.
- The README's `via` example records the Hats hat worn as well as the account, as Hats' README promises.

## 0.1.0 (not yet published)

- From the 2026-11-10 test self-audit: with `onWriteError: 'log'`, a failed entry can no longer undo the change it records (it's written through the database adapter in that mode), and without transactions the chain's head is put back when an entry fails, so verify never reports a break that didn't happen. Events recorded through `recordEvent` get the site's own fields from its `extra` resolver unless the caller gave them.

- `adoptExistingEntries(payload)`: a one-time adoption seal for a site switching from its own audit log, so its unhashed entries pass verify and are tamper-evident from then on (asked for by the Captive Origins site wiring, 2026-11-10). Regular seals cover only hashed entries and continue from the newest seal of any kind; prune keeps adopted entries until a cut passes them all.
- Each entry's hash now covers its logged values' own hash, so removing that hash can't unlock editing the values (found by the adoption's security read).

First version, extracted from Captive Origins' own audit trail, with the decisions in `docs/adr/0001-design.md` (including Platform's read and the owner's choice of a tamper-evident trail): field names never values, same-transaction writes that fail closed, `via`, the opt-in value log with startup refusals, the sink for other plugins, per-record hash chains, seals, retention with checkpoints, and `verifyAuditTrail`. After Platform's read of `21b195e`: autosave is skipped only for a real draft autosave of that record; entries written outside a request transaction get their own; each entry hashes when the one before it was written; pruning cuts only at a seal's end.

Tested: 25 tests. The head check and the conditional seal head were each checked to fail their tests when removed. Not yet used on a site.
