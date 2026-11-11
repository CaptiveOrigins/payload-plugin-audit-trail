import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
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

import { canonical, entryHash, moveHead, readHead, SEAL_KEY, sealDigest, valuesHash } from './chain.js'

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

const changed = (doc: Record<string, unknown>, previous: Record<string, unknown> | undefined, skip: Set<string>) =>
  [...new Set([...Object.keys(doc ?? {}), ...Object.keys(previous ?? {})])]
    .filter((k) => !skip.has(k) && !k.startsWith('_'))
    .filter((k) => !same(doc?.[k] ?? null, previous?.[k] ?? null))
    .sort()

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
        if (moved && !tx) {
          if (moved.head) await payload.db.updateOne({ collection: o.heads, where: { and: [{ key: { equals: chainKey } }, { hash: { equals: moved.hash } }] } as never, data: { hash: moved.head.hash, seq: moved.head.seq, at: moved.head.at ?? null } } as never).catch(() => undefined)
          else await payload.db.deleteMany({ collection: o.heads, where: { and: [{ key: { equals: chainKey } }, { hash: { equals: moved.hash } }] } as never }).catch(() => undefined)
        }
        throw error
      }
    } catch (error) {
      if (own) await payload.db.rollbackTransaction(own).catch(() => undefined)
      throw error
    }
  } catch (error) {
    if (o.onWriteError === 'log') {
      payload.logger.error({ err: error, msg: 'audit-trail: an entry was not written (onWriteError: log)' })
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

/**
 * Adapts another plugin's `onEvent` in one line. The mapper turns an event into an entry (or null to skip it on
 * purpose). If the mapper throws, or the entry's action isn't known, this throws too, so a security event that
 * can't be recorded fails the operation that raised it (when that plugin awaits `onEvent` inside its own
 * transaction, the operation is undone). `{ onError: 'log' }` is the explicit opt-out for events that are only informational.
 */
export function fromPluginEvent<E>(mapper: (event: E) => AuditEntry | null | Promise<AuditEntry | null>, opts: { onError?: 'fail' | 'log' } = {}) {
  return async (event: E) => {
    let p: Payload | undefined
    try {
      const entry = await mapper(event)
      if (!entry) return
      p = entry.req?.payload ?? entry.payload
      if (!p) throw new Error('audit-trail: an event entry needs `req` or `payload`.')
      await recordEvent(p, entry)
    } catch (error) {
      if (opts.onError === 'log') {
        const logger = p?.logger ?? (event as { req?: PayloadRequest; payload?: Payload })?.req?.payload?.logger ?? (event as { payload?: Payload })?.payload?.logger
        logger?.error({ err: error, msg: 'audit-trail: a plugin event was not recorded (onError: log)' })
        return
      }
      throw error
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

export type VerifyResult = { ok: boolean; checked: number; firstBreak?: { id: string; reason: string }; warnings: string[] }

/**
 * Recomputes every entry's hash and its link to the entry before it in its record's chain, checks each chain's head
 * against its newest entry, and recomputes every seal. Reports the first break; never guesses. `since` limits the
 * entries whose hashes are recomputed (links and heads are still checked).
 */
export async function verifyAuditTrail(payload: Payload, args: { since?: Date; now?: Date } = {}): Promise<VerifyResult> {
  const o = optionsOf(payload)
  const now = args.now ?? new Date()
  const warnings: string[] = []
  const fail = (id: unknown, reason: string, checked: number): VerifyResult => ({ ok: false, checked, firstBreak: { id: String(id), reason }, warnings })
  const all = (await allSorted(payload, o.slug, {}, ['chainKey', 'seq'])) as Entry[]
  const seals = (await allSorted(payload, o.seals, {}, ['seq'])) as unknown as Seal[]
  const checkpoint = [...seals].reverse().find((s) => s.kind === 'checkpoint') ?? null
  // Entries with no hash were written before chaining. They're allowed only inside the adoption seal's range.
  const adoption = seals.find((s) => s.kind === 'adoption') ?? null
  const entries = all.filter((e) => e.hash)
  const unhashed = all.filter((e) => !e.hash).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : String(a.id) < String(b.id) ? -1 : 1)) as Record<string, any>[]
  for (const e of unhashed) {
    if (e.values && (!e.valuesHash || valuesHashOf(e.values) !== e.valuesHash)) return fail(e.id, 'its logged values were changed', 0)
    if (!adoption) return fail(e.id, 'an entry has no hash and there is no adoption seal (it was written outside the plugin, or adoptExistingEntries hasn\u2019t run)', 0)
    if (new Date(e.at).toISOString() > adoption.upTo) return fail(e.id, 'an entry has no hash and was written after the adoption seal (something wrote around the plugin)', 0)
  }
  const since = args.since?.toISOString()
  let checked = 0
  // 1. Each record's chain: hashes, links, no gaps.
  const lastByChain = new Map<string, Entry>()
  for (const e of entries) {
    const prev = lastByChain.get(e.chainKey)
    if (!since || e.at >= since) {
      checked++
      const extra = Object.fromEntries(o.extraNames.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]))
      if (entryHash({ ...(e as unknown as Parameters<typeof entryHash>[0]), extra }) !== e.hash) return fail(e.id, 'the entry was changed after it was written', checked)
      if (e.values && e.valuesHash && valuesHashOf(e.values) !== e.valuesHash) return fail(e.id, 'its logged values were changed', checked)
    }
    if (prev) {
      if (e.seq !== prev.seq + 1) return fail(e.id, `an entry before it in ${e.chainKey} is missing`, checked)
      if (e.prevHash !== prev.hash) return fail(e.id, `it doesn't link to the entry before it in ${e.chainKey}`, checked)
    } else if (e.seq !== 1 && !(checkpoint && e.prevAt && new Date(e.prevAt).toISOString() <= checkpoint.upTo)) {
      // A chain may start mid-way only where a checkpoint recorded the cut, and only if what's gone was from before it.
      return fail(e.id, `the start of ${e.chainKey} is missing`, checked)
    } else if (e.seq === 1 && e.prevHash) return fail(e.id, 'a first entry links to something', checked)
    lastByChain.set(e.chainKey, e)
  }
  // 2. Heads: each chain's newest entry must be the one its head points to (an entry deleted after its last seal shows here).
  const heads = (await allSorted(payload, o.heads, { key: { not_equals: SEAL_KEY } }, ['key'])) as unknown as { key: string; hash: string; seq: number; at?: string }[]
  for (const h of heads) {
    const last = lastByChain.get(h.key)
    if (!last) {
      if (checkpoint && h.at && h.at < checkpoint.upTo) continue // the whole chain was pruned
      return fail(h.key, 'every entry of this chain is missing', checked)
    }
    if (last.hash !== h.hash || last.seq !== h.seq) return fail(last.id, `the newest entries of ${h.key} are missing or changed`, checked)
  }
  for (const key of lastByChain.keys()) if (!heads.some((h) => h.key === key)) return fail(key, 'this chain has no head (it was added outside the plugin)', checked)
  // 3. Seals: each digest from the entries in its range, each linked to the one before.
  let prevSeal: Seal | null = null
  for (const s of seals) {
    if (prevSeal && s.prevDigest !== prevSeal.digest) return fail(s.id, 'a seal doesn’t link to the seal before it', checked)
    if (s.kind === 'checkpoint') {
      if (sealDigest(s.prevDigest ?? null, [], s.upTo, 'checkpoint') !== s.digest) return fail(s.id, 'a checkpoint was changed', checked)
    } else if (s.kind === 'adoption') {
      // Once a checkpoint cut past the whole adoption, its entries are gone by design and only the link is checked.
      const prunedPast = checkpoint && checkpoint.upTo >= new Date(s.upTo).toISOString()
      if (prunedPast) {
        if (unhashed.length) return fail(unhashed[0]!.id, 'an adopted entry is still here after the cut that should have removed it', checked)
      } else if (unhashed.length !== s.count || sealDigest(s.prevDigest ?? null, unhashed.map(adoptedHash), new Date(s.upTo).toISOString(), 'adoption') !== s.digest)
        return fail(s.id, 'entries from before chaining were added, removed or changed since they were adopted', checked)
    } else {
      const inRange = entries.filter((e) => e.at <= s.upTo && (!s.fromAt || e.at > s.fromAt)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : String(a.id) < String(b.id) ? -1 : 1))
      if (inRange.length !== s.count || sealDigest(s.prevDigest ?? null, inRange.map((e) => e.hash), s.upTo) !== s.digest) return fail(s.id, 'entries in a sealed range were added, removed, reordered or changed', checked)
    }
    prevSeal = s
  }
  const sealHead = (await allSorted(payload, o.heads, { key: { equals: SEAL_KEY } }))[0] as { hash: string } | undefined
  if (prevSeal && sealHead?.hash !== prevSeal.digest) return fail(prevSeal.id, 'the newest seal is missing or changed', checked)
  // 4. Warnings, not breaks: entries waiting longer than an interval for a seal.
  const sealedTo = prevSeal?.upTo ?? null
  const overdue = new Date(now.getTime() - (o.sealEveryHours * 60 + o.sealGraceMinutes) * 60_000).toISOString()
  const waiting = entries.filter((e) => e.at < overdue && (!sealedTo || e.at > sealedTo)).length
  if (waiting) warnings.push(`${waiting} entr${waiting === 1 ? 'y has' : 'ies have'} waited more than ${o.sealEveryHours} hours for a seal; run sealAuditTrail.`)
  return { ok: true, checked, warnings }
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

    const record = async (action: 'create' | 'update' | 'delete', slug: string, doc: Record<string, unknown>, previous: Record<string, unknown> | undefined, req: PayloadRequest, skip: Set<string>) => {
      const audit = contextOf(req)
      if (audit === false) return
      // A draft's autosave of this very record isn't recorded (publishing and saving are); keyed to the record, never the whole request.
      if (action === 'update' && skipped(req, 'auditTrailAutosave').has(`${slug}:${String(doc.id)}`)) return
      const fields = action === 'delete' ? [] : changed(doc, action === 'create' ? undefined : previous, skip)
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
          const skip = new Set([...o.ignore, ...(collection.fields as AnyField[]).filter((f) => f.type === 'join').map((f) => String(f.name))])
          const autosaves = Boolean(collection.versions && typeof collection.versions === 'object' && collection.versions.drafts && typeof collection.versions.drafts === 'object' && collection.versions.drafts.autosave)
          const beforeOperation: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
            const a = args as { autosave?: boolean; draft?: boolean; id?: string | number }
            if (operation === 'update' && a.id !== undefined) {
              const key = `${collection.slug}:${String(a.id)}`
              // Only a real draft autosave: the collection autosaves drafts, it's a draft, and it's this record.
              if (autosaves && a.draft === true && a.autosave === true) skipped(req, 'auditTrailAutosave').add(key)
              else skipped(req, 'auditTrailAutosave').delete(key)
            }
            if (operation === 'restoreVersion' && a.id !== undefined) {
              const version = (await req.payload.findVersionByID({ collection: collection.slug as never, id: String(a.id), depth: 0, overrideAccess: true, req }).catch(() => null)) as { parent?: unknown } | null
              const parent = version?.parent && typeof version.parent === 'object' ? (version.parent as { id: unknown }).id : version?.parent
              if (parent !== undefined && parent !== null) (skipped(req, 'auditTrailRestore') as Map<string, string>).set(`${collection.slug}:${String(parent)}`, String(a.id))
            }
            return args
          }
          const afterChange: CollectionAfterChangeHook = async ({ doc, operation, previousDoc, req }) => {
            await record(operation, collection.slug, doc, previousDoc, req, skip)
            return doc
          }
          const afterDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
            await record('delete', collection.slug, doc, undefined, req, skip)
            return doc
          }
          const afterOperation: CollectionAfterOperationHook = ({ args, operation, req, result }) => {
            const id = (args as { id?: string | number }).id
            if (operation === 'update' && id !== undefined) skipped(req, 'auditTrailAutosave').delete(`${collection.slug}:${String(id)}`)
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
              afterChange: [...(collection.hooks?.afterChange ?? []), afterChange],
              afterDelete: [...(collection.hooks?.afterDelete ?? []), afterDelete],
              afterOperation: [...(collection.hooks?.afterOperation ?? []), afterOperation],
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
