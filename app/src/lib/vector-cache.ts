// Tiny IndexedDB wrapper caching per-session text embeddings across reloads —
// raw indexedDB API, zero deps. semantic-search.ts is the only caller.
const DB_NAME = 'piquette-timetable'
const DB_VERSION = 2
const STORE_NAME = 'session_vectors'

// Bump when the embedding shape changes (e.g. Chrome ships a new Semantic
// Embedder model with a different dimensionality) to invalidate every cached
// vector at once. textHash can't catch this on its own — the source text is
// unchanged, only what produces its embedding is.
const EMBEDDING_VERSION = 1

interface StoredVector {
  /** Row key (factory_id + repo + adw_id, see sessionKey) — adw_id alone collides across factories and repos. */
  key: string
  vector: Float32Array
  /** Checksum of the text the vector was computed from — see hashText(). */
  textHash: number
  /** EMBEDDING_VERSION at write time — a mismatch means "stale, recompute". */
  embeddingVersion: number
}

/** Validates the shape read back from IndexedDB — never trust it blindly,
 * since a record can predate a build that changed EMBEDDING_VERSION or the
 * record shape itself. */
function toStoredVector(result: unknown): StoredVector | null {
  const r = result as Partial<StoredVector> | undefined
  if (
    !r ||
    typeof r.key !== 'string' ||
    !(r.vector instanceof Float32Array) ||
    r.vector.length === 0 ||
    typeof r.textHash !== 'number' ||
    r.embeddingVersion !== EMBEDDING_VERSION
  ) {
    return null
  }
  return r as StoredVector
}

let dbPromise: Promise<IDBDatabase | null> | null = null

/** Opens (and upgrades) the database once per page load; resolves null if
 * IndexedDB isn't available or open fails, so callers just skip the cache. */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.addEventListener('upgradeneeded', () => {
        const db = req.result
        // v1 keyed records on adw_id; those can't be re-keyed and are cheap to recompute.
        if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME)
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      })
      req.addEventListener('success', () => resolve(req.result))
      req.addEventListener('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** Cached vector for a session row key, or null if nothing's cached (or the cache is unavailable). */
export async function getVector(key: string): Promise<StoredVector | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
      req.addEventListener('success', () => resolve(toStoredVector(req.result)))
      req.addEventListener('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

/** Caches a session's embedding. Float32Array is structured-clone-safe, so it's stored directly. */
export async function putVector(key: string, vector: Float32Array, textHash: number): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const record: StoredVector = { key, vector, textHash, embeddingVersion: EMBEDDING_VERSION }
      tx.objectStore(STORE_NAME).put(record)
      tx.addEventListener('complete', () => resolve())
      tx.addEventListener('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

/** Deletes any cached vector whose key isn't in the current sessions
 * response — keeps IndexedDB from growing forever as sessions get archived
 * or age out server-side. Best-effort, like every other op here. */
export async function pruneVectors(liveKeys: Set<string>): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.getAllKeys()
      req.addEventListener('success', () => {
        for (const key of req.result) {
          if (typeof key === 'string' && !liveKeys.has(key)) store.delete(key)
        }
      })
      tx.addEventListener('complete', () => resolve())
      tx.addEventListener('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

// Rolling-multiplier checksum, mod a large prime — good enough to notice "the
// source text changed, recompute the embedding", not a real hash function.
const HASH_PRIME = 1_000_000_007

export function hashText(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) % HASH_PRIME
  }
  return hash
}

export type { StoredVector }
