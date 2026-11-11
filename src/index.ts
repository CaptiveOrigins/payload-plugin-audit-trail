import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionAfterLoginHook,
  CollectionBeforeChangeHook,
  CollectionAfterOperationHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  Config,
  Field,
  FieldAccess,
  Payload,
  PayloadRequest,
  Plugin,
} from 'payload'

import { canonical, entryHash, moveHead, readHead, SEAL_KEY, sealDigest, sealHasher, valuesHash } from './chain.js'

/**
 * Audit trail for Payload: who changed which fields of which record, from where and through whom, never the
 * values, written in the same transaction as the change. An opt-in log of old and new values for fields a site
 * names, never people's personal details. A sink other plugins' `onEvent` can write to.
 */

export const DEFAULT_ORIGINS = ['manual', 'web', 'import', 'sync', 'integration', 'job', 'webhook', 'script'] as const

/** How the change was made, beyond the signed-in account: switched in (Hats), by a guardian, while masquerading… */
export type Via = { kind: string; id?: string | null; label?: string | null }

/** What a caller says about automated work, in `req.context.audit`. `reason` is free text a developer writes: never put values in it. */
export type AuditContext = { origin?: string; system?: string; run?: string; reason?: string }

export type AuditTrailOptions = {
  /** Collections to record create, update and delete for. */
  collections: string[]
  /** The trail's slug. Default `audit-events`. */
  slug?: string
  /** The auth collection actors come from. Default `users`. */
  users?: string
  /** Actions beyond create, update and delete that `recordEvent` may write (e.g. `masquerade`, `hats`). Anything else is refused. */
  actions?: string[]
  /** Allowed origins. Default: manual, web, import, sync, integration, job, webhook, script. */
  origins?: string[]
  /** More field names never to list (beyond auth internals, timestamps, joins and `_`-prefixed ones). */
  ignore?: string[]
  /** Who reads the trail (`read`) and who reads logged values (`values`). Both default to nobody. */
  access?: { read?: Access; values?: FieldAccess }
  /** Fills `via` from the request. The site composes it from what it has (Hats, guardians, masquerade). */
  via?: (args: { req: PayloadRequest }) => Via | null | undefined | Promise<Via | null | undefined>
  /** Site-only fields (a site, an import run…), filled by `extra`. */
  extraFields?: Field[]
  extra?: (args: { req: PayloadRequest; doc?: Record<string, unknown>; collection?: string }) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** The opt-in value log: `{ collection: ['field', …] }`. Old and new values of those fields only, on update. */
  values?: Record<string, string[]>
  /** People's personal details: never logged as values. Names (any collection) or `collection.field`. */
  personal?: string[]
  /** Relationships to the auth collection allowed in the value log anyway, as `collection.field` (e.g. a studbook holder). */
  allowPeople?: string[]
  /** Largest stored value, per field, in bytes of JSON. Default 2048; larger ones are marked truncated. */
  valueMaxBytes?: number
  /** `fail` (default): a change whose entry can't be written fails. `log`: logged and let through, and needed where there are no transactions. */
  onWriteError?: 'fail' | 'log'
  /** Admin group. */
  adminGroup?: string
  /** How often the site runs `sealAuditTrail` (verify warns about entries unsealed for longer). Default 24. */
  sealEveryHours?: number
  /** Seals stop this many minutes before now, so transactions still open land in the next seal. Default 10. */
  sealGraceMinutes?: number
  /** Called after each seal: copy the digest somewhere the database's writers can't reach (a log, an email). */
  onSeal?: (seal: { digest: string; upTo: string; count: number; kind: 'seal' | 'checkpoint' | 'adoption' }) => void | Promise<void>
}

export type AuditEntry = {
  action: string
  subject: { collection: string; id: string | number }
  actor?: string | number | null
  via?: Via | null
  origin?: string
  system?: string | null
  reason?: string | null
  fields?: string[]
  extra?: Record<string, unknown>
  /** Pass the operation's `req` so the entry shares its transaction. */
  req?: PayloadRequest
  /** When there's no `req` (an event raised outside a request). */
  payload?: Payload
}

type Resolved = Required<Pick<AuditTrailOptions, 'slug' | 'users' | 'onWriteError' | 'valueMaxBytes' | 'sealEveryHours' | 'sealGraceMinutes'>> & {
  heads: string
  seals: string
  extraNames: string[]
  onSeal?: AuditTrailOptions['onSeal']
  collections: string[]
  actions: string[]
  origins: string[]
  ignore: Set<string>
  values: Record<string, string[]>
  via?: AuditTrailOptions['via']
  extra?: AuditTrailOptions['extra']
}

/** Never listed, even by name (auth internals and timestamps). */
const AUTH_INTERNALS = ['hash', 'salt', 'sessions', 'resetPasswordToken', 'resetPasswordExpiration', 'loginAttempts', 'lockUntil', '_verified', '_verificationToken', 'apiKey', 'apiKeyIndex', 'enableAPIKey', 'password']
const ALWAYS_IGNORED = [...AUTH_INTERNALS, 'updatedAt', 'createdAt', 'id']
const nobody = () => false

const optionsOf = (payload: Payload): Resolved => {
  const o = payload.config.custom?.auditTrail as Resolved | undefined
  if (!o) throw new Error('audit-trail: the plugin is not configured on this site.')
  return o
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Relationships compare by id (the saved doc may be populated, the previous one not); array rows by content. */
export const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]))
  if (isObject(a) && !isObject(b) && 'id' in a) return String(a.id) === String(b)
  if (isObject(b) && !isObject(a) && 'id' in b) return String(b.id) === String(a)
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every((k) => same(a[k] ?? null, b[k] ?? null))
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Digests of stored values, by field, read from the database before and after a write. They stay in memory, never in an entry, `req.context` or a log. */
export type Stored = { before?: Record<string, string>; after: Record<string, string> }

/** A stored value's digest; a missing value, null or an empty group all read as "". */
const fingerprint = (v: unknown) => (canonical(v) === null ? '' : valuesHash(v))
const differs = (stored: Stored, k: string) => (stored.before?.[k] ?? '') !== (stored.after[k] ?? '')

/**
 * The top-level fields that changed. Readable fields compare the saved copy with the previous one. A hidden or
 * read-restricted field (`unreadable`) can be missing from the saved copy only because it wasn't read back, so it
 * compares what the database held before and after the write (`stored`); without that, only when both copies have
 * it. A new hash or salt lists `password`, by name only: they're never listed themselves.
 */
export const changed = (doc: Record<string, unknown>, previous: Record<string, unknown> | undefined, skip: Set<string>, unreadable: Set<string> = new Set(), stored?: Stored) => {
  const fields = [...new Set([...Object.keys(doc ?? {}), ...Object.keys(previous ?? {})])]
    .filter((k) => !skip.has(k) && !k.startsWith('_') && !unreadable.has(k))
    .filter((k) => !same(doc?.[k] ?? null, previous?.[k] ?? null))
  for (const k of unreadable) {
    if (skip.has(k) || k.startsWith('_')) continue
    if (stored ? differs(stored, k) : previous && k in previous && k in (doc ?? {}) && !same(doc[k], previous[k])) fields.push(k)
  }
  if (stored && (differs(stored, 'hash') || differs(stored, 'salt'))) fields.push('password')
  return [...new Set(fields)].sort()
}

const idOf = (v: unknown) => (v && typeof v === 'object' && 'id' in v ? (v as { id: unknown }).id : v)

/** A value as stored: JSON, ids for relationships, and marked truncated past the cap. */
function stored(value: unknown, max: number): unknown {
  const plain = Array.isArray(value) ? value.map((v) => (isObject(v) && 'id' in v && Object.keys(v).length > 2 ? idOf(v) : v)) : isObject(value) && 'id' in value && 'createdAt' in value ? idOf(value) : value
  const text = JSON.stringify(plain ?? null)
  return Buffer.byteLength(text) > max ? { truncated: true, bytes: Buffer.byteLength(text) } : (plain ?? null)
}

async function write(payload: Payload, o: Resolved, entry: AuditEntry, values?: Record<string, { before: unknown; after: unknown }>) {
  const req = entry.req
  const extra = Object.fromEntries(Object.entries(entry.extra ?? {}).filter(([k]) => o.extraNames.includes(k)))
  const base = {
    at: new Date().toISOString(),
    action: entry.action,
    subjectCollection: entry.subject.collection,
    subjectId: String(entry.subject.id),
    actor: entry.actor ?? null,
    // Stored as `ref`: Payload keeps an `id` inside a group for itself.
    via: entry.via ? { kind: entry.via.kind, ref: entry.via.id ?? null, label: entry.via.label ?? null } : null,
    system: entry.system ?? null,
    origin: entry.origin ?? (entry.actor ? 'manual' : 'script'),
    changedFields: entry.fields ?? [],
    reason: entry.reason ?? null,
  }
  const hasValues = Boolean(values && Object.keys(values).length)
  try {
    if (!o.actions.includes(entry.action)) throw new Error(`audit-trail: "${entry.action}" isn't an action this site records.`)
    if (!o.origins.includes(String(base.origin))) throw new Error(`audit-trail: "${String(base.origin)}" isn't an origin this site records.`)
    const chainKey = `${base.subjectCollection}:${base.subjectId}`
    // Without the change's own transaction (an event recorded with only `payload`), open one: the head and the entry go together or not at all.
    const own = req?.transactionID ? undefined : ((await payload.db.beginTransaction?.()) ?? undefined)
    const r = own ? ({ ...(req ?? {}), payload, transactionID: own } as unknown as PayloadRequest) : req
    try {
      // Join the subject's chain: read its head, link to it, and move it only if nobody moved it meanwhile.
      let moved: { head: Awaited<ReturnType<typeof readHead>>; hash: string } | null = null
      try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const head = await readHead(payload, o.heads, chainKey, r)
        const seq = (head?.seq ?? 0) + 1
        const prevHash = head?.hash ?? null
        const prevAt = head?.at ? new Date(head.at).toISOString() : null
        const vh = hasValues ? valuesHash(values) : null
        const hash = entryHash({ ...base, chainKey, seq, prevHash, prevAt, extra, valuesHash: vh })
        if (!(await moveHead(payload, o.heads, chainKey, head, { hash, seq, at: base.at }, r))) continue
        moved = { head, hash }
        const data = { ...base, ...(base.via ? {} : { via: undefined }), ...extra, chainKey, seq, prevHash, prevAt, hash, ...(hasValues ? { values, valuesHash: vh } : {}) }
        if (o.onWriteError === 'log') {
          // A Payload operation that fails rolls back the whole transaction it's in, the change included, while
          // this mode reports success. Written through the adapter instead, a failed entry can't undo the change.
          await payload.db.create({ collection: o.slug, data: { ...data, at: new Date(data.at) }, ...(r ? { req: r } : {}) } as never)
        } else await payload.create({ collection: o.slug as never, data: data as never, overrideAccess: true, ...(r ? { req: r } : {}) })
        if (own) await payload.db.commitTransaction(own)
        return
      }
      throw new Error(`audit-trail: the chain for ${chainKey} kept moving; the entry wasn’t written.`)
      } catch (error) {
        // With no transaction to roll back, put the head back, so it never points at an entry that wasn't written.
        // Payload can leave a promise here that resolves to nothing when the database has no transactions.
        const tx = r?.transactionID ? await Promise.resolve(r.transactionID).catch(() => null) : null
        // In 'log' mode the caller's transaction commits anyway, so the head goes back inside it too.
        if (moved && (!tx || o.onWriteError === 'log')) {
          const inTx = tx ? { req: r } : {}
          if (moved.head) await payload.db.updateOne({ collection: o.heads, where: { and: [{ key: { equals: chainKey } }, { hash: { equals: moved.hash } }] } as never, data: { hash: moved.head.hash, seq: moved.head.seq, at: moved.head.at ?? null }, ...inTx } as never).catch(() => undefined)
          else await payload.db.deleteMany({ collection: o.heads, where: { and: [{ key: { equals: chainKey } }, { hash: { equals: moved.hash } }] } as never, ...inTx } as never).catch(() => undefined)
        }
        throw error
      }
    } catch (error) {
      if (own) await payload.db.rollbackTransaction(own).catch(() => undefined)
      throw error
    }
  } catch (error) {
    if (o.onWriteError === 'log') {
      // The name only: a message can carry details of the change.
      payload.logger.error({ msg: `audit-trail: an entry was not written (onWriteError: log; ${(error as Error | undefined)?.name ?? typeof error}): ${entry.action} on ${entry.subject.collection}` })
      return
    }
    throw error
  }
}

async function who(o: Resolved, req: PayloadRequest) {
  const actor = req.user && (req.user as { collection?: string }).collection === o.users ? (req.user.id as string | number) : null
  const via = o.via ? ((await o.via({ req })) ?? null) : null
  return { actor, via }
}

/** Per-request sets keyed by `collection:id`: what to skip or annotate applies to that record's own operation only. */
function skipped(req: PayloadRequest, name: 'auditTrailAutosave'): Set<string>
function skipped(req: PayloadRequest, name: 'auditTrailRestore'): Map<string, string>
function skipped(req: PayloadRequest, name: 'auditTrailAutosave' | 'auditTrailRestore'): Set<string> | Map<string, string> {
  req.context ??= {}
  const existing = req.context[name]
  if (existing instanceof Set || existing instanceof Map) return existing as Set<string> | Map<string, string>
  const made = name === 'auditTrailAutosave' ? new Set<string>() : new Map<string, string>()
  req.context[name] = made
  return made
}

/**
 * Per-write state, kept off `req.context` (a caller's context object can be shared by concurrent writes): for each
 * request, the before-write digests by `collection:id`. Each write to a record adds its own reading and takes its
 * own back, newest first, so writes to different records at once never touch each other's, and a nested write to
 * the same record leaves the outer one's in place.
 */
const befores = new WeakMap<object, Map<string, Record<string, string>[]>>()
function keepBefore(req: PayloadRequest, key: string, digests: Record<string, string>) {
  let byRecord = befores.get(req)
  if (!byRecord) befores.set(req, (byRecord = new Map()))
  const list = byRecord.get(key)
  if (list) list.push(digests)
  else byRecord.set(key, [digests])
}
function takeBefore(req: PayloadRequest, key: string): Record<string, string> | undefined {
  const list = befores.get(req)?.get(key)
  const taken = list?.pop()
  if (list && !list.length) befores.get(req)?.delete(key)
  return taken
}
/** A password reset in progress, per request: the account its link belongs to, and its stored hash and salt (digests) before it. */
const resets = new WeakMap<object, { id: string; before: Record<string, string> }>()

/** Digests of the named fields as the database holds them now, read inside the request's transaction. Only those fields are read. */
async function storedDigests(payload: Payload, slug: string, where: Record<string, unknown>, names: string[], req: PayloadRequest): Promise<{ id: unknown; digests: Record<string, string> } | undefined> {
  const row = (await payload.db.findOne({ collection: slug, where, req, select: Object.fromEntries(names.map((n) => [n, true])) } as never)) as Record<string, unknown> | null
  return row ? { id: row.id, digests: Object.fromEntries(names.map((n) => [n, fingerprint(row[n])])) } : undefined
}
const byId = (id: unknown) => ({ id: { equals: id } })

/** Top-level fields the saved copy may leave out because they aren't read back: hidden, or with their own read access. From the built config, so fields other plugins add count too. */
const unreadableCache = new WeakMap<object, Set<string>>()
function unreadableIn(payload: Payload, slug: string): Set<string> {
  const config = payload.collections?.[slug as never]?.config as { flattenedFields?: AnyField[] } | undefined
  if (!config) return new Set()
  let found = unreadableCache.get(config)
  if (!found) {
    found = new Set((config.flattenedFields ?? []).filter((f) => f.name && (f.hidden || f.access?.read)).map((f) => String(f.name)))
    unreadableCache.set(config, found)
  }
  return found
}

const contextOf = (req: PayloadRequest): AuditContext | false => (req.context?.audit === false ? false : ((req.context?.audit as AuditContext | undefined) ?? {}))

/**
 * Writes one entry for anything that isn't a plain create, update or delete (a sign-in as someone else, an
 * export…). Same rules as the automatic entries: append-only, no values, a known action and origin. Pass the
 * operation's `req` so it shares its transaction.
 */
export async function recordEvent(payload: Payload, entry: AuditEntry) {
  const o = optionsOf(payload)
  const base = entry.req ? await who(o, entry.req) : { actor: null, via: null }
  // The site's own fields (its tenant, say) come from its resolver too, unless the caller gave them.
  const siteExtra = entry.req && o.extra ? await o.extra({ req: entry.req, collection: entry.subject.collection }) : {}
  await write(payload, o, { ...entry, extra: { ...siteExtra, ...(entry.extra ?? {}) }, actor: entry.actor !== undefined ? entry.actor : base.actor, via: entry.via !== undefined ? entry.via : base.via })
}

/** Every Payload this plugin started on in this process, for events that arrive with neither `req` nor `payload`. */
const started = new Set<Payload>()

type EventLike = { req?: PayloadRequest; payload?: Payload } | null | undefined

/**
 * Adapts another plugin's `onEvent` in one line. The mapper turns an event into an entry (or null to skip it on
 * purpose). Payload is found from the entry's `req` or `payload`, then the event's, then `opts.payload`, then the one
 * Payload this plugin started on in this process (refused if there are several: bind one).
 *
 * By default (ADR 0001 decision 6), a mapper that throws, an unknown action or origin, or no Payload to be found
 * throws, with or without a `req`: those are mistakes in the site's wiring, and they show at once. A failed write
 * throws too when the event came with a `req`, so a plugin that awaits `onEvent` inside its own transaction has
 * its action undone. Only a failed write with no `req` logs the error's name and returns: there's no transaction
 * to undo, and the plugin's action has already happened. `onError: 'fail'` throws always; `onError: 'log'` never.
 */
export function fromPluginEvent<E>(
  mapper: (event: E) => AuditEntry | null | Promise<AuditEntry | null>,
  opts: { onError?: 'fail' | 'log'; payload?: Payload | (() => Payload | Promise<Payload>) } = {},
) {
  return async (event: E) => {
    const ev = (isObject(event) ? event : undefined) as EventLike
    let entry: AuditEntry | null = null
    let p: Payload | undefined
    let writing = false
    try {
      entry = await mapper(event)
      if (!entry) return
      p = entry.req?.payload ?? entry.payload ?? ev?.req?.payload ?? ev?.payload ?? (typeof opts.payload === 'function' ? await opts.payload() : opts.payload)
      if (!p) {
        if (started.size > 1) throw new Error('audit-trail: an event came with no `req` or `payload`, and several Payloads run in this process; pass `{ payload }` to fromPluginEvent.')
        p = [...started][0]
      }
      if (!p) throw new Error('audit-trail: an event came with no `req` or `payload`, and the plugin hasn\u2019t started on any Payload yet.')
      const o = optionsOf(p)
      if (!o.actions.includes(entry.action)) throw new Error(`audit-trail: "${entry.action}" isn't an action this site records.`)
      if (entry.origin !== undefined && !o.origins.includes(entry.origin)) throw new Error(`audit-trail: "${entry.origin}" isn't an origin this site records.`)
      writing = true
      await recordEvent(p, entry)
    } catch (error) {
      const lenient = opts.onError === 'log' || (opts.onError !== 'fail' && writing && !(entry?.req ?? ev?.req))
      if (!lenient) throw error
      // The name only: a message can carry what the event was about.
      const logger = p?.logger ?? ev?.req?.payload?.logger ?? ev?.payload?.logger ?? (started.size === 1 ? [...started][0]!.logger : undefined)
      const name = (error as Error | undefined)?.name ?? typeof error
      if (logger) logger.error({ msg: `audit-trail: a plugin event was not recorded (${name})${entry ? `: ${entry.action} on ${entry.subject.collection}` : ''}` })
      else console.error(`audit-trail: a plugin event was not recorded (${name})`)
    }
  }
}

type Entry = Record<string, any> & { id: string | number; at: string; hash: string; prevHash?: string | null; seq: number; chainKey: string }
type Seal = { id: string | number; kind: 'seal' | 'checkpoint' | 'adoption'; seq: number; prevDigest?: string | null; digest: string; fromAt?: string | null; upTo: string; count: number }

const allSorted = async (payload: Payload, slug: string, where: Record<string, unknown> = {}, sort: string[] = ['at', 'id'], req?: PayloadRequest) =>
  (await payload.find({ collection: slug as never, where: where as never, sort, limit: 0, pagination: false, depth: 0, overrideAccess: true, showHiddenFields: true, ...(req ? { req } : {}) })).docs as unknown as Record<string, any>[]

/** Writes a seal (or checkpoint) and moves the seal head conditionally, in one transaction when there is one. Null when another seal won. */
async function writeSeal(payload: Payload, o: Resolved, build: (last: Seal | null, req?: PayloadRequest) => Promise<Omit<Seal, 'id' | 'seq' | 'prevDigest'> | null>) {
  const id = (await payload.db.beginTransaction?.()) ?? undefined
  const req = id ? ({ payload, transactionID: id } as unknown as PayloadRequest) : undefined
  try {
    const head = await readHead(payload, o.heads, SEAL_KEY, req)
    const last = head ? ((await allSorted(payload, o.seals, { seq: { equals: head.seq } }))[0] as Seal | undefined) ?? null : null
    const seal = await build(last, req)
    if (!seal) {
      if (id) await payload.db.rollbackTransaction(id)
      return null
    }
    const seq = (head?.seq ?? 0) + 1
    if (!(await moveHead(payload, o.heads, SEAL_KEY, head, { hash: seal.digest, seq, at: seal.upTo }, req))) {
      if (id) await payload.db.rollbackTransaction(id)
      return null // another seal ran at the same moment and won: nothing to do
    }
    await payload.db.create({ collection: o.seals, data: { ...seal, seq, prevDigest: head?.hash ?? null }, ...(req ? { req } : {}) })
    if (id) await payload.db.commitTransaction(id)
    await o.onSeal?.({ digest: seal.digest, upTo: seal.upTo, count: seal.count, kind: seal.kind })
    return { ...seal, seq }
  } catch (error) {
    if (id) await payload.db.rollbackTransaction(id).catch(() => undefined)
    // Another seal's transaction touched the same head: it won. Mongo reports this as a transient write conflict.
    const e = error as { message?: string; code?: number; errorLabels?: string[]; hasErrorLabel?: (l: string) => boolean }
    if (e?.code === 112 || e?.hasErrorLabel?.('TransientTransactionError') || e?.errorLabels?.includes('TransientTransactionError') || /WriteConflict|write conflict|retry your operation/i.test(String(e?.message))) return null
    throw error
  }
}

/**
 * Seals every entry since the last seal, up to the grace before now, into one digest chained to the previous seal,
 * and hands it to `onSeal` to copy out. Run it from the site's job every `sealEveryHours`. Two seals at once can't
 * fork the chain: the second does nothing. A change is fully protected once it's sealed.
 */
export async function sealAuditTrail(payload: Payload, args: { now?: Date; upTo?: Date } = {}) {
  const o = optionsOf(payload)
  const now = args.now ?? new Date()
  const latest = new Date(now.getTime() - o.sealGraceMinutes * 60_000)
  if (args.upTo && args.upTo.getTime() > latest.getTime()) throw new Error(`audit-trail: a seal can't reach closer than ${o.sealGraceMinutes} minutes to now (transactions may still be open).`)
  const upTo = (args.upTo ?? latest).toISOString()
  return writeSeal(payload, o, async (last) => {
    // Continue from the newest end of any seal or checkpoint, not just the last one written: a checkpoint can end
    // earlier than a seal before it, and starting there would seal the same entries twice. The adoption is left
    // out: it covers only unhashed entries, so a hashed entry dated before its end still needs a regular seal.
    const newest = (await allSorted(payload, o.seals, { kind: { in: ['seal', 'checkpoint'] } }, ['-upTo']))[0] as Seal | undefined
    const from = newest ? new Date(newest.upTo).toISOString() : null
    if ((from && from >= upTo) || (last && last.kind !== 'adoption' && new Date(last.upTo).toISOString() >= upTo)) return null
    // Entries from before chaining have no hash: the adoption seal covers them, never a regular one.
    const entries = await allSorted(payload, o.slug, { and: [{ at: { less_than_equal: upTo } }, { hash: { exists: true } }, { hash: { not_equals: '' } }, ...(from ? [{ at: { greater_than: from } }] : [])] })
    return { kind: 'seal', fromAt: from, upTo, count: entries.length, digest: sealDigest(last?.digest ?? null, entries.map((e) => String(e.hash)), upTo) }
  })
}

/** What an adopted (pre-chain) entry's digest covers: everything but its id, the chain fields and its values (whose own hash is covered). */
const CHAIN_FIELDS = new Set(['id', 'chainKey', 'seq', 'prevHash', 'prevAt', 'hash', 'values'])
const adoptedHash = (e: Record<string, unknown>) => valuesHash(Object.fromEntries(Object.entries(e).filter(([k]) => !CHAIN_FIELDS.has(k))))
const unhashedWhere = { or: [{ hash: { exists: false } }, { hash: { equals: null } }, { hash: { equals: '' } }] }

/**
 * For a site that kept an audit log before this plugin: run once, as a script, after switching. It seals every
 * entry that has no hash (written before chaining), up to the newest of them, into one "adoption" seal in the seal
 * chain, so that history is tamper-evident from now on. Each adopted entry's logged values get their own hash
 * first, and the digest covers it: values can still be cleared by age, but not edited. Verify then accepts
 * unhashed entries only inside that seal, and treats any written after it as a break.
 *
 * Safe to run again: with an adoption already made, it does nothing if there's nothing new, and refuses if
 * unhashed entries appeared after it. It refuses once the trail has been pruned at all, since an adoption may have
 * been cut away and unhashed entries can then only be a break. Everything is read inside the seal's own
 * transaction, so a seal or prune at the same moment can't slip between the check and the write.
 */
export async function adoptExistingEntries(payload: Payload): Promise<{ adopted: number; upTo: string | null }> {
  const o = optionsOf(payload)
  let result: { adopted: number; upTo: string | null } = { adopted: 0, upTo: null }
  let refused: Error | null = null
  const done = await writeSeal(payload, o, async (_last, req) => {
    const read = (slug: string, where: Record<string, unknown>, sort?: string[]) => allSorted(payload, slug, where, sort, req)
    const unhashed = (await read(o.slug, unhashedWhere)) as Record<string, any>[]
    const adoption = ((await read(o.seals, { kind: { equals: 'adoption' } }, ['seq'])) as unknown as Seal[])[0] ?? null
    if (adoption) {
      const after = unhashed.filter((e) => new Date(e.at).toISOString() > new Date(adoption.upTo).toISOString())
      if (after.length) refused = new Error(`audit-trail: ${after.length} unhashed entr${after.length === 1 ? 'y was' : 'ies were'} written after the adoption seal. That's a break, not history: run verifyAuditTrail and look into it.`)
      result = { adopted: 0, upTo: new Date(adoption.upTo).toISOString() }
      return null
    }
    if (!unhashed.length) return null
    if ((await read(o.seals, { kind: { equals: 'checkpoint' } })).length) {
      refused = new Error('audit-trail: the trail has been pruned, so unhashed entries now are a break, not history to adopt. Run verifyAuditTrail and look into them.')
      return null
    }
    for (const e of unhashed)
      if (e.values && !e.valuesHash) {
        e.valuesHash = valuesHash(e.values)
        await payload.db.updateOne({ collection: o.slug, where: { id: { equals: e.id } }, data: { valuesHash: e.valuesHash }, ...(req ? { req } : {}) } as never)
      }
    const upTo = new Date(unhashed.at(-1)!.at).toISOString()
    result = { adopted: unhashed.length, upTo }
    return { kind: 'adoption', fromAt: null, upTo, count: unhashed.length, digest: sealDigest(_last?.digest ?? null, unhashed.map(adoptedHash), upTo, 'adoption') }
  })
  if (refused) throw refused
  if (result.adopted && !done) throw new Error('audit-trail: a seal ran at the same moment; run the adoption again.')
  return result
}

/**
 * Deletes and clears by age, for the site's job (no timers inside). `valuesOlderThanDays` clears logged values and
 * keeps the entries (their chain is unchanged: values have their own hash). `olderThanDays` first writes a
 * checkpoint seal recording the cut, then deletes entries and seals before it. With neither, nothing happens.
 */
export async function pruneAuditTrail(payload: Payload, args: { olderThanDays?: number; valuesOlderThanDays?: number; now?: Date } = {}) {
  const o = optionsOf(payload)
  const now = args.now ?? new Date()
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
  let valuesCleared = 0
  let deleted = 0
  if (args.valuesOlderThanDays !== undefined) {
    const r = await payload.update({ collection: o.slug as never, where: { and: [{ at: { less_than: before(args.valuesOlderThanDays) } }, { values: { exists: true } }] } as never, data: { values: null } as never, overrideAccess: true, context: { audit: false } })
    valuesCleared = r.docs.length
  }
  if (args.olderThanDays !== undefined) {
    // Cut only at a seal's end, so every entry kept stays in an intact seal, and seals covering later entries stay.
    const asked = before(args.olderThanDays)
    const boundary = (await allSorted(payload, o.seals, { and: [{ kind: { equals: 'seal' } }, { upTo: { less_than_equal: asked } }] }, ['-upTo']))[0] as Seal | undefined
    if (boundary) {
      const cut = new Date(boundary.upTo).toISOString()
      const checkpoint = await writeSeal(payload, o, async (last) => ({ kind: 'checkpoint', fromAt: null, upTo: cut, count: 0, digest: sealDigest(last?.digest ?? null, [], cut, 'checkpoint') }))
      if (!checkpoint) throw new Error('audit-trail: a seal ran at the same moment; prune again.')
      // Adopted entries go only once the cut passes the whole adoption, so its digest can still be checked until then.
      const adoption = (await allSorted(payload, o.seals, { kind: { equals: 'adoption' } }))[0] as Seal | undefined
      const keepAdopted = adoption && new Date(adoption.upTo).toISOString() > cut
      const r = await payload.delete({ collection: o.slug as never, where: { and: [{ at: { less_than_equal: cut } }, ...(keepAdopted ? [{ hash: { exists: true } }] : [])] } as never, overrideAccess: true })
      deleted = r.docs.length
      await payload.db.deleteMany({ collection: o.seals, where: { and: [{ kind: { equals: 'seal' } }, { upTo: { less_than_equal: cut } }] } as never })
      // Its entries are gone, so the adoption seal goes too, like the seals before the cut; the checkpoint records it.
      if (adoption && !keepAdopted) await payload.db.deleteMany({ collection: o.seals, where: { kind: { equals: 'adoption' } } as never })
    }
  }
  return { valuesCleared, deleted }
}

export type VerifyArgs = {
  /** Recompute hashes only for entries from this date on (links and heads are still checked for all of them). */
  since?: Date
  now?: Date
  /** How many entries, heads or seals one query reads. Verify never holds more than this (plus one) at a time. Default 1,000. */
  pageSize?: number
  /**
   * The digest of a seal or checkpoint you've already verified, as `onSeal` gave it: check only what was written
   * after it. That seal is recomputed first, so its end can't be moved. The result is marked `partial`.
   */
  from?: string
  /** Stop once this many entries have been read and more remain. The result is then `finished: false`, never ok. */
  stopAfter?: number
  /** Called after each page of entries, and after each seal. If it throws, verify throws. */
  onProgress?: (progress: VerifyProgress) => unknown
}

export type VerifyProgress = { phase: 'entries' | 'seals'; read: number; checked: number; seals: number }

export type VerifyRange = {
  /** The seal or checkpoint the check started from. Null when it started at the beginning of the trail. */
  from: { kind: 'seal' | 'checkpoint'; seq: number; digest: string; upTo: string } | null
  /** Entries dated up to `from`, which this run did not read. 0 without `from`. */
  skipped: number
  /** Entries this run read. */
  read: number
}

export type VerifyResult = {
  /** True only when everything asked for was read and nothing was wrong. A run that stopped early is never ok. */
  ok: boolean
  /** Entries whose hash was recomputed. */
  checked: number
  /** The first break, or where a read failed. */
  firstBreak?: { id: string; reason: string }
  warnings: string[]
  /** False when it stopped before reaching a verdict: `stopAfter` was reached, or the trail couldn't be read. */
  finished: boolean
  /** True when this result doesn't speak for the whole trail: it started `from` a seal, or didn't finish. */
  partial: boolean
  range: VerifyRange
  /** What was checked, in a sentence, for logs and people. */
  summary: string
}

/** Thrown inside verify to end it: a break (`finished`), or a read that can't be trusted (`finished: false`). */
class Stop extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
    readonly finished = true,
  ) {
    super(reason)
  }
}

const OUT_OF_ORDER = 'the trail came back out of order here, so nothing past this point was checked'
const byAtThenId = (a: Record<string, any>, b: Record<string, any>) => (a.at < b.at ? -1 : a.at > b.at ? 1 : String(a.id) < String(b.id) ? -1 : 1)
const allOf = (parts: Record<string, unknown>[]) => (parts.length ? { and: parts } : {})
const hashedWhere = [{ hash: { exists: true } }, { hash: { not_equals: '' } }]

/**
 * Recomputes every entry's hash and its link to the entry before it in its record's chain, checks each chain's head
 * against its newest entry, and recomputes every seal. Reports the first break; never guesses. `since` limits the
 * entries whose hashes are recomputed (links and heads are still checked).
 *
 * It reads the trail a page at a time (`pageSize`) and keeps only the running state: the entry before, the chains
 * a page finished, a seal's running digest. Anything it can't read, or that comes back out of order or longer than
 * asked, is a failed verification with the position, never a pass. `from` checks only what follows a seal you
 * verified before, and `stopAfter` stops early; both say so in the result (`partial`, `finished`, `range`, `summary`).
 */
export async function verifyAuditTrail(payload: Payload, args: VerifyArgs = {}): Promise<VerifyResult> {
  const o = optionsOf(payload)
  const now = args.now ?? new Date()
  const size = args.pageSize ?? 1000
  if (!Number.isInteger(size) || size < 1) throw new RangeError('audit-trail: pageSize must be a whole number, 1 or more.')
  if (args.stopAfter !== undefined && (!Number.isInteger(args.stopAfter) || args.stopAfter < 1)) throw new RangeError('audit-trail: stopAfter must be a whole number, 1 or more.')
  const warnings: string[] = []
  const range: VerifyRange = { from: null, skipped: 0, read: 0 }
  let checked = 0
  let read = 0
  let sealsRead = 0
  let stopped = false

  const result = (ok: boolean, finished: boolean, firstBreak?: { id: string; reason: string }): VerifyResult => {
    range.read = read
    const n = (v: number) => v.toLocaleString('en-US')
    const f = range.from
    const since = f ? `${f.kind} ${f.seq} (up to ${f.upTo})` : ''
    const left = f ? ` The ${n(range.skipped)} entr${range.skipped === 1 ? 'y' : 'ies'} up to it ${range.skipped === 1 ? 'was' : 'were'} not checked.` : ''
    const scope = !f ? `all ${n(read)} entr${read === 1 ? 'y' : 'ies'}` : read ? `entries ${n(range.skipped + 1)}–${n(range.skipped + read)} in time order, written after ${since}` : `the trail after ${since}, where no entries were written`
    const summary = firstBreak
      ? `${finished ? 'Break' : 'Not finished: failed'} at ${firstBreak.id}: ${firstBreak.reason}. Read ${n(read)} entr${read === 1 ? 'y' : 'ies'}${f ? ` written after ${since}` : ''} before that.${left}`
      : !finished
        ? `Not finished: stopped after ${n(read)} entr${read === 1 ? 'y' : 'ies'}${f ? ` written after ${since}` : ''}, as asked. No break so far, but the rest of the entries, their heads and the seals were not checked.${left}`
        : `No break in ${scope}.${left}`
    return { ok, checked, ...(firstBreak ? { firstBreak } : {}), warnings, finished, partial: Boolean(f) || !finished, range, summary }
  }

  /** One bounded read. A failed read, or one longer than asked, ends the verification where it stood. */
  const find = async (at: string, slug: string, where: Record<string, unknown>, sort: string[], limit: number) => {
    let docs: unknown
    try {
      docs = (await payload.find({ collection: slug as never, where: where as never, sort, limit, pagination: false, depth: 0, overrideAccess: true, showHiddenFields: true })).docs
    } catch (error) {
      // The name only: a message can carry details of the query.
      throw new Stop(at, `the trail couldn't be read here (${(error as Error | undefined)?.name ?? typeof error}), so nothing past this point was checked`, false)
    }
    if (!Array.isArray(docs) || docs.length > limit) throw new Stop(at, 'a read returned more than it was asked for, so nothing past this point was checked', false)
    return docs as Record<string, any>[]
  }
  const count = async (at: string, where: Record<string, unknown>) => {
    try {
      return (await payload.count({ collection: o.slug as never, where: where as never, overrideAccess: true })).totalDocs
    } catch (error) {
      throw new Stop(at, `the trail couldn't be counted here (${(error as Error | undefined)?.name ?? typeof error})`, false)
    }
  }

  /**
   * A collection in the order of one or two fields, a page at a time. Each page starts at the last row of the page
   * before and must meet it again, so a row sharing its position can't fall between two pages.
   */
  async function* ordered(slug: string, base: Record<string, unknown>[], fields: [string] | [string, string]): AsyncGenerator<Record<string, any>> {
    const [a, b] = fields
    let last: Record<string, any> | null = null
    for (;;) {
      const at: string = last ? `${slug} after ${fields.map((f) => String(last![f])).join(' #')}` : `the start of ${slug}`
      const cursor = !last ? [] : b ? [{ or: [{ [a]: { greater_than: last[a] } }, { and: [{ [a]: { equals: last[a] } }, { [b]: { greater_than_equal: last[b] } }] }] }] : [{ [a]: { greater_than_equal: last[a] } }]
      const limit = size + (last ? 1 : 0)
      const docs = await find(at, slug, allOf([...base, ...cursor]), fields, limit)
      let met = !last
      let fresh: Record<string, any> | null = null
      for (const d of docs) {
        if (last && String(d.id) === String(last.id)) {
          met = true
          continue
        }
        const before: Record<string, any> | null = fresh ?? last
        fresh = d
        yield d
        // The caller treats two rows in one position as a break. If it didn't, paging can't go on safely.
        if (before && d[a] === before[a] && (!b || d[b] === before[b])) throw new Stop(`${slug} at ${fields.map((f) => String(d[f])).join(' #')}`, `two rows share this position; ${OUT_OF_ORDER}`, false)
      }
      if (!met) throw new Stop(at, OUT_OF_ORDER, false)
      if (docs.length < limit || !fresh) return
      last = fresh
    }
  }

  /**
   * Entries in time order, then by id, a page at a time. The database sorts by time alone (its index does that
   * without reading ahead); entries sharing a page's last moment are read again by id, however many there are.
   */
  async function* byTime(base: Record<string, unknown>[]): AsyncGenerator<Record<string, any>> {
    let after: string | null = null
    for (;;) {
      const at: string = after ? `${o.slug} after ${after}` : `the start of ${o.slug}`
      const docs = await find(at, o.slug, allOf([...base, ...(after ? [{ at: { greater_than: after } }] : [])]), ['at'], size)
      for (const d of docs) if (typeof d.at !== 'string' || (after !== null && d.at <= after)) throw new Stop(at, OUT_OF_ORDER, false)
      if (docs.length < size) {
        yield* docs.sort(byAtThenId)
        return
      }
      const edge: string = docs.reduce((latest, d) => (d.at > latest ? d.at : latest), docs[0]!.at as string)
      yield* docs.filter((d) => d.at < edge).sort(byAtThenId)
      let lastId: unknown = null
      for (;;) {
        const group = await find(`${o.slug} at ${edge}`, o.slug, allOf([...base, { at: { equals: edge } }, ...(lastId === null ? [] : [{ id: { greater_than: lastId } }])]), ['id'], size)
        for (const d of group) if (d.at !== edge || String(d.id) === String(lastId)) throw new Stop(`${o.slug} at ${edge}`, OUT_OF_ORDER, false)
        yield* group
        if (group.length < size) break
        lastId = group.at(-1)!.id
      }
      after = edge
    }
  }

  const progress = async (phase: VerifyProgress['phase']) => {
    if (args.onProgress) await args.onProgress({ phase, read, checked, seals: sealsRead })
  }
  /** Counts an entry as read. False when `stopAfter` was already reached, so this one is left unread. */
  const take = async () => {
    if (args.stopAfter !== undefined && read >= args.stopAfter) return !(stopped = true)
    read++
    if (read % size === 0) await progress('entries')
    return true
  }

  try {
    // Where to start: the beginning, or a seal the caller verified before.
    let after: string | null = null
    let anchor: Seal | null = null
    let walkFrom: number | null = null
    if (args.from !== undefined) {
      const digest = String(args.from)
      const found = (await find('the seal to start from', o.seals, { digest: { equals: digest } }, ['seq'], 2)) as unknown as Seal[]
      if (found.length !== 1) throw new Stop(digest, found.length ? 'two seals carry the digest to start from' : 'the seal to start from was not found: it was changed or removed, or the digest isn’t one of this trail’s seals', false)
      anchor = found[0]!
      if (anchor.kind !== 'seal' && anchor.kind !== 'checkpoint') throw new Stop(digest, 'verify can start from a seal or a checkpoint, not from an adoption seal', false)
      after = new Date(anchor.upTo).toISOString()
      walkFrom = anchor.seq
      if (anchor.kind === 'checkpoint') {
        // Seals written before the checkpoint can end after its cut. Their entries are in range, so they're recomputed too.
        const earlier = (await find('the seals', o.seals, { and: [{ kind: { equals: 'seal' } }, { upTo: { greater_than: after } }] }, ['seq'], 1))[0]
        if (earlier && earlier.seq < walkFrom) walkFrom = earlier.seq
      }
      range.from = { kind: anchor.kind, seq: anchor.seq, digest: anchor.digest, upTo: after }
      range.skipped = await count('the entries before the seal to start from', { at: { less_than_equal: after } })
    }
    const inRange = after ? [{ at: { greater_than: after } }] : []
    const checkpoint = ((await find('the seals', o.seals, { kind: { equals: 'checkpoint' } }, ['-seq'], 1))[0] as Seal | undefined) ?? null
    // Entries with no hash were written before chaining. They're allowed only inside the adoption seal's range.
    const adoption = ((await find('the seals', o.seals, { kind: { equals: 'adoption' } }, ['seq'], 1))[0] as Seal | undefined) ?? null
    const adoptionRead = Boolean(adoption) && (walkFrom === null || adoption!.seq >= walkFrom)

    for await (const e of byTime([unhashedWhere, ...inRange])) {
      if (!(await take())) break
      if (e.values && (!e.valuesHash || valuesHashOf(e.values) !== e.valuesHash)) throw new Stop(String(e.id), 'its logged values were changed')
      if (!adoption) throw new Stop(String(e.id), 'an entry has no hash and there is no adoption seal (it was written outside the plugin, or adoptExistingEntries hasn’t run)')
      if (new Date(e.at).toISOString() > adoption.upTo) throw new Stop(String(e.id), 'an entry has no hash and was written after the adoption seal (something wrote around the plugin)')
      if (!adoptionRead) throw new Stop(String(e.id), 'an entry with no hash is dated after the seal this check started from, and its adoption seal is before it: run a full verify')
    }

    const since = args.since?.toISOString()
    // 1. Each record's chain: hashes, links, no gaps. Only the entry before is kept, and the chains finished since the last look at the heads.
    type Ended = { key: string; id: string | number; hash: string; seq: number }
    let ended: Ended[] = []
    let headsRead: string | null = null
    let headBreak: { id: string; reason: string } | null = null
    let noHead: string | null = null
    // 2. Heads: each chain's newest entry must be the one its head points to (an entry deleted after its last seal
    // shows here). Chains and heads come in the same order, so the heads up to the last finished chain are read
    // beside them; the database does every comparison of keys. A break here waits: one in an entry comes first.
    const checkHeads = async (final: boolean) => {
      if (!final && !ended.length) return
      const place = new Map(ended.map((c, i) => [c.key, i]))
      const upper = final ? null : ended.at(-1)!.key
      const missed: Ended[] = []
      let next = 0
      const base = [{ key: { not_equals: SEAL_KEY } }, ...inRange, ...(headsRead === null ? [] : [{ key: { greater_than: headsRead } }]), ...(upper === null ? [] : [{ key: { less_than_equal: upper } }])]
      for await (const h of ordered(o.heads, base, ['key'])) {
        const i = place.get(h.key)
        if (i === undefined) {
          if (checkpoint && h.at && h.at < checkpoint.upTo) continue // the whole chain was pruned
          headBreak ??= { id: String(h.key), reason: after ? 'every entry of this chain written after the seal is missing' : 'every entry of this chain is missing' }
          continue
        }
        // A head that comes before one already matched leaves the chains between them in `missed`, and stops below.
        for (; next < i; next++) missed.push(ended[next]!)
        const last = ended[i]!
        next = i + 1
        if (last.hash !== h.hash || last.seq !== h.seq) headBreak ??= { id: String(last.id), reason: `the newest entries of ${h.key} are missing or changed` }
      }
      for (; next < ended.length; next++) missed.push(ended[next]!)
      if (missed.length) {
        // No head where the chain's place is. If it has one elsewhere, the chains didn't come in order: stop.
        const elsewhere = await find(`the head of ${missed[0]!.key}`, o.heads, { key: { in: missed.map((c) => c.key) } }, ['key'], missed.length)
        if (elsewhere.length) throw new Stop(String(elsewhere[0]!.key), after ? `the head of this chain is out of place, or dated before the seal while its entries are after it; ${OUT_OF_ORDER}` : OUT_OF_ORDER, false)
        noHead ??= missed[0]!.key
      }
      if (upper !== null) headsRead = upper
      ended = []
    }
    let prev: Entry | undefined
    if (!stopped)
      for await (const row of ordered(o.slug, [...hashedWhere, ...inRange], ['chainKey', 'seq'])) {
        const e = row as Entry
        if (!(await take())) break
        if (prev && e.chainKey !== prev.chainKey) {
          ended.push({ key: prev.chainKey, id: prev.id, hash: prev.hash, seq: prev.seq })
          prev = undefined
          if (ended.length >= size) await checkHeads(false)
        }
        if (!since || e.at >= since) {
          checked++
          const extra = Object.fromEntries(o.extraNames.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]))
          if (entryHash({ ...(e as unknown as Parameters<typeof entryHash>[0]), extra }) !== e.hash) throw new Stop(String(e.id), 'the entry was changed after it was written')
          if (e.values && e.valuesHash && valuesHashOf(e.values) !== e.valuesHash) throw new Stop(String(e.id), 'its logged values were changed')
        }
        if (typeof e.chainKey !== 'string' || typeof e.seq !== 'number') throw new Stop(String(e.id), 'the entry has no place in a chain (it was changed after it was written)')
        if (prev) {
          if (e.seq !== prev.seq + 1) throw new Stop(String(e.id), `an entry before it in ${e.chainKey} is missing`)
          if (e.prevHash !== prev.hash) throw new Stop(String(e.id), `it doesn't link to the entry before it in ${e.chainKey}`)
        } else if (e.seq !== 1 && !(e.prevAt && ((checkpoint && new Date(e.prevAt).toISOString() <= checkpoint.upTo) || (after && new Date(e.prevAt).toISOString() <= after)))) {
          // A chain may start mid-way only where a checkpoint recorded the cut, or at the seal this check started
          // from, and only if what's before it is from before that point.
          throw new Stop(String(e.id), `the start of ${e.chainKey} is missing`)
        } else if (e.seq === 1 && e.prevHash) throw new Stop(String(e.id), 'a first entry links to something')
        prev = e
      }
    if (!stopped) {
      if (prev) ended.push({ key: prev.chainKey, id: prev.id, hash: prev.hash, seq: prev.seq })
      await checkHeads(true)
    }
    await progress('entries')
    const pending = (headBreak as { id: string; reason: string } | null) ?? (noHead === null ? null : { id: String(noHead), reason: 'this chain has no head (it was added outside the plugin)' })
    if (pending) throw new Stop(pending.id, pending.reason, !stopped)
    if (stopped) return result(false, false)

    // 3. Seals: each digest from the entries in its range, each linked to the one before. A digest is built as its
    // entries are read, never from a list of them.
    let prevSeal: Seal | null = null
    for await (const row of ordered(o.seals, walkFrom === null ? [] : [{ seq: { greater_than_equal: walkFrom } }], ['seq'])) {
      const s = row as unknown as Seal
      sealsRead++
      if (prevSeal && s.prevDigest !== prevSeal.digest) throw new Stop(String(s.id), 'a seal doesn’t link to the seal before it')
      if (s.kind === 'checkpoint') {
        if (sealDigest(s.prevDigest ?? null, [], s.upTo, 'checkpoint') !== s.digest) throw new Stop(String(s.id), 'a checkpoint was changed')
      } else if (s.kind === 'adoption') {
        // Once a checkpoint cut past the whole adoption, its entries are gone by design and only the link is checked.
        const prunedPast = checkpoint && checkpoint.upTo >= new Date(s.upTo).toISOString()
        if (prunedPast) {
          const left = (await byTime([unhashedWhere]).next()).value as Record<string, any> | undefined
          if (left) throw new Stop(String(left.id), 'an adopted entry is still here after the cut that should have removed it')
        } else {
          const running = sealHasher(s.prevDigest ?? null, new Date(s.upTo).toISOString(), 'adoption')
          let inSeal = 0
          for await (const e of byTime([unhashedWhere])) {
            running.add(adoptedHash(e))
            if (++inSeal > s.count) break
          }
          if (inSeal !== s.count || running.digest() !== s.digest) throw new Stop(String(s.id), 'entries from before chaining were added, removed or changed since they were adopted')
        }
      } else {
        const running = sealHasher(s.prevDigest ?? null, s.upTo)
        let inSeal = 0
        for await (const e of byTime([...hashedWhere, { at: { less_than_equal: s.upTo } }, ...(s.fromAt ? [{ at: { greater_than: s.fromAt } }] : [])])) {
          running.add(String(e.hash))
          if (++inSeal > s.count) break
        }
        if (inSeal !== s.count || running.digest() !== s.digest) throw new Stop(String(s.id), 'entries in a sealed range were added, removed, reordered or changed')
      }
      prevSeal = s
      await progress('seals')
    }
    const sealHead = (await find('the newest seal', o.heads, { key: { equals: SEAL_KEY } }, ['key'], 1))[0] as { hash: string } | undefined
    if (prevSeal && sealHead?.hash !== prevSeal.digest) throw new Stop(String(prevSeal.id), 'the newest seal is missing or changed')
    // 4. Warnings, not breaks: entries waiting longer than an interval for a seal.
    const sealedTo = prevSeal?.upTo ?? null
    const overdue = new Date(now.getTime() - (o.sealEveryHours * 60 + o.sealGraceMinutes) * 60_000).toISOString()
    const waiting = await count('the entries waiting for a seal', { and: [...hashedWhere, { at: { less_than: overdue } }, ...(sealedTo ? [{ at: { greater_than: sealedTo } }] : [])] })
    if (waiting) warnings.push(`${waiting} entr${waiting === 1 ? 'y has' : 'ies have'} waited more than ${o.sealEveryHours} hours for a seal; run sealAuditTrail.`)
    return result(true, true)
  } catch (error) {
    if (error instanceof Stop) return result(false, error.finished, { id: error.id, reason: error.reason })
    throw error
  }
}

const valuesHashOf = (values: unknown) => valuesHash(values)
void canonical

// ------------------------------------------------------------------------------------------------
// The plugin

function chainCollections(o: Resolved): CollectionConfig[] {
  return [
    {
      slug: o.heads,
      admin: { hidden: true },
      access: { read: nobody, create: nobody, update: nobody, delete: nobody },
      fields: [
        { name: 'key', type: 'text', required: true, unique: true, index: true },
        { name: 'hash', type: 'text', required: true },
        { name: 'seq', type: 'number', required: true },
        { name: 'at', type: 'date' },
      ],
    },
    {
      slug: o.seals,
      admin: { hidden: true },
      access: { read: nobody, create: nobody, update: nobody, delete: nobody },
      fields: [
        { name: 'kind', type: 'select', required: true, options: ['seal', 'checkpoint', 'adoption'] },
        { name: 'seq', type: 'number', required: true, index: true },
        { name: 'prevDigest', type: 'text' },
        { name: 'digest', type: 'text', required: true },
        { name: 'fromAt', type: 'date' },
        { name: 'upTo', type: 'date', required: true, index: true },
        { name: 'count', type: 'number', required: true },
      ],
    },
  ]
}

function trailCollection(o: Resolved, opts: AuditTrailOptions): CollectionConfig {
  return {
    slug: o.slug,
    labels: { singular: 'Audit event', plural: 'Audit events' },
    admin: { group: opts.adminGroup, useAsTitle: 'action', defaultColumns: ['at', 'action', 'subjectCollection', 'subjectId', 'actor', 'origin'] },
    // Append-only: only the plugin writes, through the Local API.
    access: { read: opts.access?.read ?? nobody, create: nobody, update: nobody, delete: nobody },
    fields: [
      { name: 'at', type: 'date', required: true, index: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'action', type: 'select', required: true, index: true, options: o.actions.map((v) => ({ label: v, value: v })) },
      { name: 'subjectCollection', type: 'text', required: true, index: true },
      { name: 'subjectId', type: 'text', required: true, index: true },
      { name: 'actor', type: 'relationship', relationTo: o.users as never, index: true },
      {
        name: 'via',
        type: 'group',
        admin: { description: 'How the change was made beyond the signed-in account: switched in, by a guardian, while masquerading.' },
        fields: [
          { name: 'kind', type: 'text', index: true },
          { name: 'ref', type: 'text', admin: { description: 'The account (or record) it came through.' } },
          { name: 'label', type: 'text' },
        ],
      },
      { name: 'system', type: 'text', admin: { description: 'An automated actor (script or job) when there is no user.' } },
      { name: 'origin', type: 'select', required: true, options: o.origins.map((v) => ({ label: v, value: v })) },
      { name: 'changedFields', type: 'text', hasMany: true },
      { name: 'reason', type: 'textarea' },
      { name: 'values', type: 'json', access: { read: opts.access?.values ?? nobody, create: nobody, update: nobody }, admin: { description: 'Old and new values of the fields this site logs. Never personal details.' } },
      // The chain: this record's chain, its place in it, the previous entry's hash and this one's.
      { name: 'chainKey', type: 'text', index: true, admin: { readOnly: true, position: 'sidebar' } },
      { name: 'seq', type: 'number', index: true, admin: { readOnly: true, position: 'sidebar' } },
      { name: 'prevHash', type: 'text', admin: { readOnly: true, position: 'sidebar' } },
      { name: 'prevAt', type: 'date', admin: { hidden: true } },
      { name: 'hash', type: 'text', index: true, admin: { readOnly: true, position: 'sidebar' } },
      { name: 'valuesHash', type: 'text', admin: { hidden: true } },
      ...(opts.extraFields ?? []),
    ],
    // Verify reads each record's chain in order, a page at a time.
    indexes: [{ fields: ['chainKey', 'seq'] }],
    timestamps: false,
  }
}

type AnyField = Field & { name?: string; type: string; hidden?: boolean; access?: { read?: unknown }; custom?: Record<string, unknown>; relationTo?: string | string[]; fields?: Field[] }

/** Refuses at startup any value field that could hold a secret or a person's details. */
function checkValueFields(config: Config, o: Resolved, opts: AuditTrailOptions) {
  const personal = new Set(opts.personal ?? [])
  const allowPeople = new Set(opts.allowPeople ?? [])
  for (const [slug, names] of Object.entries(o.values)) {
    const collection = (config.collections ?? []).find((c) => c.slug === slug)
    if (!collection) throw new Error(`audit-trail: values names "${slug}", which isn't a collection.`)
    if (!o.collections.includes(slug)) throw new Error(`audit-trail: values names "${slug}", which isn't in \`collections\`.`)
    for (const name of names) {
      const field = (collection.fields as AnyField[]).find((f) => f.name === name)
      const refuse = (why: string): never => {
        throw new Error(`audit-trail: refusing to log values of ${slug}.${name}: ${why}.`)
      }
      // Sign-in fields first: Payload adds them (email included) after plugins run.
      if (AUTH_INTERNALS.includes(name) || (collection.auth && name === 'email')) refuse('it belongs to sign-in')
      if (!field) refuse('there is no such top-level field')
      if (field!.hidden || (field as { admin?: { hidden?: boolean } }).admin?.hidden) refuse('it is hidden')
      if (field!.access?.read) refuse('it has its own read access, so it may hold something not everyone may see')
      if (field!.custom?.secret || field!.custom?.encrypted) refuse('it is marked secret or encrypted')
      if (personal.has(name) || personal.has(`${slug}.${name}`)) refuse('it is listed as personal')
      const targets = ([] as string[]).concat((field!.relationTo as string | string[] | undefined) ?? [])
      if ((field!.type === 'relationship' || field!.type === 'upload') && targets.includes(o.users) && !allowPeople.has(`${slug}.${name}`))
        refuse(`it links to people (${o.users}); name it in allowPeople if that's intended`)
    }
  }
}

export const auditTrail =
  (opts: AuditTrailOptions): Plugin =>
  (config: Config): Config => {
    const o: Resolved = {
      slug: opts.slug ?? 'audit-events',
      users: opts.users ?? 'users',
      onWriteError: opts.onWriteError ?? 'fail',
      valueMaxBytes: opts.valueMaxBytes ?? 2048,
      collections: opts.collections,
      actions: [...new Set(['create', 'update', 'delete', ...(opts.actions ?? [])])],
      origins: [...(opts.origins ?? DEFAULT_ORIGINS)],
      ignore: new Set([...ALWAYS_IGNORED, ...(opts.ignore ?? [])]),
      values: opts.values ?? {},
      via: opts.via,
      extra: opts.extra,
      heads: `${opts.slug ?? 'audit-events'}-heads`,
      seals: `${opts.slug ?? 'audit-events'}-seals`,
      sealEveryHours: opts.sealEveryHours ?? 24,
      sealGraceMinutes: opts.sealGraceMinutes ?? 10,
      onSeal: opts.onSeal,
      extraNames: (opts.extraFields ?? []).flatMap((f) => ('name' in f && f.name ? [f.name] : [])),
    }
    const slugs = new Set((config.collections ?? []).map((c) => c.slug))
    for (const c of o.collections) if (!slugs.has(c)) throw new Error(`audit-trail: \`collections\` names "${c}", which isn't a collection.`)
    for (const own of [o.slug, o.heads, o.seals]) if (slugs.has(own)) throw new Error(`audit-trail: a collection "${own}" already exists.`)
    if (o.collections.includes(o.slug)) throw new Error('audit-trail: the trail can’t record itself.')
    checkValueFields(config, o, opts)

    const record = async (action: 'create' | 'update' | 'delete', slug: string, doc: Record<string, unknown>, previous: Record<string, unknown> | undefined, req: PayloadRequest, skip: Set<string>, digests?: Stored) => {
      const audit = contextOf(req)
      if (audit === false) return
      // A draft's autosave of this very record isn't recorded (publishing and saving are); keyed to the record, never the whole request.
      if (action === 'update' && skipped(req, 'auditTrailAutosave').has(`${slug}:${String(doc.id)}`)) return
      const fields = action === 'delete' ? [] : changed(doc, action === 'create' ? undefined : previous, skip, unreadableIn(req.payload, slug), digests)
      if (action === 'update' && fields.length === 0) return
      const restored = action === 'update' ? (skipped(req, 'auditTrailRestore') as Map<string, string>).get?.(`${slug}:${String(doc.id)}`) : undefined
      const { actor, via } = await who(o, req)
      const names = action === 'update' ? (o.values[slug] ?? []).filter((n) => fields.includes(n)) : []
      const values = names.length ? Object.fromEntries(names.map((n) => [n, { before: stored(previous?.[n], o.valueMaxBytes), after: stored(doc[n], o.valueMaxBytes) }])) : undefined
      await write(
        req.payload,
        o,
        {
          action,
          subject: { collection: slug, id: doc.id as string },
          actor,
          via,
          origin: audit.origin,
          system: audit.system ?? null,
          reason: restored ? `restored version ${restored}` : (audit.reason ?? null),
          fields,
          extra: { ...(o.extra ? await o.extra({ req, doc, collection: slug }) : {}), ...(audit.run ? { run: audit.run } : {}) },
          req,
        },
        values,
      )
    }

    const onInit = config.onInit
    return {
      ...config,
      collections: [
        ...(config.collections ?? []).map((collection): CollectionConfig => {
          if (!o.collections.includes(collection.slug)) return collection
          // Join fields list other documents; they aren't this record's data.
          // An auth collection's saved copy carries `collection`, which isn't a field (unless the site named one so).
          const ownCollectionField = (collection.fields as AnyField[]).some((f) => f.name === 'collection')
          const skip = new Set([...o.ignore, ...(collection.fields as AnyField[]).filter((f) => f.type === 'join').map((f) => String(f.name)), ...(collection.auth && !ownCollectionField ? ['collection'] : [])])
          // Fields whose stored values are compared: hidden or read-restricted ones, and the hash and salt for passwords.
          const watched = (payload: Payload) => [...[...unreadableIn(payload, collection.slug)].filter((k) => !skip.has(k) && !k.startsWith('_')), ...(collection.auth ? ['hash', 'salt'] : [])]
          const autosaves = Boolean(collection.versions && typeof collection.versions === 'object' && collection.versions.drafts && typeof collection.versions.drafts === 'object' && collection.versions.drafts.autosave)
          const beforeOperation: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
            const a = args as { autosave?: boolean; draft?: boolean; id?: string | number }
            // A password reset writes straight to the database, so no change hook sees it. Its account is found here
            // by its link, inside the reset's transaction, and afterLogin (still inside it) compares the stored hash.
            if (operation === 'resetPassword') {
              const token = (args as { data?: { token?: unknown } }).data?.token
              const found = typeof token === 'string' && token ? await storedDigests(req.payload, collection.slug, { resetPasswordToken: { equals: token } }, ['hash', 'salt'], req) : undefined
              if (found) resets.set(req, { id: String(found.id), before: found.digests })
              else resets.delete(req)
            }
            // A reset that failed never reached afterLogin: a sign-in of its own forgets that reset's reading.
            if (operation === 'login') resets.delete(req)
            if (operation === 'update' && a.id !== undefined) {
              const key = `${collection.slug}:${String(a.id)}`
              // Only a real draft autosave: the collection autosaves drafts, it's a draft, and it's this record.
              if (autosaves && a.draft === true && a.autosave === true) skipped(req, 'auditTrailAutosave').add(key)
              else skipped(req, 'auditTrailAutosave').delete(key)
            }
            if (operation === 'restoreVersion' && a.id !== undefined) {
              const version = (await req.payload.findVersionByID({ collection: collection.slug as never, id: String(a.id), depth: 0, overrideAccess: true, req }).catch(() => null)) as { parent?: unknown } | null
              const parent = version?.parent && typeof version.parent === 'object' ? (version.parent as { id: unknown }).id : version?.parent
              if (parent !== undefined && parent !== null) {
                (skipped(req, 'auditTrailRestore') as Map<string, string>).set(`${collection.slug}:${String(parent)}`, String(a.id))
                // Restoring hands beforeChange a copy of req, so what's stored before is read here, inside the transaction.
                const names = watched(req.payload)
                const before = names.length ? await storedDigests(req.payload, collection.slug, byId(parent), names, req) : undefined
                if (before) keepBefore(req, `${collection.slug}:${String(parent)}`, before.digests)
              }
            }
            return args
          }
          // What the database holds before the write, after any site hook ran, by digest: an update's hidden fields and hash.
          const beforeChange: CollectionBeforeChangeHook = async ({ data, operation, originalDoc, req }) => {
            const names = watched(req.payload)
            if (operation === 'update' && names.length && originalDoc?.id !== undefined && contextOf(req) !== false) {
              const before = await storedDigests(req.payload, collection.slug, byId(originalDoc.id), names, req)
              if (before) keepBefore(req, `${collection.slug}:${String(originalDoc.id)}`, before.digests)
            }
            return data
          }
          const afterChange: CollectionAfterChangeHook = async ({ doc, operation, previousDoc, req }) => {
            const names = watched(req.payload)
            let digests: Stored | undefined
            if (names.length && contextOf(req) !== false) {
              const before = operation === 'update' ? takeBefore(req, `${collection.slug}:${String(doc.id)}`) : undefined
              const after = (await storedDigests(req.payload, collection.slug, byId(doc.id), names, req))?.digests
              if (after && (operation === 'create' || before)) digests = { before, after }
              else {
                // Without both readings the saved copies can't show a new hash or a hidden field, so this isn't guessed.
                // As with an entry that can't be written (ADR 0001, decision 3): the change fails, unless the site chose 'log'.
                const error = new Error(`audit-trail: couldn't read what ${collection.slug} ${String(doc.id)} held ${after ? 'before the write' : 'after the write'}, so its hidden fields and password can't be compared.`)
                if (o.onWriteError !== 'log') throw error
                req.payload.logger.error({ msg: `audit-trail: ${collection.slug} ${String(doc.id)} was recorded from its saved copies only (onWriteError: log); a change to a hidden field or password may be missing.` })
              }
            }
            await record(operation, collection.slug, doc, previousDoc, req, skip, digests)
            return doc
          }
          const afterLogin: CollectionAfterLoginHook = async ({ req, user }) => {
            const reset = resets.get(req)
            if (!reset) return
            resets.delete(req)
            const id = (user as { id?: unknown }).id
            if (reset.id !== String(id)) return
            const after = (await storedDigests(req.payload, collection.slug, byId(id), ['hash', 'salt'], req))?.digests
            if (!after) return
            // The same copy on both sides, so only the password can be listed, and only if the stored hash moved. The account that held the link is the actor.
            const doc = user as unknown as Record<string, unknown>
            await record('update', collection.slug, doc, doc, req, skip, { before: reset.before, after })
          }
          const afterDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
            await record('delete', collection.slug, doc, undefined, req, skip)
            return doc
          }
          const afterOperation: CollectionAfterOperationHook = ({ args, operation, req, result }) => {
            const id = (args as { id?: string | number }).id
            if ((operation === 'update' || operation === 'updateByID') && id !== undefined) skipped(req, 'auditTrailAutosave').delete(`${collection.slug}:${String(id)}`)
            if (operation === 'restoreVersion') {
              const parent = (result as { id?: unknown } | undefined)?.id
              if (parent !== undefined) (skipped(req, 'auditTrailRestore') as Map<string, string>).delete(`${collection.slug}:${String(parent)}`)
            }
            return result
          }
          return {
            ...collection,
            hooks: {
              ...collection.hooks,
              beforeOperation: [...(collection.hooks?.beforeOperation ?? []), beforeOperation],
              beforeChange: [...(collection.hooks?.beforeChange ?? []), beforeChange],
              afterChange: [...(collection.hooks?.afterChange ?? []), afterChange],
              afterDelete: [...(collection.hooks?.afterDelete ?? []), afterDelete],
              afterOperation: [...(collection.hooks?.afterOperation ?? []), afterOperation],
              ...(collection.auth ? { afterLogin: [...(collection.hooks?.afterLogin ?? []), afterLogin] } : {}),
            },
          }
        }),
        trailCollection(o, opts),
        ...chainCollections(o),
      ],
      custom: { ...config.custom, auditTrail: o },
      onInit: async (payload) => {
        await onInit?.(payload)
        if (o.onWriteError === 'fail') await assertTransactions(payload, o)
        // Forget it when it stops, so an event never lands on a Payload that's gone.
        started.add(payload)
        const destroy = payload.destroy.bind(payload)
        payload.destroy = async () => {
          started.delete(payload)
          return destroy()
        }
      },
    }
  }

/** Failing closed needs transactions: without them, a failed entry can't undo the change. */
async function assertTransactions(payload: Payload, o: Resolved) {
  let id: string | number | null | undefined
  try {
    id = await payload.db.beginTransaction?.()
    if (id) await payload.find({ collection: o.slug as never, limit: 1, depth: 0, overrideAccess: true, req: { payload, transactionID: id } as never })
  } catch {
    id = null
  } finally {
    if (id) await payload.db.rollbackTransaction(id).catch(() => undefined)
  }
  if (!id)
    throw new Error(
      'audit-trail: this database has no transactions (no replica set, or transactions are off), so a failed entry can’t undo its change. Use a replica set, or set `onWriteError: \'log\'` to accept changes that may go unrecorded.',
    )
}
