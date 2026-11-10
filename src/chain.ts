import { createHash } from 'node:crypto'

import type { Payload, PayloadRequest } from 'payload'

/**
 * Tamper evidence (ADR 0001, decisions 10–15). Each entry carries the hash of the previous entry in its subject's
 * chain; a head document per subject holds the chain's last hash, moved by a conditional update. A seal chains every
 * entry across the site in time order, and `onSeal` copies its digest out of the database.
 */

export const SEAL_KEY = '__seal__'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Sorted keys, ISO dates, ids as strings; null and undefined dropped from objects (a missing value hashes as missing). */
export function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    // A populated relationship hashes as its id, the same as the id it was saved as.
    if ('id' in v && ('createdAt' in v || 'updatedAt' in v)) return String(v.id)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const c = canonical(v[k])
      if (c !== null) out[k] = c
    }
    // An object with nothing in it (a group read back as all nulls) is the same as no object.
    return Object.keys(out).length ? out : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

/** The parts of an entry the hash covers. `values` isn't one of them (it has its own `valuesHash`, so retention can clear it). */
export type ChainFields = {
  at: string
  action: string
  subjectCollection: string
  subjectId: string
  actor?: unknown
  via?: unknown
  system?: unknown
  origin: string
  changedFields?: string[]
  reason?: unknown
  chainKey: string
  seq: number
  prevHash?: string | null
  /** When the previous entry in this chain was written: a chain left starting mid-way after a prune must have lost only entries from before the cut. */
  prevAt?: string | null
  extra?: Record<string, unknown>
}

export function entryHash(e: ChainFields): string {
  const body = canonical({
    at: new Date(e.at).toISOString(),
    action: e.action,
    subjectCollection: e.subjectCollection,
    subjectId: String(e.subjectId),
    actor: e.actor === null || e.actor === undefined ? null : String(typeof e.actor === 'object' ? (e.actor as { id: unknown }).id : e.actor),
    via: e.via,
    system: e.system,
    origin: e.origin,
    changedFields: [...(e.changedFields ?? [])].sort(),
    reason: e.reason,
    chainKey: e.chainKey,
    seq: e.seq,
    prevAt: e.prevAt ? new Date(e.prevAt).toISOString() : null,
    extra: e.extra,
  })
  return sha(`${e.prevHash ?? ''}\n${JSON.stringify(body)}`)
}

export const valuesHash = (values: unknown) => sha(JSON.stringify(canonical(values)))

export const sealDigest = (prevDigest: string | null, hashes: string[], upTo: string, kind = 'seal') => sha(`${prevDigest ?? ''}\n${kind}\n${upTo}\n${hashes.join('\n')}`)

type HeadDoc = { id: string | number; key: string; hash: string; seq: number; at?: string | null }

export async function readHead(payload: Payload, headsSlug: string, key: string, req?: PayloadRequest): Promise<HeadDoc | null> {
  const { docs } = await payload.find({ collection: headsSlug as never, where: { key: { equals: key } }, limit: 1, depth: 0, overrideAccess: true, pagination: false, ...(req ? { req } : {}) })
  return (docs[0] as unknown as HeadDoc | undefined) ?? null
}

/**
 * Moves a head from `prev` to `next` only if nobody moved it meanwhile. Returns false when someone else got there
 * first (the caller reads the head again and retries); throws on a database error.
 */
export async function moveHead(payload: Payload, headsSlug: string, key: string, head: HeadDoc | null, next: { hash: string; seq: number; at: string }, req?: PayloadRequest): Promise<boolean> {
  if (!head) {
    try {
      await payload.db.create({ collection: headsSlug, data: { key, ...next }, ...(req ? { req } : {}) })
      return true
    } catch (error) {
      if (/duplicate key|E11000|unique/i.test(String((error as Error)?.message ?? error))) return false
      throw error
    }
  }
  const done = await payload.db.updateOne({ collection: headsSlug, where: { and: [{ id: { equals: head.id } }, { hash: { equals: head.hash } }] } as never, data: next, ...(req ? { req } : {}) })
  return Boolean(done)
}
