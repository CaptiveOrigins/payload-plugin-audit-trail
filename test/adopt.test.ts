import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adoptExistingEntries, auditTrail, pruneAuditTrail, sealAuditTrail, verifyAuditTrail } from '../src/index.js'

/**
 * A made-up site that kept an audit log before this plugin: entries with the site's own extra fields and no chain
 * fields. Each test starts from an empty trail.
 */
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let mongo: MongoMemoryReplSet
const DAY = 86_400_000

const raw = () => (payload.db as unknown as { collections: Record<string, { collection: { insertMany: (d: object[]) => Promise<unknown>; updateOne: (q: object, u: object) => Promise<unknown>; deleteOne: (q: object) => Promise<unknown>; deleteMany: (q: object) => Promise<unknown> } }> }).collections
/** Writes entries the way the old site did: straight into the collection, with no hash. */
const oldEntries = async (n: number, daysAgo = 30) => {
  const docs = Array.from({ length: n }, (_, i) => ({ at: new Date(Date.now() - daysAgo * DAY + i * 1000), action: 'update', subjectCollection: 'notes', subjectId: `note-${i}`, origin: 'web', changedFields: ['text'], tenant: 't1', run: `run-${i}` }))
  await raw()['audit-events']!.collection.insertMany(docs)
}
const unhashed = async () => (await payload.find({ collection: 'audit-events' as never, where: { hash: { exists: false } } as never, sort: 'at', limit: 0, depth: 0, overrideAccess: true, showHiddenFields: true })).docs as Doc[]
const write = (text: string) => payload.create({ collection: 'notes' as never, data: { text } as never, overrideAccess: true })

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'a-made-up-app-secret-for-tests-only-0123456789',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('adopt'), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [] }, { slug: 'notes', access: { read: () => true }, fields: [{ name: 'text', type: 'text' }] }],
      plugins: [auditTrail({ collections: ['notes'], extraFields: [{ name: 'tenant', type: 'text' }, { name: 'run', type: 'text' }], extra: () => ({ tenant: 't1' }) })],
    }),
  })
}, 120_000)

afterAll(async () => {
  await payload?.destroy?.()
  await mongo?.stop()
})

beforeEach(async () => {
  for (const slug of ['audit-events', 'audit-events-seals', 'audit-events-heads']) await raw()[slug]?.collection.deleteMany({})
})

describe('adopting entries from before chaining', () => {
  it('fails verify before adoption, passes after, and seals new entries around the adopted ones', async () => {
    await oldEntries(5)
    expect((await verifyAuditTrail(payload)).ok).toBe(false)
    expect(await adoptExistingEntries(payload)).toMatchObject({ adopted: 5 })
    await write('after the switch')
    expect(await verifyAuditTrail(payload)).toMatchObject({ ok: true })
    await sealAuditTrail(payload, { now: new Date(Date.now() + DAY) })
    expect(await verifyAuditTrail(payload, { now: new Date(Date.now() + DAY) })).toMatchObject({ ok: true })
  })

  it('does nothing on a second run, and does nothing on a trail with no old entries', async () => {
    expect(await adoptExistingEntries(payload)).toEqual({ adopted: 0, upTo: null })
    await oldEntries(3)
    const first = await adoptExistingEntries(payload)
    expect(first.adopted).toBe(3)
    expect(await adoptExistingEntries(payload)).toEqual({ adopted: 0, upTo: first.upTo })
    const seals = await payload.find({ collection: 'audit-events-seals' as never, where: { kind: { equals: 'adoption' } } as never, overrideAccess: true })
    expect(seals.totalDocs).toBe(1)
  })

  it('breaks when an adopted entry is changed, deleted, or one is added within its range', async () => {
    await oldEntries(4)
    await adoptExistingEntries(payload)
    const [first, second] = await unhashed()
    const events = raw()['audit-events']!.collection

    await events.updateOne({ subjectId: first!.subjectId }, { $set: { subjectId: 'note-x' } })
    expect((await verifyAuditTrail(payload)).firstBreak?.reason).toMatch(/adopted/)
    await events.updateOne({ subjectId: 'note-x' }, { $set: { subjectId: first!.subjectId } })
    expect((await verifyAuditTrail(payload)).ok).toBe(true)

    await events.deleteOne({ subjectId: second!.subjectId })
    expect((await verifyAuditTrail(payload)).firstBreak?.reason).toMatch(/adopted/)
    const { id: _gone, ...back } = second!
    await events.insertMany([{ ...back, at: new Date(back.at) }])
    expect((await verifyAuditTrail(payload)).ok).toBe(true)

    await events.insertMany([{ at: new Date(Date.now() - 30 * DAY + 1500), action: 'update', subjectCollection: 'notes', subjectId: 'slipped-in', origin: 'web' }])
    expect((await verifyAuditTrail(payload)).firstBreak?.reason).toMatch(/adopted/)
  })

  it('breaks on an unhashed entry written after the adoption, and refuses to adopt it', async () => {
    await oldEntries(2)
    await adoptExistingEntries(payload)
    await raw()['audit-events']!.collection.insertMany([{ at: new Date(), action: 'update', subjectCollection: 'notes', subjectId: 'around-the-plugin', origin: 'web' }])
    expect((await verifyAuditTrail(payload)).firstBreak?.reason).toMatch(/after the adoption seal/)
    await expect(adoptExistingEntries(payload)).rejects.toThrow(/written after the adoption seal/)
  })

  it('keeps logged values out of the adoption, so clearing them by age stays possible', async () => {
    await oldEntries(2)
    await raw()['audit-events']!.collection.updateOne({ subjectId: 'note-0' }, { $set: { values: { text: { from: 'a', to: 'b' } } } })
    await adoptExistingEntries(payload)
    await pruneAuditTrail(payload, { valuesOlderThanDays: 7 })
    expect(await verifyAuditTrail(payload)).toMatchObject({ ok: true })
  })

  it('keeps unhashed entries out of a regular seal, and keeps adopted entries through a prune that cuts inside them', async () => {
    await oldEntries(4, 400)
    // A seal that ends between the old entries, made before adoption (the site's seal job ran first).
    const firstAt = (await unhashed())[0]!.at as string
    const inside = new Date(new Date(firstAt).getTime() + 1500)
    await sealAuditTrail(payload, { upTo: inside })
    await adoptExistingEntries(payload)
    expect(await verifyAuditTrail(payload)).toMatchObject({ ok: true })
    await pruneAuditTrail(payload, { olderThanDays: 390 })
    expect(await unhashed()).toHaveLength(4)
    const result = await verifyAuditTrail(payload)
    expect(result.firstBreak?.reason ?? null).toBeNull()
  })

  it('keeps adopted entries through a prune that cuts inside them, and removes them once a cut passes them all', async () => {
    await oldEntries(3, 400)
    await adoptExistingEntries(payload)
    await write('a year later')
    // A seal partway: a prune cuts only at a seal's end.
    const now = new Date()
    await sealAuditTrail(payload, { now: new Date(now.getTime() + DAY) })
    await pruneAuditTrail(payload, { olderThanDays: 1000, now })
    expect(await unhashed()).toHaveLength(3)
    await pruneAuditTrail(payload, { olderThanDays: 0, now: new Date(now.getTime() + 2 * DAY) })
    expect(await unhashed()).toHaveLength(0)
    await raw()['audit-events']!.collection.insertMany([{ at: new Date(now.getTime() - 500 * DAY), action: 'update', subjectCollection: 'notes', subjectId: 'back-dated', origin: 'web' }])
    await expect(adoptExistingEntries(payload)).rejects.toThrow(/pruned/)
    await raw()['audit-events']!.collection.deleteOne({ subjectId: 'back-dated' })
    const result = await verifyAuditTrail(payload, { now: new Date(now.getTime() + 2 * DAY) })
    expect(result.firstBreak?.reason ?? null).toBeNull()
  })
})
