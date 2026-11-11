import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { auditTrail, recordEvent, verifyAuditTrail } from '../src/index.js'

// `onWriteError: 'log'`, with and without transactions: a failed entry must never lose the change or break the chain.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let mongo: MongoMemoryReplSet
const make = async (name: string, transactions: boolean) =>
  getPayload({
    key: name,
    config: await buildConfig({
      secret: 'a-made-up-app-secret-for-tests-only-0123456789',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri(name), ensureIndexes: true, ...(transactions ? {} : { transactionOptions: false }) }),
      collections: [{ slug: 'users', auth: true, fields: [] }, { slug: 'notes', access: { read: () => true }, fields: [{ name: 'text', type: 'text' }] }],
      plugins: [
        auditTrail({
          collections: ['notes'],
          onWriteError: 'log',
          actions: ['exported'],
          // A required site field the resolver leaves empty: Payload's own validation would refuse the entry.
          extraFields: [{ name: 'tenant', type: 'text', required: true }],
          extra: ({ req }) => ((req.context as { tenant?: string } | undefined)?.tenant ? { tenant: (req.context as { tenant: string }).tenant } : {}),
        }),
      ],
    }),
  } as never)

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
}, 120_000)
afterAll(async () => {
  await mongo?.stop()
})

const entries = async (p: Payload) => (await p.find({ collection: 'audit-events' as never, pagination: false, depth: 0, overrideAccess: true, showHiddenFields: true })).docs as Doc[]

describe("onWriteError: 'log'", () => {
  it('with transactions, keeps the change when the entry would fail validation', async () => {
    const p = await make('logtx', true)
    const note = (await p.create({ collection: 'notes' as never, data: { text: 'first' } as never, overrideAccess: true })) as Doc
    await p.update({ collection: 'notes' as never, id: note.id, data: { text: 'second' } as never, overrideAccess: true })
    expect(((await p.findByID({ collection: 'notes' as never, id: note.id, overrideAccess: true })) as Doc).text).toBe('second')
    expect((await entries(p)).length).toBe(2)
    expect(await verifyAuditTrail(p)).toMatchObject({ ok: true })
    await p.destroy()
  })

  it('without transactions, puts the head back when an entry fails, so verify never reports a false break', async () => {
    const p = await make('lognotx', false)
    const note = (await p.create({ collection: 'notes' as never, data: { text: 'first' } as never, overrideAccess: true })) as Doc
    const orig = p.db.create.bind(p.db)
    const spy = vi.spyOn(p.db, 'create').mockImplementation(((args: { collection: string }) => (args.collection === 'audit-events' ? Promise.reject(new Error('made-up outage')) : orig(args as never))) as never)
    await p.update({ collection: 'notes' as never, id: note.id, data: { text: 'second' } as never, overrideAccess: true })
    spy.mockRestore()
    expect(((await p.findByID({ collection: 'notes' as never, id: note.id, overrideAccess: true })) as Doc).text).toBe('second')
    expect((await entries(p)).length).toBe(1)
    const r1 = await verifyAuditTrail(p)
    expect(r1.firstBreak?.reason ?? null).toBeNull()
    // The chain carries on from the restored head.
    await p.update({ collection: 'notes' as never, id: note.id, data: { text: 'third' } as never, overrideAccess: true })
    expect(await verifyAuditTrail(p)).toMatchObject({ ok: true })
    await p.destroy()
  })

  it('fills the site’s own fields on events from other plugins, from its resolver', async () => {
    const p = await make('logextra', true)
    await recordEvent(p, { action: 'exported', subject: { collection: 'notes', id: 'n1' }, req: { payload: p, context: { tenant: 't1' } } as never })
    expect((await entries(p))[0]!.tenant).toBe('t1')
    await recordEvent(p, { action: 'exported', subject: { collection: 'notes', id: 'n2' }, extra: { tenant: 't2' }, req: { payload: p, context: { tenant: 't1' } } as never })
    expect((await entries(p)).find((e) => e.subjectId === 'n2')!.tenant).toBe('t2') // the caller's own value wins
    await p.destroy()
  })
})
