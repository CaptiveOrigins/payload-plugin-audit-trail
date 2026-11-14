import type { Payload } from 'payload'

import { entryHash, SEAL_KEY, sealDigest, valuesHash } from '../src/chain.js'

/**
 * The verify this plugin shipped before it streamed, kept as a reference: it reads the whole trail into
 * memory. The streaming verify must give the same answer on every trail these tests build. It is word for word
 * the old one except for two rules that changed for both: a seal whose predecessor is gone must be pinned by a
 * checkpoint (a second prune used to leave a false break), and a seal head with no seals is a break.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type LegacyResult = { ok: boolean; checked: number; firstBreak?: { id: string; reason: string }; warnings: string[] }
type Options = { slug: string; heads: string; seals: string; extraNames: string[]; sealEveryHours: number; sealGraceMinutes: number }
type Entry = Record<string, any> & { id: string | number; at: string; hash: string; prevHash?: string | null; seq: number; chainKey: string }
type Seal = { id: string | number; kind: 'seal' | 'checkpoint' | 'adoption'; seq: number; prevDigest?: string | null; digest: string; fromAt?: string | null; upTo: string; count: number; pins?: string[] | null }

const optionsOf = (payload: Payload) => payload.config.custom!.auditTrail as Options
const valuesHashOf = (values: unknown) => valuesHash(values)
const CHAIN_FIELDS = new Set(['id', 'chainKey', 'seq', 'prevHash', 'prevAt', 'hash', 'values'])
const adoptedHash = (e: Record<string, unknown>) => valuesHash(Object.fromEntries(Object.entries(e).filter(([k]) => !CHAIN_FIELDS.has(k))))
const allSorted = async (payload: Payload, slug: string, where: Record<string, unknown> = {}, sort: string[] = ['at', 'id']) =>
  (await payload.find({ collection: slug as never, where: where as never, sort, limit: 0, pagination: false, depth: 0, overrideAccess: true, showHiddenFields: true })).docs as unknown as Record<string, any>[]

export async function legacyVerify(payload: Payload, args: { since?: Date; now?: Date } = {}): Promise<LegacyResult> {
  const o = optionsOf(payload)
  const now = args.now ?? new Date()
  const warnings: string[] = []
  const fail = (id: unknown, reason: string, checked: number): LegacyResult => ({ ok: false, checked, firstBreak: { id: String(id), reason }, warnings })
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
    const start = !prevSeal && !s.prevDigest
    const pinned = seals.some((c) => c.kind === 'checkpoint' && c.seq >= s.seq && Boolean(s.prevDigest) && (c.pins ?? []).includes(s.prevDigest!))
    if (!start && !(prevSeal && s.prevDigest === prevSeal.digest) && !pinned) return fail(s.id, 'a seal doesn’t link to the seal before it', checked)
    if (s.kind === 'checkpoint') {
      if (sealDigest(s.prevDigest ?? null, s.pins ?? [], s.upTo, 'checkpoint') !== s.digest) return fail(s.id, 'a checkpoint was changed', checked)
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
  if (!prevSeal && sealHead) return fail(SEAL_KEY, 'every seal is missing, while the seal head is still here', checked)
  // 4. Warnings, not breaks: entries waiting longer than an interval for a seal.
  const sealedTo = prevSeal?.upTo ?? null
  const overdue = new Date(now.getTime() - (o.sealEveryHours * 60 + o.sealGraceMinutes) * 60_000).toISOString()
  const waiting = entries.filter((e) => e.at < overdue && (!sealedTo || e.at > sealedTo)).length
  if (waiting) warnings.push(`${waiting} entr${waiting === 1 ? 'y has' : 'ies have'} waited more than ${o.sealEveryHours} hours for a seal; run sealAuditTrail.`)
  return { ok: true, checked, warnings }
}

