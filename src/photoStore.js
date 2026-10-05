// src/photoStore.js — kenttäsovelluksen kuvat laitteen IndexedDB:hen.
//
// Aiemmin luonnoksen kuvat tallentuivat localStorageen, johon mahtuu vain
// ~5 Mt (n. 30–40 kuvaa). IndexedDB:hen mahtuu käytännössä satoja kuvia,
// joten pitkäkään kierros ilman verkkoa ei katkea. Luonnoksessa
// (localStorage) on jatkossa vain kuvan tunniste, itse kuva on täällä.
const DB_NAME = 'korpnex-tt-photos'
const STORE = 'photos'
let dbPromise = null

function open() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB ei käytössä')); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const st = t.objectStore(STORE)
    const r = fn(st)
    t.oncomplete = () => resolve(r?.result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

export const putPhoto = (id, dataUrl) => tx('readwrite', st => st.put(dataUrl, id)).catch(() => null)
export const getPhoto = id => tx('readonly', st => st.get(id)).catch(() => null)
export const delPhoto = id => tx('readwrite', st => st.delete(id)).catch(() => null)
