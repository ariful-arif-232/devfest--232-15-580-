// Browser-only persistence of a project (requirements, matches, expiry dates and PDF bytes) in IndexedDB.
import { sha256Hex } from './pdf.js'

const DB = 'tender-package-builder'
const STORE = 'kv'
const KEY = 'project'

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'))
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run(mode, fn) {
  const db = await open()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const result = fn(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function saveProject(project, files) {
  await run('readwrite', (store) => {
    store.clear()
    store.put({ ...project, files: files.map(({ id, name, size, pages, hash }) => ({ id, name, size, pages, hash })), savedAt: new Date().toISOString() }, KEY)
    for (const f of files) store.put(f.bytes, `file:${f.id}`)
  })
}

export async function peekProject() {
  try {
    return (await run('readonly', (store) => store.get(KEY))) || null
  } catch {
    return null
  }
}

// Returns { project, files, missing } where missing lists saved files that could not be restored intact.
export async function loadProject() {
  const project = await run('readonly', (store) => store.get(KEY))
  if (!project) return null
  const files = []
  const missing = []
  for (const meta of project.files || []) {
    const bytes = await run('readonly', (store) => store.get(`file:${meta.id}`))
    if (!(bytes instanceof Uint8Array) || (await sha256Hex(bytes)) !== meta.hash) {
      missing.push(meta.name)
      continue
    }
    files.push({ ...meta, bytes })
  }
  return { project, files, missing }
}

export async function clearProject() {
  await run('readwrite', (store) => store.clear())
}
