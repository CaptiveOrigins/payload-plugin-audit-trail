import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { BasePayload, buildConfig, type CollectionConfig, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { canonical, entryHash } from '../src/chain.js'
import { auditTrail, pruneAuditTrail, sealAuditTrail, verifyAuditTrail } from '../src/index.js'

/** Each test gets its own made-up site and database, since verify reads the whole trail. */
const SECRET = 'a-made-up-app-secret-for-tests-only-0123456789'
let mongo: MongoMemoryReplSet
let n = 0
const sealed: string[] = []
const notes: CollectionConfig = { slug: 'notes', access: { read: () => true, create: () => true, update: () => true, delete: () => true }, fields: [{ name: 'text', type: 'text' }, { name: 'count', type: 'number' }] }
const users: CollectionConfig = { slug: 'users', auth: true, fields: [] }

async function site(grace = 0, extraFields = [{ name: 'tenant', type: 'text' as const }]) {
  const config = await buildConfig({
    secret: SECRET,
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri(`chain${++n}`), ensureIndexes: true }),
    collections: [users, notes],
    plugins: [auditTrail({ collections: ['notes'], values: { notes: ['count'] }, sealGraceMinutes: grace, extraFields, extra: () => ({ tenant: 't1' }), onSeal: (s) => void sealed.push(s.digest) })],
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

  it('pruning old entries writes a checkpoint first, and what remains verifies', async () => {
    const p = await site()
    const a = await make(p, 'old')
    await sealNow(p)
    // Something newer than the cut, on the same record and a new one.
    await raw(p, 'audit-events').updateMany({}, { $set: { at: new Date(Date.now() - 3 * 86_400_000) } })
    await raw(p, 'audit-events-heads').updateMany({}, { $set: { at: new Date(Date.now() - 3 * 86_400_000) } })
    // Those entries are now "three days old" (their hashes no longer match, but prune removes them all).
    const r = await pruneAuditTrail(p, { olderThanDays: 1 })
    expect(r.deleted).toBeGreaterThan(0)
    await edit(p, a.id, { text: 'after the cut' })
    await make(p, 'new')
    const v = await verifyAuditTrail(p)
    expect(v).toMatchObject({ ok: true })
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
