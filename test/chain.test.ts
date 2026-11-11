import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { BasePayload, buildConfig, type CollectionConfig, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { canonical, entryHash } from '../src/chain.js'
import { auditTrail, pruneAuditTrail, recordEvent, sealAuditTrail, verifyAuditTrail, type AuditTrailOptions } from '../src/index.js'

/** Each test gets its own made-up site and database, since verify reads the whole trail. */
const SECRET = 'a-made-up-app-secret-for-tests-only-0123456789'
let mongo: MongoMemoryReplSet
let n = 0
const sealed: { digest: string; kind: string; upTo: string }[] = []
const notes: CollectionConfig = { slug: 'notes', access: { read: () => true, create: () => true, update: () => true, delete: () => true }, fields: [{ name: 'text', type: 'text' }, { name: 'count', type: 'number' }] }
const users: CollectionConfig = { slug: 'users', auth: true, fields: [] }

async function site(grace = 0, extraFields: { name: string; type: 'text'; required?: boolean }[] = [{ name: 'tenant', type: 'text' as const }], more: Partial<AuditTrailOptions> = {}) {
  const config = await buildConfig({
    secret: SECRET,
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri(`chain${++n}`), ensureIndexes: true }),
    collections: [users, notes],
    plugins: [auditTrail({ collections: ['notes'], values: { notes: ['count'] }, sealGraceMinutes: grace, extraFields, extra: () => ({ tenant: 't1' }), onSeal: (s) => void sealed.push(s), ...more })],
  })
  return new BasePayload().init({ config })
}
const make = (p: Payload, text = 'note') => p.create({ collection: 'notes', data: { text, count: 1 } as never, overrideAccess: true }) as unknown as Promise<{ id: string }>
const edit = (p: Payload, id: string, data: Record<string, unknown>) => p.update({ collection: 'notes', id, data: data as never, overrideAccess: true })
const raw = (p: Payload, slug: string) => (p.db as any).collections[slug].collection
const trail = async (p: Payload) => (await p.find({ collection: 'audit-events' as never, sort: ['chainKey', 'seq'], limit: 0, pagination: false, overrideAccess: true, showHiddenFields: true })).docs as unknown as Record<string, any>[]
/** Seals up to now (the test sites have no grace), then waits a moment so later changes fall after the seal. */
const sealNow = async (p: Payload) => {
  const s = await sealAuditTrail(p)
  await new Promise((r) => setTimeout(r, 5))
  return s
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
}, 120_000)
afterAll(async () => {
  await mongo?.stop()
})

describe('the chain', () => {
  it('links each record’s entries in order, and an untouched history verifies, sealed or not', async () => {
    const p = await site()
    const a = await make(p, 'a')
    await edit(p, a.id, { text: 'a2' })
    await edit(p, a.id, { count: 5 })
    const b = await make(p, 'b')
    const t = await trail(p)
    const chainA = t.filter((e) => e.chainKey === `notes:${a.id}`)
    expect(chainA.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(chainA[1]!.prevHash).toBe(chainA[0]!.hash)
    expect(chainA[0]!.prevHash ?? null).toBeNull()
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    expect(await sealNow(p)).toMatchObject({ kind: 'seal', count: 4 })
    expect(sealed.length).toBeGreaterThan(0)
    await edit(p, b.id, { text: 'b2' })
    expect(await verifyAuditTrail(p)).toMatchObject({ ok: true, checked: 5 })
    await p.destroy()
  })

  it('doesn’t fork under 40 changes at once to different records and 10 at once to one', async () => {
    const p = await site()
    const many = await Promise.all(Array.from({ length: 40 }, (_, i) => make(p, `n${i}`)))
    await Promise.all(many.map((m, i) => edit(p, m.id, { text: `changed ${i}` })))
    const one = await make(p, 'busy')
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => edit(p, one.id, { count: 100 + i })))
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    const chain = (await trail(p)).filter((e) => e.chainKey === `notes:${one.id}`)
    expect(chain.map((e) => e.seq)).toEqual(chain.map((_, i) => i + 1)) // no gaps, no two with one parent
    expect(new Set(chain.map((e) => e.prevHash)).size).toBe(chain.length)
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await sealNow(p)
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await p.destroy()
  })
})

describe('catching tampering', () => {
  it('an entry changed in the database', async () => {
    const p = await site()
    const a = await make(p)
    await edit(p, a.id, { text: 'second' })
    await raw(p, 'audit-events').updateOne({ seq: 2 }, { $set: { changedFields: ['count'] } })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/changed after it was written/)
    await p.destroy()
  })

  it('the newest entry deleted before any seal (the head shows it)', async () => {
    const p = await site()
    const a = await make(p)
    await edit(p, a.id, { text: 'second' })
    await raw(p, 'audit-events').deleteOne({ seq: 2 })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/newest entries/)
    await p.destroy()
  })

  it('an entry in the middle deleted, or a forged one put in its place', async () => {
    const p = await site()
    const a = await make(p)
    await edit(p, a.id, { text: 'second' })
    await edit(p, a.id, { text: 'third' })
    const second = (await trail(p))[1]!
    await raw(p, 'audit-events').deleteOne({ seq: 2 })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/missing/)
    // Put back a forged one with the right place and links, but different content: its own hash gives it away.
    const { id: _id, ...rest } = second
    await p.db.create({ collection: 'audit-events', data: { ...rest, changedFields: ['count'] } })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/changed after it was written/)
    await p.destroy()
  })

  it('a whole record’s chain deleted, head and all, after a seal', async () => {
    const p = await site()
    const a = await make(p, 'keep')
    const b = await make(p, 'remove')
    await edit(p, b.id, { text: 'remove 2' })
    await sealNow(p)
    await raw(p, 'audit-events').deleteMany({ chainKey: `notes:${b.id}` })
    await raw(p, 'audit-events-heads').deleteOne({ key: `notes:${b.id}` })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/sealed range/)
    void a
    await p.destroy()
  })

  it('logged values changed, while clearing them for retention keeps the chain whole', async () => {
    const p = await site()
    const a = await make(p)
    await edit(p, a.id, { count: 2 })
    await raw(p, 'audit-events').updateOne({ seq: 2 }, { $set: { 'values.count.after': 999 } })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/values were changed/)
    await raw(p, 'audit-events').updateOne({ seq: 2 }, { $set: { 'values.count.after': 2 } })
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await pruneAuditTrail(p, { valuesOlderThanDays: 0, now: new Date(Date.now() + 60_000) })
    expect((await trail(p))[1]!.values ?? null).toBeNull()
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await p.destroy()
  })
})

describe('seals', () => {
  it('two seals at once don’t fork: one wins, the other does nothing', async () => {
    const p = await site()
    await make(p)
    const [x, y] = await Promise.all([sealNow(p), sealNow(p)])
    expect([x, y].filter(Boolean)).toHaveLength(1)
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await p.destroy()
  })

  it('refuses to reach closer than the grace to now, and warns about entries waiting too long', async () => {
    const p = await site(10)
    await make(p)
    await expect(sealAuditTrail(p, { upTo: new Date() })).rejects.toThrow(/closer than/)
    const later = new Date(Date.now() + 25 * 3_600_000)
    const r = await verifyAuditTrail(p, { now: later })
    expect(r.ok).toBe(true)
    expect(r.warnings[0]).toMatch(/waited more than 24 hours/)
    await p.destroy()
  })

  it('pruning cuts at a seal’s end with a checkpoint; what remains verifies, and losing the first entry after the cut is caught', async () => {
    const p = await site()
    const a = await make(p, 'old')
    // Make that history "three days old" and seal it up to two days ago (its hashes no longer match; prune removes it).
    const old = new Date(Date.now() - 3 * 86_400_000)
    await raw(p, 'audit-events').updateMany({}, { $set: { at: old } })
    await raw(p, 'audit-events-heads').updateMany({}, { $set: { at: old } })
    await sealAuditTrail(p, { upTo: new Date(Date.now() - 2 * 86_400_000) })
    const r = await pruneAuditTrail(p, { olderThanDays: 1 })
    expect(r.deleted).toBeGreaterThan(0)
    await edit(p, a.id, { text: 'after the cut' })
    await edit(p, a.id, { text: 'after the cut, again' })
    await make(p, 'new')
    expect(await verifyAuditTrail(p)).toMatchObject({ ok: true })
    // Deleting the first entry after the cut: the next one's previous entry isn't from before the cut.
    const first = (await trail(p)).find((e) => e.chainKey === `notes:${a.id}`)!
    await raw(p, 'audit-events').deleteOne({ hash: first.hash })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/start of/)
    await p.destroy()
  })
})

describe('the hash itself', () => {
  it('is the same after a read back: missing and null hash the same, and an empty group is nothing', () => {
    expect(canonical({ a: null, b: undefined, c: { d: null } })).toBeNull()
    const base = { at: '2026-11-10T00:00:00.000Z', action: 'update', subjectCollection: 'notes', subjectId: '1', origin: 'manual', chainKey: 'notes:1', seq: 1 }
    // A site adding an extra field later: old entries have none, and hash as they did.
    expect(entryHash({ ...base, extra: {} })).toBe(entryHash({ ...base, extra: { tenant: undefined } }))
    expect(entryHash({ ...base, via: null })).toBe(entryHash({ ...base, via: { kind: null, ref: null, label: null } }))
    expect(entryHash({ ...base, changedFields: ['b', 'a'] })).toBe(entryHash({ ...base, changedFields: ['a', 'b'] }))
    expect(entryHash({ ...base, extra: { tenant: 't1' } })).not.toBe(entryHash(base))
  })
})

// Added by the full self-audit (K30, 2026-11-10): each break verify claims to report, and the guards around it.
/** Rewrites an entry with a new hash that matches its new content, as someone who knows the hash rule would. */
const rehash = (e: Record<string, any>, change: Record<string, unknown>) => {
  const next = { ...e, ...change }
  return { ...change, hash: entryHash({ ...next, extra: next.tenant ? { tenant: next.tenant } : {} } as never) }
}
const seals = async (p: Payload) => (await p.find({ collection: 'audit-events-seals' as never, sort: 'seq', limit: 0, pagination: false, overrideAccess: true })).docs as unknown as Record<string, any>[]

describe('catching tampering, every kind verify names', () => {
  it('an entry relinked to a made-up previous hash, with its own hash recomputed', async () => {
    const p = await site()
    const a = await make(p)
    await edit(p, a.id, { text: 'second' })
    const second = (await trail(p))[1]!
    await raw(p, 'audit-events').updateOne({ seq: 2 }, { $set: rehash(second, { prevHash: 'f'.repeat(64) }) })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/doesn't link to the entry before it/)
    await p.destroy()
  })

  it('a first entry made to link to something, with its own hash recomputed', async () => {
    const p = await site()
    await make(p)
    const first = (await trail(p))[0]!
    await raw(p, 'audit-events').updateOne({ seq: 1 }, { $set: rehash(first, { prevHash: 'f'.repeat(64) }) })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/first entry links to something/)
    await p.destroy()
  })

  it('a site field (extraFields) or the stored hash edited', async () => {
    const p = await site()
    await make(p)
    await raw(p, 'audit-events').updateOne({ seq: 1 }, { $set: { tenant: 't2' } })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/changed after it was written/)
    await raw(p, 'audit-events').updateOne({ seq: 1 }, { $set: { tenant: 't1', hash: '0'.repeat(64) } })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/changed after it was written/)
    await p.destroy()
  })

  it('a record’s whole chain deleted before a seal while its head stays, or its head deleted while the chain stays', async () => {
    const p = await site()
    const a = await make(p)
    await raw(p, 'audit-events').deleteMany({ chainKey: `notes:${a.id}` })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/every entry of this chain is missing/)
    const p2 = await site()
    const b = await make(p2)
    await raw(p2, 'audit-events-heads').deleteOne({ key: `notes:${b.id}` })
    expect((await verifyAuditTrail(p2)).firstBreak?.reason).toMatch(/has no head/)
    await p.destroy()
    await p2.destroy()
  })

  it('a well-formed entry, with its own chain and head, slipped into a sealed range', async () => {
    const p = await site()
    await make(p)
    await sealNow(p)
    const at = (await trail(p))[0]!.at
    const forged = { at, action: 'create', subjectCollection: 'notes', subjectId: 'forged', origin: 'manual', changedFields: ['text'], chainKey: 'notes:forged', seq: 1, prevHash: null, tenant: 't1' }
    const hash = entryHash({ ...forged, extra: { tenant: 't1' } })
    await raw(p, 'audit-events').insertOne({ ...forged, at: new Date(at), hash })
    await raw(p, 'audit-events-heads').insertOne({ key: 'notes:forged', hash, seq: 1, at: new Date(at) })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/sealed range were added, removed, reordered or changed/)
    await p.destroy()
  })

  it('a seal’s digest edited, the newest seal deleted, or a seal in the middle deleted', async () => {
    const p = await site()
    await make(p)
    await sealNow(p)
    await make(p)
    await sealNow(p)
    await make(p)
    await sealNow(p)
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    const [s1, s2, s3] = await seals(p)
    // onSeal got each digest as stored, so a copy kept outside can be compared.
    expect(sealed.slice(-3).map((s) => s.digest)).toEqual([s1!.digest, s2!.digest, s3!.digest])
    await raw(p, 'audit-events-seals').updateOne({ seq: 1 }, { $set: { digest: '0'.repeat(64) } })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/sealed range/)
    await raw(p, 'audit-events-seals').updateOne({ seq: 1 }, { $set: { digest: s1!.digest } })
    await raw(p, 'audit-events-seals').deleteOne({ seq: 3 })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/newest seal is missing or changed/)
    await raw(p, 'audit-events-seals').insertOne({ ...s3, _id: undefined, id: undefined, upTo: new Date(s3!.upTo), fromAt: s3!.fromAt ? new Date(s3!.fromAt) : null })
    await raw(p, 'audit-events-seals').deleteOne({ seq: 2 })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/link to the seal before it/)
    await p.destroy()
  })

  it('a checkpoint moved later, to excuse deleting more', async () => {
    const p = await site()
    await make(p)
    await sealNow(p)
    const future = new Date(Date.now() + 86_400_000)
    await pruneAuditTrail(p, { olderThanDays: 0, now: future })
    expect(sealed.at(-1)?.kind).toBe('checkpoint')
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await raw(p, 'audit-events-seals').updateOne({ kind: 'checkpoint' }, { $set: { upTo: future } })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toMatch(/checkpoint was changed/)
    await p.destroy()
  })

  it('with `since`, links and heads are still checked for older entries', async () => {
    const p = await site()
    const a = await make(p)
    await edit(p, a.id, { text: 'second' })
    await edit(p, a.id, { text: 'third' })
    await raw(p, 'audit-events').deleteOne({ seq: 2 })
    const r = await verifyAuditTrail(p, { since: new Date(Date.now() + 60_000) })
    expect(r.checked).toBe(0)
    expect(r.firstBreak?.reason).toMatch(/missing/)
    await p.destroy()
  })
})

describe('pruning never takes more than it says', () => {
  it('deletes nothing with no seal yet, however old the entries', async () => {
    const p = await site()
    await make(p)
    expect(await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(Date.now() + 30 * 86_400_000) })).toEqual({ valuesCleared: 0, deleted: 0 })
    expect(await trail(p)).toHaveLength(1)
    expect(await seals(p)).toHaveLength(0)
    await p.destroy()
  })

  it('keeps entries after the last seal’s end even when they’re older than asked, and they verify', async () => {
    const p = await site()
    const a = await make(p, 'sealed')
    await sealNow(p)
    await edit(p, a.id, { text: 'after the seal' })
    await make(p, 'also after')
    const r = await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(Date.now() + 86_400_000) })
    expect(r.deleted).toBe(1)
    expect((await trail(p)).map((e) => e.seq).sort()).toEqual([1, 2])
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await p.destroy()
  })
})

describe('who can see or change the trail', () => {
  it('nobody reads it by default; the trail, heads and seals refuse every write, even from someone who may read', async () => {
    const closed = await site()
    await make(closed)
    await expect(closed.find({ collection: 'audit-events' as never, overrideAccess: false })).rejects.toThrow()
    await closed.destroy()

    const p = await site(0, undefined, { access: { read: () => true } })
    const a = await make(p)
    await edit(p, a.id, { count: 2 })
    const seen = (await p.find({ collection: 'audit-events' as never, sort: 'seq', overrideAccess: false })).docs as unknown as Record<string, any>[]
    expect(seen).toHaveLength(2)
    // Reading the trail isn't reading values: `access.values` defaults to nobody.
    expect(seen[1]!.changedFields).toEqual(['count'])
    expect(seen[1]!.values ?? null).toBeNull()
    const id = String(seen[0]!.id)
    await expect(p.create({ collection: 'audit-events' as never, data: { at: new Date().toISOString(), action: 'create', subjectCollection: 'notes', subjectId: 'x', origin: 'manual' } as never, overrideAccess: false })).rejects.toThrow()
    await expect(p.update({ collection: 'audit-events' as never, id, data: { reason: 'edited' } as never, overrideAccess: false })).rejects.toThrow()
    await expect(p.delete({ collection: 'audit-events' as never, id, overrideAccess: false })).rejects.toThrow()
    await sealNow(p)
    for (const slug of ['audit-events-heads', 'audit-events-seals']) {
      await expect(p.find({ collection: slug as never, overrideAccess: false })).rejects.toThrow()
      await expect(p.create({ collection: slug as never, data: { key: 'k', hash: 'h', seq: 1, kind: 'seal', digest: 'd', upTo: new Date().toISOString(), count: 0 } as never, overrideAccess: false })).rejects.toThrow()
    }
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await p.destroy()
  })
})

describe('events recorded outside a request', () => {
  it('open their own transaction: a failed entry leaves the head where it was', async () => {
    const p = await site(0, [{ name: 'tenant', type: 'text', required: true }])
    // recordEvent doesn't run the site's `extra`, so without `tenant` the entry fails validation after the head moved.
    await expect(recordEvent(p, { action: 'update', subject: { collection: 'notes', id: 'n1' }, payload: p })).rejects.toThrow()
    expect((await p.find({ collection: 'audit-events-heads' as never, overrideAccess: true })).docs).toHaveLength(0)
    await recordEvent(p, { action: 'update', subject: { collection: 'notes', id: 'n1' }, payload: p, extra: { tenant: 't1' } })
    expect(await trail(p)).toMatchObject([{ seq: 1, actor: null, origin: 'script' }])
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    await p.destroy()
  })
})
