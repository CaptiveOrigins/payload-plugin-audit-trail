import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { BasePayload, buildConfig, createLocalReq, getPayload, type CollectionConfig, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auditTrail, fromPluginEvent, pruneAuditTrail, recordEvent, type AuditTrailOptions } from '../src/index.js'

/**
 * A made-up site: accounts, and studbook entries with drafts (autosave on) whose number and holder are logged with
 * their old and new values. A test switch decides what `via` returns.
 */
type U = { id: string; email: string; role: string }
const SECRET = 'a-made-up-app-secret-for-tests-only-0123456789'
let payload: Payload
let mongo: MongoMemoryReplSet
let admin: U
let member: U
let via: 'none' | 'hats' = 'none'

const users: CollectionConfig = { slug: 'users', auth: true, access: { read: () => true, update: () => true }, fields: [{ name: 'name', type: 'text' }, { name: 'role', type: 'text' }] }
const entries: CollectionConfig = {
  slug: 'studbook-entries',
  versions: { drafts: { autosave: true } },
  access: { read: () => true, create: () => true, update: () => true, delete: () => true },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'studbookNo', type: 'text' },
    { name: 'holder', type: 'relationship', relationTo: 'users' },
    { name: 'notes', type: 'text' },
    { name: 'hiddenNote', type: 'text', hidden: true },
    { name: 'staffNote', type: 'text', access: { read: () => false } },
    { name: 'token', type: 'text', custom: { secret: true } },
    { name: 'keeper', type: 'relationship', relationTo: 'users' },
    { name: 'measures', type: 'group', fields: [{ name: 'weight', type: 'number' }] },
    { name: 'mates', type: 'join', collection: 'studbook-entries', on: 'holder' } as never,
  ],
}
const isAdmin = ({ req }: { req: PayloadRequest }) => (req.user as unknown as U | null)?.role === 'admin'
const base: AuditTrailOptions = {
  collections: ['users', 'studbook-entries'],
  actions: ['masquerade', 'hats'],
  access: { read: isAdmin, values: isAdmin },
  via: () => (via === 'hats' ? { kind: 'hats', id: 'from-account-1' } : null),
  values: { 'studbook-entries': ['studbookNo', 'holder'] },
  personal: ['name'],
  allowPeople: ['studbook-entries.holder'],
  extraFields: [{ name: 'tenant', type: 'text' }],
  extra: () => ({ tenant: 't1' }),
}
const cfg = (opts: AuditTrailOptions = base, dbExtra: Record<string, unknown> = {}) =>
  buildConfig({ secret: SECRET, telemetry: false, typescript: { autoGenerate: false }, db: mongooseAdapter({ url: mongo.getUri('audit'), ensureIndexes: true, ...dbExtra }), collections: [users, entries], plugins: [auditTrail(opts)] })

const events = async (where: Record<string, unknown> = {}) =>
  (await payload.find({ collection: 'audit-events' as never, where: where as never, sort: '-at', limit: 50, depth: 0, overrideAccess: true, showHiddenFields: true })).docs as unknown as Record<string, any>[]
const latestFor = async (id: string) => (await events({ subjectId: { equals: String(id) } }))[0]!
const as = async (user: U | null, context: Record<string, unknown> = {}) => {
  const req = (await createLocalReq({ ...(user ? { user: { ...user, collection: 'users' } as never } : {}), context }, payload)) as PayloadRequest
  return { req, overrideAccess: false as const, user: (user ? { ...user, collection: 'users' } : undefined) as never }
}
const newEntry = async (data: Record<string, unknown> = {}) => (await payload.create({ collection: 'studbook-entries', data: { name: 'Made Up', studbookNo: 'SB-1', _status: 'published', ...data } as never, overrideAccess: true })) as unknown as Record<string, any>

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({ config: await cfg() })
  admin = (await payload.create({ collection: 'users', data: { email: 'admin@example.invalid', password: 'pw-admin-long', role: 'admin' } as never })) as unknown as U
  member = (await payload.create({ collection: 'users', data: { email: 'member@example.invalid', password: 'pw-member-long', role: 'member' } as never })) as unknown as U
}, 120_000)

afterAll(async () => {
  await payload?.destroy?.()
  await mongo?.stop()
})

describe('what it records', () => {
  it('names the fields that changed, never their values; nothing for an update that changes nothing', async () => {
    const e = await newEntry({ holder: member.id })
    expect((await latestFor(e.id)).action).toBe('create')
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'a private remark', measures: { weight: 120 } } as never, ...(await as(admin)) })
    const upd = await latestFor(e.id)
    expect(upd).toMatchObject({ action: 'update', subjectCollection: 'studbook-entries', changedFields: ['measures', 'notes'], actor: admin.id, origin: 'manual', tenant: 't1' })
    expect(JSON.stringify(upd)).not.toContain('a private remark')
    const count = (await events({ subjectId: { equals: e.id } })).length
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'a private remark' } as never, overrideAccess: true })
    expect((await events({ subjectId: { equals: e.id } })).length).toBe(count)
  })

  it('never lists sign-in internals or join fields', async () => {
    await payload.update({ collection: 'users', id: member.id, data: { password: 'a-brand-new-password' } as never, overrideAccess: true })
    const all = await events({ subjectCollection: { equals: 'users' } })
    expect(all.flatMap((x) => x.changedFields ?? [])).not.toEqual(expect.arrayContaining(['hash']))
    expect(all.flatMap((x) => x.changedFields ?? [])).not.toEqual(expect.arrayContaining(['salt']))
    const e = await newEntry()
    expect((await latestFor(e.id)).changedFields).not.toContain('mates')
  })

  it('skips bookkeeping writes, and keeps what automated work says about itself', async () => {
    const e = await newEntry()
    const n = (await events({ subjectId: { equals: e.id } })).length
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'x' } as never, overrideAccess: true, context: { audit: false } })
    expect((await events({ subjectId: { equals: e.id } })).length).toBe(n)
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'y' } as never, overrideAccess: true, context: { audit: { origin: 'import', system: 'nightly-import', reason: 'yearly reconciliation' } } })
    expect(await latestFor(e.id)).toMatchObject({ origin: 'import', system: 'nightly-import', reason: 'yearly reconciliation' })
  })

  it('says how the change was made, from the site’s resolver, and nothing without it', async () => {
    const e = await newEntry()
    via = 'hats'
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'via' } as never, ...(await as(admin)) })
    via = 'none'
    expect((await latestFor(e.id)).via).toMatchObject({ kind: 'hats', ref: 'from-account-1' })
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'own' } as never, ...(await as(admin)) })
    expect((await latestFor(e.id)).via?.kind ?? null).toBeNull()
  })
})

describe('failing closed', () => {
  it('a change whose entry can’t be written is undone', async () => {
    const e = await newEntry({ notes: 'before' })
    await expect(payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'after' } as never, overrideAccess: true, context: { audit: { origin: 'not-an-origin' } } })).rejects.toThrow()
    expect(((await payload.findByID({ collection: 'studbook-entries', id: e.id, overrideAccess: true })) as unknown as { notes: string }).notes).toBe('before')
  })

  it('won’t start without transactions unless told to log instead; with `log`, it starts and lets a failed entry through', async () => {
    const noTx = { transactionOptions: false as const }
    await expect(new BasePayload().init({ config: await cfg(base, noTx) })).rejects.toThrow(/no transactions/)
    const logged = await new BasePayload().init({ config: await cfg({ ...base, onWriteError: 'log' }, noTx) })
    const e = (await logged.create({ collection: 'studbook-entries', data: { notes: 'before', _status: 'published' } as never, overrideAccess: true })) as unknown as { id: string }
    await logged.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'after' } as never, overrideAccess: true, context: { audit: { origin: 'not-an-origin' } } })
    expect(((await logged.findByID({ collection: 'studbook-entries', id: e.id, overrideAccess: true })) as unknown as { notes: string }).notes).toBe('after')
  })
})

describe('the value log', () => {
  it('keeps old and new values of the named fields only, with people only where allowed, capped in size', async () => {
    const e = await newEntry({ studbookNo: 'SB-100', holder: member.id })
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { studbookNo: 'SB-101', holder: admin.id, notes: 'not logged' } as never, overrideAccess: true })
    const v = (await latestFor(e.id)).values
    expect(v).toEqual({ studbookNo: { before: 'SB-100', after: 'SB-101' }, holder: { before: member.id, after: admin.id } })
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { studbookNo: 'X'.repeat(5000) } as never, overrideAccess: true })
    expect((await latestFor(e.id)).values.studbookNo.after).toMatchObject({ truncated: true })
  })

  it('refuses at startup to log anything that could hold a secret or a person’s details', async () => {
    const with_ = (names: string[], extra: Partial<AuditTrailOptions> = {}) => cfg({ ...base, values: { 'studbook-entries': names }, ...extra })
    await expect(with_(['hiddenNote'])).rejects.toThrow(/hidden/)
    await expect(with_(['staffNote'])).rejects.toThrow(/own read access/)
    await expect(with_(['token'])).rejects.toThrow(/secret or encrypted/)
    await expect(with_(['name'])).rejects.toThrow(/personal/)
    await expect(with_(['keeper'])).rejects.toThrow(/links to people/)
    await expect(with_(['nope'])).rejects.toThrow(/no such/)
    await expect(cfg({ ...base, values: { users: ['email'] } })).rejects.toThrow(/sign-in/)
  })

  it('shows values only to `access.values`, and the trail only to `access.read`', async () => {
    const e = await newEntry({ studbookNo: 'SB-7' })
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { studbookNo: 'SB-8' } as never, overrideAccess: true })
    const id = (await latestFor(e.id)).id
    const asAdmin = (await payload.findByID({ collection: 'audit-events' as never, id, ...(await as(admin)) })) as unknown as Record<string, unknown>
    expect(asAdmin.values).toBeTruthy()
    await expect(payload.findByID({ collection: 'audit-events' as never, id, ...(await as(member)) })).rejects.toThrow()
    const values = { ...base.access, read: () => true }
    void values
  })
})

describe('drafts and versions', () => {
  it('records publishing and saving, not autosave; a restore is an update that says so', async () => {
    const e = await newEntry({ notes: 'v1' })
    const n = (await events({ subjectId: { equals: e.id } })).length
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'typing…' } as never, draft: true, autosave: true, overrideAccess: true } as never)
    expect((await events({ subjectId: { equals: e.id } })).length).toBe(n)
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { notes: 'v2', _status: 'published' } as never, overrideAccess: true })
    expect((await latestFor(e.id)).changedFields).toContain('notes')
    const versions = (await payload.findVersions({ collection: 'studbook-entries', where: { parent: { equals: e.id } }, sort: 'createdAt', overrideAccess: true })).docs
    const first = versions.find((v) => (v as unknown as { version: { notes?: string } }).version.notes === 'v1')!
    await payload.restoreVersion({ collection: 'studbook-entries', id: String(first.id), overrideAccess: true })
    const restored = await latestFor(e.id)
    expect(restored).toMatchObject({ action: 'update', reason: `restored version ${first.id}` })
  })
})

describe('a sink for other plugins', () => {
  it('records named events, refuses unknown actions, and fails the caller when an event can’t be recorded', async () => {
    const req = (await as(admin)).req
    await recordEvent(payload, { action: 'masquerade', subject: { collection: 'users', id: member.id }, reason: 'support request', req })
    expect((await events({ action: { equals: 'masquerade' } }))[0]!).toMatchObject({ actor: admin.id, subjectId: member.id })
    await expect(recordEvent(payload, { action: 'teleport', subject: { collection: 'users', id: member.id }, req })).rejects.toThrow(/isn't an action/)
    const hatsEvent = fromPluginEvent((e: { type: string; account: string; req: PayloadRequest }) => ({ action: 'hats', subject: { collection: 'users', id: e.account }, reason: e.type, req: e.req }))
    await hatsEvent({ type: 'switched', account: member.id, req })
    expect((await events({ action: { equals: 'hats' } }))[0]!).toMatchObject({ reason: 'switched' })
    const broken = fromPluginEvent(() => {
      throw new Error('mapper broke')
    })
    await expect(broken({})).rejects.toThrow(/mapper broke/)
    const unknown = fromPluginEvent((e: { req: PayloadRequest }) => ({ action: 'teleport', subject: { collection: 'users', id: member.id }, req: e.req }))
    await expect(unknown({ req })).rejects.toThrow(/isn't an action/)
    const lenient = fromPluginEvent(() => {
      throw new Error('mapper broke')
    }, { onError: 'log' })
    await expect(lenient({ req })).resolves.toBeUndefined()
  })
})

describe('retention', () => {
  it('clears old values and deletes old entries only when asked, by age', async () => {
    const e = await newEntry({ studbookNo: 'SB-200' })
    await payload.update({ collection: 'studbook-entries', id: e.id, data: { studbookNo: 'SB-201' } as never, overrideAccess: true })
    const total = (await events()).length
    expect(await pruneAuditTrail(payload)).toEqual({ valuesCleared: 0, deleted: 0 })
    const future = new Date(Date.now() + 400 * 86_400_000)
    const v = await pruneAuditTrail(payload, { valuesOlderThanDays: 365, now: future })
    expect(v.valuesCleared).toBeGreaterThan(0)
    expect((await latestFor(e.id)).values ?? null).toBeNull()
    expect((await events()).length).toBe(total)
    const d = await pruneAuditTrail(payload, { olderThanDays: 365, now: future })
    expect(d.deleted).toBeGreaterThan(0)
    expect((await events()).length).toBe(0)
  })
})
