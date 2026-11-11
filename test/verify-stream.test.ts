import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { entryHash, sealDigest, sealHasher } from '../src/chain.js'
import { adoptExistingEntries, auditTrail, pruneAuditTrail, sealAuditTrail, verifyAuditTrail, type VerifyArgs, type VerifyProgress, type VerifyResult } from '../src/index.js'
import { legacyVerify } from './legacy-verify.js'

/**
 * Verify reads the trail a page at a time (K33). These tests hold it to the answer the old, read-it-all verify
 * gave, on a made-up site whose trail is emptied before each test.
 */
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let p: Payload
let mongo: MongoMemoryReplSet
const DAY = 86_400_000
const EVENTS = 'audit-events'
const HEADS = 'audit-events-heads'
const SEALS = 'audit-events-seals'
const sealed: { digest: string; kind: string; upTo: string }[] = []

const raw = (slug: string) => (p.db as unknown as { collections: Record<string, { collection: any }> }).collections[slug]!.collection // eslint-disable-line @typescript-eslint/no-explicit-any
const make = (text = 'note') => p.create({ collection: 'notes' as never, data: { text, count: 1 } as never, overrideAccess: true }) as unknown as Promise<{ id: string }>
const edit = (id: string, data: Doc) => p.update({ collection: 'notes' as never, id, data: data as never, overrideAccess: true })
const read = async (slug: string, sort: string[]) => (await p.find({ collection: slug as never, sort, limit: 0, pagination: false, depth: 0, overrideAccess: true, showHiddenFields: true })).docs as unknown as Doc[]
const trail = () => read(EVENTS, ['chainKey', 'seq'])
const seals = () => read(SEALS, ['seq'])
/** Seals up to now (the site has no grace), then waits a moment so later changes fall after the seal. */
const sealNow = async () => {
  const s = await sealAuditTrail(p)
  await new Promise((r) => setTimeout(r, 5))
  return s!
}

const core = (r: VerifyResult | Awaited<ReturnType<typeof legacyVerify>>) => ({ ok: r.ok, checked: r.checked, firstBreak: r.firstBreak, warnings: r.warnings })
/** The old verify and the streaming one, at several page sizes, must say the same thing. Returns what they said. */
async function agree(args: VerifyArgs = {}) {
  const want = await legacyVerify(p, args)
  for (const pageSize of [1, 2, 3, 1000]) {
    const got = await verifyAuditTrail(p, { ...args, pageSize })
    expect(core(got), `page size ${pageSize}`).toEqual(core(want))
    expect(got, `page size ${pageSize}`).toMatchObject({ finished: true, partial: false, range: { from: null, skipped: 0 } })
  }
  return want
}

/** Four records over three seals, with two changes still unsealed: a1 a2 a3 b1 | c1 b2 | c2 d1 | e1 a4. */
async function story() {
  const a = await make('a')
  await edit(a.id, { text: 'a2' })
  await edit(a.id, { count: 2 })
  const b = await make('b')
  const s1 = await sealNow()
  const c = await make('c')
  await edit(b.id, { text: 'b2' })
  const s2 = await sealNow()
  await edit(c.id, { text: 'c2' })
  const d = await make('d')
  const s3 = await sealNow()
  const e = await make('e')
  await edit(a.id, { text: 'a4' })
  const chain = async (id: string) => (await trail()).filter((x) => x.chainKey === `notes:${id}`)
  return { a, b, c, d, e, s1, s2, s3, chain }
}

/** A made-up entry the way the plugin would have written it, for trails too long to write one change at a time. */
function forge(key: string, seq: number, at: Date, prev: { hash: string; at: Date } | null) {
  const base = { at: at.toISOString(), action: 'update', subjectCollection: 'notes', subjectId: key.split(':')[1]!, origin: 'script', changedFields: ['text'] }
  const hash = entryHash({ ...base, chainKey: key, seq, prevHash: prev?.hash ?? null, prevAt: prev?.at.toISOString() ?? null })
  return { ...base, at, chainKey: key, seq, ...(prev ? { prevHash: prev.hash, prevAt: prev.at } : {}), hash }
}

/** `count` entries over `chains` records, one a second from `start`, except `burst` of them sharing one moment. */
async function longTrail(count: number, chains: number, start: number, burst: [number, number]) {
  const heads = new Map<string, { hash: string; seq: number; at: Date }>()
  const docs = []
  for (let j = 0; j < count; j++) {
    const key = `notes:made-${j % chains}`
    const at = new Date(start + (j >= burst[0] && j < burst[1] ? burst[0] : j) * 1000)
    const head = heads.get(key)
    const e = forge(key, (head?.seq ?? 0) + 1, at, head ?? null)
    heads.set(key, { hash: e.hash, seq: e.seq, at })
    docs.push(e)
  }
  await raw(EVENTS).insertMany(docs)
  await raw(HEADS).insertMany([...heads].map(([key, h]) => ({ key, ...h })))
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  p = await getPayload({
    config: await buildConfig({
      secret: 'a-made-up-app-secret-for-tests-only-0123456789',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('stream'), ensureIndexes: true }),
      collections: [
        { slug: 'users', auth: true, fields: [] },
        { slug: 'notes', access: { read: () => true }, fields: [{ name: 'text', type: 'text' }, { name: 'count', type: 'number' }] },
      ],
      plugins: [auditTrail({ collections: ['notes'], values: { notes: ['count'] }, sealGraceMinutes: 0, extraFields: [{ name: 'tenant', type: 'text' }], extra: () => ({ tenant: 't1' }), onSeal: (s) => void sealed.push(s) })],
    }),
  })
}, 120_000)

afterAll(async () => {
  await p?.destroy?.()
  await mongo?.stop()
})

beforeEach(async () => {
  for (const slug of [EVENTS, SEALS, HEADS, 'notes']) await raw(slug).deleteMany({})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the same answer as reading the whole trail', () => {
  it('an empty trail, and an intact one, sealed and not', async () => {
    expect(await agree()).toEqual({ ok: true, checked: 0, warnings: [] })
    const { a } = await story()
    expect(await agree()).toMatchObject({ ok: true, checked: 10 })
    await edit(a.id, { count: 9 })
    expect(await agree()).toMatchObject({ ok: true, checked: 11 })
    expect(await verifyAuditTrail(p)).toMatchObject({ ok: true, checked: 11, finished: true, partial: false, summary: 'No break in all 11 entries.' })
  })

  it('an entry changed: a sealed one, the newest one, a site field, its logged values', async () => {
    const { a, e, chain } = await story()
    const [a1, , a3, a4] = await chain(a.id)
    for (const [target, change] of [
      [a1, { reason: 'made up' }],
      [a4, { reason: 'made up' }],
      [a1, { tenant: 't2' }],
      [(await chain(e.id))[0], { origin: 'import' }],
    ] as [Doc, Doc][]) {
      await raw(EVENTS).updateOne({ hash: target.hash }, { $set: change })
      expect((await agree()).firstBreak).toEqual({ id: String(target.id), reason: 'the entry was changed after it was written' })
      await raw(EVENTS).updateOne({ hash: target.hash }, { $unset: { reason: '' }, $set: { tenant: 't1', origin: target.origin } })
      expect((await agree()).ok).toBe(true)
    }
    await raw(EVENTS).updateOne({ hash: a3!.hash }, { $set: { values: { count: { before: 1, after: 99 } } } })
    expect((await agree()).firstBreak?.reason).toBe('its logged values were changed')
  })

  it('an entry deleted: the newest, one in the middle, the first, a whole chain with or without its head', async () => {
    for (const [pick, reason] of [
      [3, /newest entries of notes:.* are missing or changed/],
      [1, /an entry before it in notes:.* is missing/],
      [0, /the start of notes:.* is missing/],
    ] as [number, RegExp][]) {
      const { a, chain } = await story()
      await raw(EVENTS).deleteOne({ hash: (await chain(a.id))[pick]!.hash })
      expect((await agree()).firstBreak?.reason).toMatch(reason)
      for (const slug of [EVENTS, SEALS, HEADS, 'notes']) await raw(slug).deleteMany({})
    }
    const { c, d, e } = await story()
    // Unsealed: the head still says the chain was there.
    await raw(EVENTS).deleteMany({ chainKey: `notes:${e.id}` })
    expect((await agree()).firstBreak).toEqual({ id: `notes:${e.id}`, reason: 'every entry of this chain is missing' })
    await raw(HEADS).deleteOne({ key: `notes:${e.id}` })
    expect((await agree()).ok).toBe(true) // an unsealed chain gone with its head: the README's stated limit
    // Sealed: the seal's digest shows it, head or no head.
    await raw(EVENTS).deleteMany({ chainKey: `notes:${d.id}` })
    await raw(HEADS).deleteOne({ key: `notes:${d.id}` })
    expect((await agree()).firstBreak?.reason).toMatch(/sealed range/)
    // A chain whose head is gone.
    await raw(HEADS).deleteOne({ key: `notes:${c.id}` })
    expect((await agree()).firstBreak).toEqual({ id: `notes:${c.id}`, reason: 'this chain has no head (it was added outside the plugin)' })
  })

  it('a head deleted while its chain stays, and several head breaks at once in the old order', async () => {
    const { a, b, c, e, chain } = await story()
    await raw(HEADS).deleteOne({ key: `notes:${b.id}` })
    expect((await agree()).firstBreak).toEqual({ id: `notes:${b.id}`, reason: 'this chain has no head (it was added outside the plugin)' })
    // No head for b, a wrong head for a, entries gone for e, no head for c: whichever the old verify named, this names.
    await raw(HEADS).updateOne({ key: `notes:${a.id}` }, { $set: { seq: 9 } })
    expect((await agree()).firstBreak?.reason).toMatch(/newest entries/)
    await raw(EVENTS).deleteMany({ chainKey: `notes:${e.id}` })
    await raw(HEADS).deleteOne({ key: `notes:${c.id}` })
    expect((await agree()).firstBreak?.reason).toMatch(/newest entries|every entry/)
    // An entry break still comes before any of them.
    const a2 = (await chain(a.id))[1]!
    await raw(EVENTS).updateOne({ hash: a2.hash }, { $set: { reason: 'made up' } })
    expect((await agree()).firstBreak).toEqual({ id: String(a2.id), reason: 'the entry was changed after it was written' })
  })

  it('entries reordered: two swapped in their chain, two swapped in time, one relinked, a forged one in a sealed range', async () => {
    const { a, b, chain } = await story()
    const [a1, a2, a3] = await chain(a.id)
    await raw(EVENTS).updateOne({ hash: a1!.hash }, { $set: { seq: 2 } })
    await raw(EVENTS).updateOne({ hash: a2!.hash }, { $set: { seq: 1 } })
    expect((await agree()).ok).toBe(false)
    await raw(EVENTS).updateOne({ hash: a1!.hash }, { $set: { seq: 1 } })
    await raw(EVENTS).updateOne({ hash: a2!.hash }, { $set: { seq: 2 } })
    expect((await agree()).ok).toBe(true)
    const b1 = (await chain(b.id))[0]!
    await raw(EVENTS).updateOne({ hash: a3!.hash }, { $set: { at: new Date(b1.at) } })
    await raw(EVENTS).updateOne({ hash: b1.hash }, { $set: { at: new Date(a3!.at) } })
    expect((await agree()).firstBreak?.reason).toMatch(/changed after it was written/)
    await raw(EVENTS).updateOne({ hash: a3!.hash }, { $set: { at: new Date(a3!.at) } })
    await raw(EVENTS).updateOne({ hash: b1.hash }, { $set: { at: new Date(b1.at) } })
    expect((await agree()).ok).toBe(true)
    // A well-formed entry, with its own chain and head, dated inside the first seal.
    const forged = forge('notes:made-up', 1, new Date(new Date(a2!.at).getTime()), null)
    await raw(EVENTS).insertOne(forged)
    await raw(HEADS).insertOne({ key: forged.chainKey, hash: forged.hash, seq: 1, at: forged.at })
    expect((await agree()).firstBreak?.reason).toMatch(/sealed range/)
    await raw(EVENTS).deleteOne({ hash: forged.hash })
    await raw(HEADS).deleteOne({ key: forged.chainKey })
    // An entry relinked to a made-up previous hash, its own hash recomputed, the head moved to match.
    const fake = '0'.repeat(64)
    const relinked = entryHash({ ...(a3 as never as Parameters<typeof entryHash>[0]), prevHash: fake, extra: { tenant: 't1' } })
    await raw(EVENTS).updateOne({ hash: a3!.hash }, { $set: { prevHash: fake, hash: relinked } })
    expect((await agree()).firstBreak?.reason).toMatch(/doesn't link to the entry before it/)
  })

  it('a broken seal: its digest edited, the newest deleted, one in the middle deleted, the seal head edited', async () => {
    await story()
    const [s1, s2, s3] = await seals()
    await raw(SEALS).updateOne({ seq: 2 }, { $set: { digest: '0'.repeat(64) } })
    expect((await agree()).firstBreak).toEqual({ id: String(s2!.id), reason: 'entries in a sealed range were added, removed, reordered or changed' })
    await raw(SEALS).updateOne({ seq: 2 }, { $set: { digest: s2!.digest } })
    await raw(SEALS).updateOne({ seq: 1 }, { $set: { count: 3 } })
    expect((await agree()).firstBreak?.id).toBe(String(s1!.id))
    await raw(SEALS).updateOne({ seq: 1 }, { $set: { count: 5 } })
    expect((await agree()).firstBreak?.id).toBe(String(s1!.id))
    await raw(SEALS).updateOne({ seq: 1 }, { $set: { count: 4 } })
    expect((await agree()).ok).toBe(true)
    await raw(HEADS).updateOne({ key: '__seal__' }, { $set: { hash: '0'.repeat(64) } })
    expect((await agree()).firstBreak).toEqual({ id: String(s3!.id), reason: 'the newest seal is missing or changed' })
    await raw(HEADS).updateOne({ key: '__seal__' }, { $set: { hash: s3!.digest } })
    await raw(SEALS).deleteOne({ seq: 3 })
    expect((await agree()).firstBreak?.reason).toBe('the newest seal is missing or changed')
    await raw(SEALS).insertOne({ ...s3, _id: undefined, id: undefined, upTo: new Date(s3!.upTo), fromAt: new Date(s3!.fromAt) })
    await raw(SEALS).deleteOne({ seq: 2 })
    expect((await agree()).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
  })

  it('a broken checkpoint, and what a prune leaves behind', async () => {
    const { a, chain } = await story()
    const future = new Date(Date.now() + DAY)
    expect((await pruneAuditTrail(p, { olderThanDays: 0, now: future })).deleted).toBe(8)
    expect(await agree()).toMatchObject({ ok: true, checked: 2 }) // a4 starts mid-way, after the cut
    await edit(a.id, { text: 'a5' })
    await raw(EVENTS).deleteOne({ hash: (await chain(a.id))[0]!.hash })
    expect((await agree()).firstBreak?.reason).toMatch(/the start of/)
    await raw(SEALS).updateOne({ kind: 'checkpoint' }, { $set: { upTo: future } })
    expect((await agree()).firstBreak?.reason).toMatch(/checkpoint was changed|the start of/)
    await raw(EVENTS).deleteMany({})
    await raw(HEADS).deleteMany({ key: { $ne: '__seal__' } })
    expect((await agree()).firstBreak?.reason).toBe('a checkpoint was changed')
  })

  it('entries from before chaining: unadopted, adopted, then changed, added or written afterwards', async () => {
    const old = Array.from({ length: 7 }, (_, i) => ({ at: new Date(Date.now() - 30 * DAY + i * 1000), action: 'update', subjectCollection: 'notes', subjectId: `old-${i}`, origin: 'web', changedFields: ['text'], tenant: 't1' }))
    await raw(EVENTS).insertMany(old)
    expect((await agree()).firstBreak?.reason).toMatch(/no adoption seal/)
    expect(await adoptExistingEntries(p)).toMatchObject({ adopted: 7 })
    await story()
    expect(await agree()).toMatchObject({ ok: true, checked: 10 })
    await raw(EVENTS).updateOne({ subjectId: 'old-3' }, { $set: { origin: 'import' } })
    expect((await agree()).firstBreak?.reason).toMatch(/adopted/)
    await raw(EVENTS).updateOne({ subjectId: 'old-3' }, { $set: { origin: 'web' } })
    await raw(EVENTS).deleteOne({ subjectId: 'old-6' })
    expect((await agree()).firstBreak?.reason).toMatch(/adopted/)
    await raw(EVENTS).insertMany([{ ...old[6], _id: undefined }, { ...old[0], _id: undefined, at: new Date(), subjectId: 'late' }])
    expect((await agree()).firstBreak?.reason).toMatch(/after the adoption seal/)
  })

  it('`since`, and the warning for entries waiting too long for a seal', async () => {
    const { a, chain } = await story()
    const later = new Date(Date.now() + 2 * DAY)
    expect((await agree({ now: later })).warnings).toEqual(['2 entries have waited more than 24 hours for a seal; run sealAuditTrail.'])
    const [a1, a2] = await chain(a.id)
    expect(await agree({ since: new Date(a2!.at) })).toMatchObject({ ok: true, checked: 9 })
    await raw(EVENTS).updateOne({ hash: a1!.hash }, { $set: { reason: 'made up' } })
    // `since` skips recomputing older hashes, as it always did: that change goes unseen until a full verify.
    expect(await agree({ since: new Date(a2!.at) })).toMatchObject({ ok: true, checked: 9 })
    expect((await agree()).firstBreak?.reason).toMatch(/changed after it was written/)
    await raw(EVENTS).deleteOne({ hash: a1!.hash })
    expect((await agree({ since: new Date() })).firstBreak?.reason).toMatch(/the start of/)
  })

  it('builds a seal’s digest one hash at a time to the same value', () => {
    for (const hashes of [[], ['a'], ['a', 'b', 'c']]) {
      const running = sealHasher('prev', '2026-01-01T00:00:00.000Z')
      for (const h of hashes) running.add(h)
      expect(running.digest()).toBe(sealDigest('prev', hashes, '2026-01-01T00:00:00.000Z'))
    }
    const first = sealHasher(null, 'x', 'adoption')
    first.add('h')
    expect(first.digest()).toBe(sealDigest(null, ['h'], 'x', 'adoption'))
  })
})

describe('a long trail, a page at a time', () => {
  const COUNT = 3130
  const PAGE = 50
  const start = Date.now() - 10 * DAY
  const build = async () => {
    // 3,130 entries over 700 records; 130 of them share one moment, more than two pages' worth.
    await longTrail(COUNT, 700, start, [1000, 1130])
    for (const upTo of [900, 2000, 2630]) expect(await sealAuditTrail(p, { upTo: new Date(start + upTo * 1000) })).toMatchObject({ kind: 'seal' })
  }
  /** Every read verify makes: what it asked for, and how much came back. */
  const watch = () => {
    const calls: { collection: string; limit: unknown; pagination: unknown; got: number }[] = []
    const real = p.find.bind(p)
    vi.spyOn(p, 'find').mockImplementation((async (a: Doc) => {
      const r = await real(a as never)
      calls.push({ collection: a.collection, limit: a.limit, pagination: a.pagination, got: r.docs.length })
      return r
    }) as never)
    return calls
  }

  it('never asks for more than a page, holds no more than one, and agrees with reading it all', async () => {
    await build()
    const want = await legacyVerify(p)
    expect(want).toMatchObject({ ok: true, checked: COUNT })
    const calls = watch()
    const got = await verifyAuditTrail(p, { pageSize: PAGE })
    vi.restoreAllMocks()
    expect(core(got)).toEqual(core(want))
    expect(got).toMatchObject({ finished: true, partial: false, summary: 'No break in all 3,130 entries.', range: { from: null, skipped: 0, read: COUNT } })
    // No query without a limit, none over a page (plus the row a page starts from), and nothing bigger came back.
    expect(calls.length).toBeGreaterThan((2 * COUNT) / PAGE)
    for (const c of calls) {
      expect(c.pagination).toBe(false)
      expect(Number.isInteger(c.limit) && (c.limit as number) >= 1 && (c.limit as number) <= PAGE + 1).toBe(true)
      expect(c.got).toBeLessThanOrEqual(c.limit as number)
    }
    expect(Math.max(...calls.map((c) => c.got))).toBeLessThanOrEqual(PAGE + 1)
    expect(new Set(calls.map((c) => c.collection))).toEqual(new Set([EVENTS, HEADS, SEALS]))
    // The default page is 1,000.
    const byDefault = watch()
    expect(core(await verifyAuditTrail(p))).toEqual(core(want))
    expect(Math.max(...byDefault.map((c) => c.limit as number))).toBe(1001)
    expect(byDefault.every((c) => (c.limit as number) >= 1)).toBe(true)
  })

  it('catches tampering in the first page, a middle page and the last page', async () => {
    await build()
    const all = await trail()
    for (const index of [3, PAGE - 1, PAGE, 1571, COUNT - 2]) {
      const e = all[index]!
      await raw(EVENTS).updateOne({ hash: e.hash }, { $set: { reason: 'made up' } })
      const got = await verifyAuditTrail(p, { pageSize: PAGE })
      expect(got.firstBreak, `entry ${index}`).toEqual({ id: String(e.id), reason: 'the entry was changed after it was written' })
      expect(core(got)).toEqual(core(await legacyVerify(p)))
      expect(got.summary).toMatch(/^Break at /)
      await raw(EVENTS).updateOne({ hash: e.hash }, { $unset: { reason: '' } })
    }
    // Deleted where one page ends and the next begins, and a copy of an entry put beside it there.
    for (const index of [PAGE - 1, PAGE, 2 * PAGE]) {
      const { id, ...e } = all[index]!
      await raw(EVENTS).deleteOne({ hash: e.hash })
      const got = await verifyAuditTrail(p, { pageSize: PAGE })
      expect(got.ok, `entry ${index}`).toBe(false)
      expect(core(got)).toEqual(core(await legacyVerify(p)))
      const back = { ...e, at: new Date(e.at), ...(e.prevAt ? { prevAt: new Date(e.prevAt) } : {}) }
      await raw(EVENTS).insertMany([back, { ...back }])
      const twice = await verifyAuditTrail(p, { pageSize: PAGE })
      expect(twice.firstBreak?.reason, `entry ${index}, twice`).toMatch(/an entry before it in notes:made-\d+ is missing/)
      expect((await legacyVerify(p)).firstBreak?.reason).toBe(twice.firstBreak?.reason)
      await raw(EVENTS).deleteOne({ hash: e.hash })
      void id
    }
    expect((await verifyAuditTrail(p, { pageSize: PAGE })).ok).toBe(true)
    // The last head, the last seal, and an entry inside the moment 130 entries share.
    const last = all.at(-1)!
    await raw(HEADS).updateOne({ key: last.chainKey }, { $set: { seq: 99 } })
    expect((await verifyAuditTrail(p, { pageSize: PAGE })).firstBreak).toEqual((await legacyVerify(p)).firstBreak)
    await raw(HEADS).updateOne({ key: last.chainKey }, { $set: { seq: last.seq } })
    const burst = all.filter((e) => new Date(e.at).getTime() === start + 1000 * 1000)
    expect(burst.length).toBe(130)
    await raw(EVENTS).deleteMany({ chainKey: burst[77]!.chainKey })
    await raw(HEADS).deleteOne({ key: burst[77]!.chainKey })
    const gone = await verifyAuditTrail(p, { pageSize: PAGE })
    expect(gone.firstBreak?.reason).toMatch(/sealed range/)
    expect(core(gone)).toEqual(core(await legacyVerify(p)))
  })

  it('starts from a seal and reads only what came after it', async () => {
    await build()
    const [, , s3] = await seals()
    const calls = watch()
    const got = await verifyAuditTrail(p, { pageSize: PAGE, from: s3!.digest })
    vi.restoreAllMocks()
    expect(got).toMatchObject({ ok: true, checked: 499, finished: true, partial: true, range: { from: { kind: 'seal', seq: 3, digest: s3!.digest }, skipped: 2631, read: 499 } })
    expect(got.summary).toBe(`No break in entries 2,632–3,130 in time order, written after seal 3 (up to ${new Date(s3!.upTo).toISOString()}). The 2,631 entries up to it were not checked.`)
    // Seal 3's own 631 entries are read once more to recompute it; the 2,000 before it never are.
    expect(calls.filter((c) => c.collection === EVENTS).reduce((sum, c) => sum + c.got, 0)).toBeLessThan(499 + 631 + 3 * PAGE)
    expect(got.warnings).toEqual((await legacyVerify(p)).warnings)
  })
})

describe('starting from a seal', () => {
  it('says what it checked, and misses nothing written after the seal', async () => {
    const { a, b, c, d, e, chain } = await story()
    const [s1, s2, s3] = await seals()
    const from = (seal: Doc, more: VerifyArgs = {}) => verifyAuditTrail(p, { from: seal.digest, pageSize: 2, ...more })
    expect(await from(s1!)).toMatchObject({ ok: true, checked: 6, finished: true, partial: true, range: { from: { kind: 'seal', seq: 1, digest: s1!.digest, upTo: new Date(s1!.upTo).toISOString() }, skipped: 4, read: 6 } })
    expect((await from(s1!)).summary).toBe(`No break in entries 5–10 in time order, written after seal 1 (up to ${new Date(s1!.upTo).toISOString()}). The 4 entries up to it were not checked.`)
    expect(await from(s3!)).toMatchObject({ ok: true, checked: 2, range: { skipped: 8, read: 2 } })
    const s4 = await sealNow()
    const none = await verifyAuditTrail(p, { from: s4.digest })
    expect(none).toMatchObject({ ok: true, checked: 0, partial: true, range: { skipped: 10, read: 0 } })
    expect(none.summary).toMatch(/^No break in the trail after seal 4 \(up to .*\), where no entries were written\. The 10 entries up to it were not checked\.$/)

    // Before the seal: not this check's business, and it says so. A full verify still catches it.
    const [a1, a2, a3, a4] = await chain(a.id)
    await raw(EVENTS).updateOne({ hash: a1!.hash }, { $set: { reason: 'made up' } })
    expect(await from(s2!)).toMatchObject({ ok: true, partial: true })
    expect((await verifyAuditTrail(p)).ok).toBe(false)
    await raw(EVENTS).updateOne({ hash: a1!.hash }, { $unset: { reason: '' } })

    // After the seal: an entry changed, the newest deleted, a sealed chain deleted with its head, a later seal broken.
    await raw(EVENTS).updateOne({ hash: a4!.hash }, { $set: { reason: 'made up' } })
    expect(await from(s3!)).toMatchObject({ ok: false, finished: true, partial: true, firstBreak: { id: String(a4!.id), reason: 'the entry was changed after it was written' } })
    await raw(EVENTS).updateOne({ hash: a4!.hash }, { $unset: { reason: '' } })
    await raw(EVENTS).deleteOne({ hash: a4!.hash })
    expect((await from(s3!)).firstBreak).toEqual({ id: `notes:${a.id}`, reason: 'every entry of this chain written after the seal is missing' })
    await raw(EVENTS).insertOne({ ...a4, _id: undefined, id: undefined, at: new Date(a4!.at), prevAt: new Date(a4!.prevAt) })
    expect((await from(s3!)).ok).toBe(true)
    const [d1] = await chain(d.id)
    await raw(EVENTS).deleteOne({ hash: d1!.hash })
    await raw(HEADS).deleteOne({ key: `notes:${d.id}` })
    expect((await from(s1!)).firstBreak?.reason).toMatch(/sealed range/)
    expect((await from(s2!)).firstBreak?.reason).toMatch(/sealed range/)
    await raw(EVENTS).insertOne({ ...d1, _id: undefined, id: undefined, at: new Date(d1!.at) })
    await raw(HEADS).insertOne({ key: `notes:${d.id}`, hash: d1!.hash, seq: 1, at: new Date(d1!.at) })
    expect((await from(s1!)).ok).toBe(true)
    // An entry whose predecessor, also after the seal, is gone; and one whose predecessor is before it (fine).
    const [c1] = await chain(c.id)
    await raw(EVENTS).deleteOne({ hash: c1!.hash })
    expect((await from(s1!)).firstBreak?.reason).toMatch(/the start of/)
    await raw(EVENTS).insertOne({ ...c1, _id: undefined, id: undefined, at: new Date(c1!.at) })
    void [a2, a3, b, e]

    // The seal itself: moved later to hide what follows, removed, or not one of this trail's.
    await raw(EVENTS).deleteOne({ hash: a4!.hash })
    await raw(HEADS).updateOne({ key: `notes:${a.id}` }, { $set: { hash: a3!.hash, seq: 3, at: new Date(a3!.at) } })
    await raw(SEALS).updateOne({ seq: 3 }, { $set: { upTo: new Date() } })
    expect((await from(s3!)).firstBreak).toEqual({ id: String(s3!.id), reason: 'entries in a sealed range were added, removed, reordered or changed' })
    await raw(SEALS).updateOne({ seq: 3 }, { $set: { upTo: new Date(s3!.upTo) } })
    const unknown = await verifyAuditTrail(p, { from: 'f'.repeat(64) })
    expect(unknown).toMatchObject({ ok: false, finished: false, partial: true, checked: 0, firstBreak: { id: 'f'.repeat(64), reason: expect.stringMatching(/was not found/) } })
    expect(unknown.summary).toMatch(/^Not finished: failed at /)
  })

  it('starts from a checkpoint too, and refuses an adoption seal', async () => {
    await raw(EVENTS).insertMany(Array.from({ length: 3 }, (_, i) => ({ at: new Date(Date.now() - 30 * DAY + i * 1000), action: 'update', subjectCollection: 'notes', subjectId: `old-${i}`, origin: 'web', changedFields: ['text'], tenant: 't1' })))
    await adoptExistingEntries(p)
    const adoption = (await seals())[0]!
    expect(await verifyAuditTrail(p, { from: adoption.digest })).toMatchObject({ ok: false, finished: false, firstBreak: { reason: expect.stringMatching(/not from an adoption seal/) } })
    const { a, s1, chain } = await story()
    // Cut at the first seal: the two seals after it were written before the checkpoint, and are still recomputed.
    await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(new Date(s1.upTo).getTime() + 1) })
    const checkpoint = (await seals()).at(-1)!
    expect(checkpoint.kind).toBe('checkpoint')
    expect(sealed.at(-1)).toMatchObject({ kind: 'checkpoint', digest: checkpoint.digest })
    const full = await verifyAuditTrail(p)
    const got = await verifyAuditTrail(p, { from: checkpoint.digest, pageSize: 2 })
    expect(full).toMatchObject({ ok: true, checked: 6, partial: false })
    expect(got).toMatchObject({ ok: true, checked: 6, partial: true, range: { from: { kind: 'checkpoint' }, skipped: 0, read: 6 } })
    const c1 = (await trail()).find((e) => e.seq === 1)!
    await raw(EVENTS).deleteMany({ chainKey: c1.chainKey })
    await raw(HEADS).deleteOne({ key: c1.chainKey })
    expect((await verifyAuditTrail(p, { from: checkpoint.digest })).firstBreak?.reason).toMatch(/sealed range/)
    void [a, chain]
  })

  it('won’t pass an unhashed entry dated after the seal it starts from, when the adoption seal is before it', async () => {
    // An old log whose clock ran an hour ahead: its entries are dated after the seals that follow the adoption.
    await raw(EVENTS).insertMany(Array.from({ length: 3 }, (_, i) => ({ at: new Date(Date.now() + 3_600_000 + i * 1000), action: 'update', subjectCollection: 'notes', subjectId: `old-${i}`, origin: 'web', changedFields: ['text'], tenant: 't1' })))
    await adoptExistingEntries(p)
    const { s1 } = await story()
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    expect(await verifyAuditTrail(p, { from: s1.digest })).toMatchObject({ ok: false, partial: true, firstBreak: { reason: expect.stringMatching(/run a full verify/) } })
  })
})

describe('stopping early, and progress', () => {
  it('reports not finished, never ok, when it stops after the number asked', async () => {
    await story()
    const stoppedAt4 = await verifyAuditTrail(p, { stopAfter: 4, pageSize: 3 })
    expect(stoppedAt4).toMatchObject({ ok: false, finished: false, partial: true, checked: 4, range: { from: null, read: 4 } })
    expect(stoppedAt4.firstBreak).toBeUndefined()
    expect(stoppedAt4.summary).toBe('Not finished: stopped after 4 entries, as asked. No break so far, but the rest of the entries, their heads and the seals were not checked.')
    for (const stopAfter of [1, 9]) expect(await verifyAuditTrail(p, { stopAfter })).toMatchObject({ ok: false, finished: false, range: { read: stopAfter } })
    // With nothing left to read it finishes, and only then can it be ok.
    for (const stopAfter of [10, 11, 5000]) expect(await verifyAuditTrail(p, { stopAfter, pageSize: 3 })).toMatchObject({ ok: true, finished: true, partial: false, checked: 10 })
    // A break among the entries it did read is still reported.
    const first = (await trail())[0]!
    await raw(EVENTS).updateOne({ hash: first.hash }, { $set: { reason: 'made up' } })
    expect(await verifyAuditTrail(p, { stopAfter: 4 })).toMatchObject({ ok: false, firstBreak: { id: String(first.id) } })
    await expect(verifyAuditTrail(p, { stopAfter: 0 })).rejects.toThrow(/stopAfter/)
    await expect(verifyAuditTrail(p, { pageSize: 0 })).rejects.toThrow(/pageSize/)
    await expect(verifyAuditTrail(p, { pageSize: 1.5 })).rejects.toThrow(/pageSize/)
  })

  it('calls back as it goes, and a callback that throws is never a pass', async () => {
    await story()
    const seen: VerifyProgress[] = []
    expect((await verifyAuditTrail(p, { pageSize: 3, onProgress: (x) => void seen.push({ ...x }) })).ok).toBe(true)
    expect(seen.filter((x) => x.phase === 'entries').map((x) => x.read)).toEqual([3, 6, 9, 10])
    expect(seen.filter((x) => x.phase === 'seals').map((x) => x.seals)).toEqual([1, 2, 3])
    expect(seen.at(-1)).toEqual({ phase: 'seals', read: 10, checked: 10, seals: 3 })
    await expect(verifyAuditTrail(p, { onProgress: () => Promise.reject(new Error('made up')) })).rejects.toThrow('made up')
  })
})

describe('failing closed when the trail can’t be read properly', () => {
  /** Lets verify's reads through until `when` says otherwise, then answers with `instead`. */
  const meddle = (when: (a: Doc, nth: number) => boolean, instead: (a: Doc, real: (a: Doc) => Promise<{ docs: Doc[] }>) => Promise<{ docs: Doc[] }>) => {
    const real = p.find.bind(p) as unknown as (a: Doc) => Promise<{ docs: Doc[] }>
    const seen: Record<string, number> = {}
    vi.spyOn(p, 'find').mockImplementation(((a: Doc) => {
      seen[a.collection] = (seen[a.collection] ?? 0) + 1
      return when(a, seen[a.collection]!) ? instead(a, real) : real(a)
    }) as never)
  }
  const secret = 'made-up detail that must not be repeated'

  it('a read that fails, in any part, is a failed verification with the place, not the error’s message', async () => {
    await story()
    for (const [collection, nth, place] of [
      [EVENTS, 1, /the start of audit-events/],
      [EVENTS, 3, /audit-events after notes:\w+ #\d/],
      [HEADS, 1, /the start of audit-events-heads/],
      [SEALS, 3, /the start of audit-events-seals/],
      [SEALS, 4, /audit-events-seals after 3/],
      [HEADS, 0, /the newest seal/],
    ] as [string, number, RegExp][]) {
      meddle(
        (a, n) => a.collection === collection && (nth ? n === nth : JSON.stringify(a.where).includes('"equals":"__seal__"')),
        () => Promise.reject(new TypeError(secret)),
      )
      const got = await verifyAuditTrail(p, { pageSize: 3 })
      vi.restoreAllMocks()
      expect(got, `${collection} read ${nth}`).toMatchObject({ ok: false, finished: false, partial: true })
      expect(got.firstBreak?.id, `${collection} read ${nth}`).toMatch(place)
      expect(got.firstBreak?.reason).toBe('the trail couldn\'t be read here (TypeError), so nothing past this point was checked')
      expect(JSON.stringify(got)).not.toContain(secret)
      expect(got.summary).toMatch(/^Not finished: failed at /)
    }
    // The count behind the warning, too.
    vi.spyOn(p, 'count').mockRejectedValue(new RangeError(secret))
    const got = await verifyAuditTrail(p)
    expect(got).toMatchObject({ ok: false, finished: false, firstBreak: { id: 'the entries waiting for a seal', reason: 'the trail couldn\'t be counted here (RangeError)' } })
    expect(JSON.stringify(got)).not.toContain(secret)
  })

  it('a read that returns more than a page, or pages out of order, is a failed verification', async () => {
    await story()
    const everything = { limit: 0, pagination: false }
    /** A read of the entries, in chain order, that carries on from an earlier page. */
    const later = (a: Doc) => a.collection === EVENTS && String(a.sort) === 'chainKey,seq' && JSON.stringify(a.where).includes('greater_than_equal')
    let nth = 0
    // The limit ignored.
    meddle(
      (a) => a.collection === EVENTS,
      (a, real) => real({ ...a, ...everything }),
    )
    expect(await verifyAuditTrail(p, { pageSize: 3 })).toMatchObject({ ok: false, finished: false, firstBreak: { id: 'the start of audit-events', reason: expect.stringMatching(/returned more than it was asked for/) } })
    vi.restoreAllMocks()
    // The first page again, whatever was asked.
    meddle(
      (a) => later(a),
      (a, real) => real({ ...a, where: {} }),
    )
    expect((await verifyAuditTrail(p, { pageSize: 3 })).ok).toBe(false)
    vi.restoreAllMocks()
    // A page that doesn't begin with the row the last one ended on.
    meddle(
      (a) => later(a),
      async (a, real) => ({ docs: (await real(a)).docs.slice(1) }),
    )
    expect(await verifyAuditTrail(p, { pageSize: 3 })).toMatchObject({ ok: false, finished: false, firstBreak: { id: expect.stringMatching(/audit-events after notes:/), reason: expect.stringMatching(/out of order/) } })
    vi.restoreAllMocks()
    // Heads out of order: the heads come back newest key first.
    meddle(
      (a) => a.collection === HEADS && JSON.stringify(a.where).includes('not_equals'),
      (a, real) => real({ ...a, sort: ['-key'] }),
    )
    expect(await verifyAuditTrail(p, { pageSize: 50 })).toMatchObject({ ok: false, finished: false, firstBreak: { reason: expect.stringMatching(/out of order/) } })
    vi.restoreAllMocks()
    // Entries of a seal's range out of time order across pages.
    meddle(
      (a) => a.collection === EVENTS && String(a.sort) === 'at',
      (a, real) => real({ ...a, sort: ['-at'] }),
    )
    expect(await verifyAuditTrail(p, { pageSize: 2 })).toMatchObject({ ok: false, firstBreak: { reason: expect.stringMatching(/out of order|sealed range/) } })
    vi.restoreAllMocks()
    // A seal's entries, a page at a time: the second page ignores where the first ended.
    let pages = 0
    meddle(
      (a) => a.collection === EVENTS && String(a.sort) === 'at' && JSON.stringify(a.where).includes('greater_than') && ++pages === 1,
      (a, real) => real({ ...a, where: {} }),
    )
    expect(await verifyAuditTrail(p, { pageSize: 2 })).toMatchObject({ ok: false, finished: false, firstBreak: { id: expect.stringMatching(/^audit-events after \d{4}-/), reason: expect.stringMatching(/out of order/) } })
    vi.restoreAllMocks()
    // A page skipped: the gap shows as a missing entry or a chain with no entries.
    meddle(
      (a) => later(a) && ++nth === 1,
      async (a, real) => {
        const page = (await real({ ...a, limit: 7 })).docs
        return { docs: [page[0]!, ...page.slice(4)] }
      },
    )
    nth = 0
    expect((await verifyAuditTrail(p, { pageSize: 3 })).ok).toBe(false)
    vi.restoreAllMocks()
    expect((await verifyAuditTrail(p, { pageSize: 3 })).ok).toBe(true)
  })
  it('two seals in one position stop the paging, whatever they say', async () => {
    await story()
    const s3 = (await seals())[2]!
    // A well-formed checkpoint slipped in beside seal 3, linked to it, with the seal head moved to it.
    const digest = sealDigest(s3.digest, [], new Date(s3.upTo).toISOString(), 'checkpoint')
    await raw(SEALS).insertOne({ kind: 'checkpoint', seq: 3, prevDigest: s3.digest, digest, upTo: new Date(s3.upTo), count: 0 })
    await raw(HEADS).updateOne({ key: '__seal__' }, { $set: { hash: digest } })
    for (const pageSize of [1, 2, 1000]) expect(await verifyAuditTrail(p, { pageSize }), `page size ${pageSize}`).toMatchObject({ ok: false, finished: false, firstBreak: { id: 'audit-events-seals at 3', reason: expect.stringMatching(/two rows share this position/) } })
  })

  it('chains that come round again, each whole and well-formed, are a failed verification', async () => {
    // Six records with one entry each. The second page starts where it should, then goes back to the beginning.
    await longTrail(6, 6, Date.now() - DAY, [0, 0])
    expect((await verifyAuditTrail(p, { pageSize: 3 })).ok).toBe(true)
    let nth = 0
    meddle(
      (a) => a.collection === EVENTS && String(a.sort) === 'chainKey,seq' && JSON.stringify(a.where).includes('greater_than_equal') && ++nth === 1,
      async (a, real) => {
        const [from] = (await real({ ...a, limit: 1 })).docs
        return { docs: [from!, ...(await real({ ...a, where: {}, limit: 3 })).docs] }
      },
    )
    const again = await verifyAuditTrail(p, { pageSize: 3 })
    expect(again).toMatchObject({ ok: false, finished: false, firstBreak: { id: expect.stringMatching(/^notes:made-\d$/), reason: expect.stringMatching(/out of order/) } })
  })
})

describe('pruning more than once', () => {
  /** Two seals, a prune at the first, two more seals, a prune at the third: one seal survives between two checkpoints. */
  async function prunedTwice() {
    const first = await make('first')
    const s1 = await sealNow()
    await make('second')
    await sealNow()
    await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(new Date(s1.upTo).getTime() + 1) })
    expect((await verifyAuditTrail(p)).firstBreak).toBeUndefined()
    await make('third')
    const s4 = await sealNow()
    const kept = await make('kept')
    await edit(first.id, { text: 'first, again' })
    const s5 = await sealNow()
    await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(new Date(s4.upTo).getTime() + 1) })
    return { kept, s5 }
  }

  it('verify stays ok after a second prune, and a third, at any page size and from the checkpoint', async () => {
    const { s5 } = await prunedTwice()
    expect((await seals()).map((s) => `${s.seq} ${s.kind}`)).toEqual(['3 checkpoint', '5 seal', '6 checkpoint'])
    for (const pageSize of [1, 2, 1000]) expect(await verifyAuditTrail(p, { pageSize }), `page size ${pageSize}`).toMatchObject({ ok: true, checked: 2 })
    expect(core(await verifyAuditTrail(p))).toEqual(core(await legacyVerify(p)))
    expect(await verifyAuditTrail(p, { from: sealed.at(-1)!.digest })).toMatchObject({ ok: true, checked: 2, partial: true })
    // A third prune, at the newest seal, leaves three checkpoints and nothing else.
    await make('fourth')
    await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(new Date(s5.upTo).getTime() + 1) })
    expect((await seals()).map((s) => s.kind)).toEqual(['checkpoint', 'checkpoint', 'checkpoint'])
    expect(await verifyAuditTrail(p)).toMatchObject({ ok: true, checked: 1 })
    await sealNow()
    expect(await agree()).toMatchObject({ ok: true, checked: 1 })
  })

  it('a real break after two prunes is still caught: pruning excuses only what it recorded', async () => {
    const { kept } = await prunedTwice()
    const [c1, s5, c2] = await seals()
    const restore = async (s: Doc) => raw(SEALS).insertOne({ ...s, _id: undefined, id: undefined, upTo: new Date(s.upTo), ...(s.fromAt ? { fromAt: new Date(s.fromAt) } : {}) })
    // An entry changed, and a sealed record removed with its head.
    const entry = (await trail()).find((e) => e.chainKey === `notes:${kept.id}`)!
    await raw(EVENTS).updateOne({ hash: entry.hash }, { $set: { reason: 'made up' } })
    expect((await agree()).firstBreak?.reason).toMatch(/changed after it was written/)
    await raw(EVENTS).updateOne({ hash: entry.hash }, { $unset: { reason: '' } })
    await raw(EVENTS).deleteOne({ hash: entry.hash })
    await raw(HEADS).deleteOne({ key: entry.chainKey })
    expect((await agree()).firstBreak?.reason).toMatch(/sealed range/)
    // The surviving seal removed along with it, as if a prune had taken both: no checkpoint recorded that.
    await raw(SEALS).deleteOne({ seq: 5 })
    expect((await agree()).firstBreak).toEqual({ id: String(c2!.id), reason: 'a seal doesn’t link to the seal before it' })
    await restore(s5!)
    await raw(EVENTS).insertOne({ ...entry, _id: undefined, id: undefined, at: new Date(entry.at) })
    await raw(HEADS).insertOne({ key: entry.chainKey, hash: entry.hash, seq: 1, at: new Date(entry.at) })
    expect((await agree()).ok).toBe(true)
    // What a checkpoint recorded as cut away can't be widened, dropped, or borrowed from an earlier checkpoint.
    expect(c2!.pins).toHaveLength(2)
    await raw(SEALS).updateOne({ seq: 6 }, { $set: { pins: [...c2!.pins, s5!.digest] } })
    expect((await agree()).firstBreak?.reason).toBe('a checkpoint was changed')
    await raw(SEALS).updateOne({ seq: 6 }, { $set: { pins: [] } })
    expect((await agree()).firstBreak?.reason).toMatch(/doesn’t link|checkpoint was changed/)
    await raw(SEALS).updateOne({ seq: 6 }, { $set: { pins: c2!.pins } })
    await raw(SEALS).updateOne({ seq: 3 }, { $set: { pins: c2!.pins, seq: 7 } })
    expect((await agree()).ok).toBe(false)
    await raw(SEALS).updateOne({ seq: 7 }, { $set: { pins: c1!.pins, seq: 3 } })
    expect((await agree()).ok).toBe(true)
    // A seal that claims to be the first, in the middle of the chain.
    await raw(SEALS).updateOne({ seq: 5 }, { $unset: { prevDigest: '' } })
    expect((await agree()).ok).toBe(false)
  })

  it('a made-up checkpoint can’t excuse a missing seal, in a full check or one from a seal', async () => {
    await story()
    const [s1, s2] = await seals()
    await raw(SEALS).deleteOne({ seq: 2 })
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
    // A pin written onto an ordinary seal, whose digest doesn't cover it, counts for nothing.
    await raw(SEALS).updateOne({ seq: 3 }, { $set: { pins: [s2!.digest] } })
    expect((await agree()).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
    // Well-formed, pinning the seal that's gone, and numbered before everything so a check from seal 1 never reads it.
    const upTo = new Date(Date.now() - DAY)
    await raw(SEALS).insertOne({ kind: 'checkpoint', seq: 0, digest: sealDigest(null, [s2!.digest], upTo.toISOString(), 'checkpoint'), upTo, count: 0, pins: [s2!.digest] })
    expect((await agree()).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
    expect((await verifyAuditTrail(p, { from: s1!.digest })).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
  })

  it('the paging index is part of the collection’s config, and verify still works without it', async () => {
    const config = p.collections[EVENTS as never] as unknown as { config: { indexes?: { fields: string[] }[] } }
    expect(config.config.indexes).toEqual([{ fields: ['chainKey', 'seq'] }])
    const name = ((await raw(EVENTS).indexes()) as { name: string; key: Doc }[]).find((i) => JSON.stringify(i.key) === '{"chainKey":1,"seq":1}')?.name
    expect(name).toBeTruthy()
    await story()
    await raw(EVENTS).dropIndex(name)
    try {
      expect(await agree()).toMatchObject({ ok: true, checked: 10 })
    } finally {
      await raw(EVENTS).createIndex({ chainKey: 1, seq: 1 }, { name })
    }
  })

  it('the first seal of a trail that was never pruned can’t be removed quietly', async () => {
    const a = await make('a')
    await sealNow()
    await make('b')
    await sealNow()
    await raw(SEALS).deleteOne({ seq: 1 })
    await raw(EVENTS).deleteMany({ chainKey: `notes:${a.id}` })
    await raw(HEADS).deleteOne({ key: `notes:${a.id}` })
    expect((await agree()).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
  })
})

describe('after the security read of 8a3bebb', () => {
  it('a seal head with no seals is a break; with the head gone too, only a check from a kept digest notices', async () => {
    const { d, s1 } = await story()
    await raw(SEALS).deleteMany({})
    expect((await agree()).firstBreak).toEqual({ id: '__seal__', reason: 'every seal is missing, while the seal head is still here' })
    await raw(EVENTS).deleteMany({ chainKey: `notes:${d.id}` })
    await raw(HEADS).deleteOne({ key: `notes:${d.id}` })
    expect((await agree()).firstBreak?.reason).toBe('every seal is missing, while the seal head is still here')
    // The stated limit: nothing in the database says there were ever seals.
    await raw(HEADS).deleteOne({ key: '__seal__' })
    expect((await agree()).ok).toBe(true)
    expect(await verifyAuditTrail(p, { from: s1.digest })).toMatchObject({ ok: false, finished: false, firstBreak: { reason: expect.stringMatching(/was not found/) } })
  })

  it('a check from the second checkpoint agrees with a full one when a surviving seal links to the first', async () => {
    await make('first')
    const s1 = await sealNow()
    await make('second')
    const s2 = await sealNow()
    await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(new Date(s1.upTo).getTime() + 1) })
    const kept = await make('third')
    await sealNow()
    await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(new Date(s2.upTo).getTime() + 1) })
    expect((await seals()).map((s) => `${s.seq} ${s.kind}`)).toEqual(['3 checkpoint', '4 seal', '5 checkpoint'])
    const c2 = sealed.at(-1)!
    expect(c2.kind).toBe('checkpoint')
    expect(await verifyAuditTrail(p)).toMatchObject({ ok: true, checked: 1 })
    for (const pageSize of [1, 1000]) expect(await verifyAuditTrail(p, { from: c2.digest, pageSize })).toMatchObject({ ok: true, checked: 1, partial: true, range: { from: { kind: 'checkpoint', seq: 5 } } })
    // Still closed: the surviving seal removed with its record, or the first checkpoint swapped for another.
    const s4 = (await seals())[1]!
    await raw(SEALS).deleteOne({ seq: 4 })
    await raw(EVENTS).deleteMany({ chainKey: `notes:${kept.id}` })
    await raw(HEADS).deleteOne({ key: `notes:${kept.id}` })
    expect((await verifyAuditTrail(p, { from: c2.digest })).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
    await raw(SEALS).insertOne({ ...s4, _id: undefined, id: undefined, upTo: new Date(s4.upTo), fromAt: new Date(s4.fromAt) })
    await raw(SEALS).deleteOne({ seq: 3 })
    expect((await verifyAuditTrail(p, { from: c2.digest })).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
    expect((await verifyAuditTrail(p)).firstBreak?.reason).toBe('a seal doesn’t link to the seal before it')
  })

  it('names every cut it read, so one nobody made stands out', async () => {
    expect((await verifyAuditTrail(p)).cuts).toEqual([])
    const before = sealed.length
    const { a, b, c, s1, s2, chain } = await story()
    await pruneAuditTrail(p, { olderThanDays: 0, now: new Date(new Date(s1.upTo).getTime() + 1) })
    const mine = sealed.slice(before).filter((s) => s.kind === 'checkpoint')
    const [first] = (await seals()).filter((s) => s.kind === 'checkpoint')
    const honest = await verifyAuditTrail(p)
    expect(honest).toMatchObject({ ok: true, cuts: [{ seq: 4, digest: mine[0]!.digest, upTo: new Date(s1.upTo).toISOString(), pins: [s1.digest], written: first!.createdAt }] })
    expect(honest.cuts).toHaveLength(1)
    expect(honest.summary).toMatch(/It read 1 cut \(a checkpoint from a prune\): seq 4, up to .*Z\. A cut you didn’t make means tampering\.$/)
    // Someone removes seal 2 and what it sealed, then appends a well-formed checkpoint and moves the seal head.
    await raw(SEALS).deleteOne({ digest: s2.digest })
    for (const id of [b.id, c.id]) {
      const gone = (await chain(id)).filter((e) => e.at > new Date(s1.upTo).toISOString() && e.at <= new Date(s2.upTo).toISOString())
      expect(gone.length).toBeGreaterThan(0)
    }
    await raw(EVENTS).deleteMany({ chainKey: `notes:${c.id}`, seq: 1 })
    const tip = (await seals()).at(-1)!
    const upTo = new Date(s2.upTo)
    const forged = sealDigest(tip.digest, [s2.digest], upTo.toISOString(), 'checkpoint')
    await raw(SEALS).insertOne({ kind: 'checkpoint', seq: tip.seq + 1, prevDigest: tip.digest, digest: forged, upTo, count: 0, pins: [s2.digest] })
    await raw(HEADS).updateOne({ key: '__seal__' }, { $set: { hash: forged } })
    const after = await verifyAuditTrail(p)
    // Whether or not the entries' own chains give it away, the cut is on the list, and it isn't one of the site's.
    expect(after.cuts.map((x) => x.digest)).toEqual([mine[0]!.digest, forged])
    expect(after.cuts.filter((x) => !mine.some((m) => m.digest === x.digest))).toMatchObject([{ seq: tip.seq + 1, pins: [s2.digest], upTo: upTo.toISOString() }])
    expect((await verifyAuditTrail(p, { from: mine[0]!.digest })).cuts.map((x) => x.digest)).toEqual([mine[0]!.digest, forged])
    void a
  })

  it('prune refuses to cut a trail that doesn’t verify, unless told not to check', async () => {
    const { a, s1, chain } = await story()
    const first = (await chain(a.id))[0]!
    await raw(EVENTS).updateOne({ hash: first.hash }, { $set: { reason: 'made up' } })
    const cut = { olderThanDays: 0, valuesOlderThanDays: 0, now: new Date(new Date(s1.upTo).getTime() + 1) }
    await expect(pruneAuditTrail(p, cut)).rejects.toThrow(/verify found a break.*changed after it was written.*Nothing was pruned/)
    expect(await trail()).toHaveLength(10)
    expect((await trail()).some((e) => e.values)).toBe(true)
    expect((await seals()).map((s) => s.kind)).toEqual(['seal', 'seal', 'seal'])
    // A read that fails is no pass either.
    vi.spyOn(p, 'count').mockRejectedValueOnce(new Error('made up'))
    await raw(EVENTS).updateOne({ hash: first.hash }, { $unset: { reason: '' } })
    await expect(pruneAuditTrail(p, cut)).rejects.toThrow(/Nothing was pruned/)
    vi.restoreAllMocks()
    await raw(EVENTS).updateOne({ hash: first.hash }, { $set: { reason: 'made up' } })
    expect(await pruneAuditTrail(p, { ...cut, verify: false })).toMatchObject({ deleted: 4 })
    expect((await verifyAuditTrail(p)).ok).toBe(true)
    // Clearing values alone cuts nothing, so it doesn't check.
    const kept = (await trail())[0]!
    await raw(EVENTS).updateOne({ hash: kept.hash }, { $set: { reason: 'made up' } })
    await expect(pruneAuditTrail(p, { valuesOlderThanDays: 0 })).resolves.toMatchObject({ deleted: 0 })
  })
})
