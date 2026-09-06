// public/sw.js — offline-tuki: automaattinen välimuistitus käytön yhteydessä,
// jotta sovellus (ja PDF-vientikirjasto) toimii huonolla/olemattomalla
// kuuluvuudella työmaalla, kunhan sivu on ladattu kertaalleen netissä.

const CACHE_VERSION = 'v2'
const CACHE_NAME = `korpnex-tyoturvallisuus-${CACHE_VERSION}`

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

async function cacheFirst(req) {
  // Käytetään omalta origin-osoitteelta tuleville tiedostoille (JS/CSS/
  // kuvat/fontit). Vite-buildissa nämä ovat sisältöhajautettuja nimiä, joten
  // suora välimuistiluku on turvallista eikä koskaan tarjoile vanhentunutta
  // versiota väärällä nimellä.
  const cached = await caches.match(req)
  if (cached) return cached
  try {
    const res = await fetch(req)
    if (res.ok) { const cache = await caches.open(CACHE_NAME); cache.put(req, res.clone()) }
    return res
  } catch (e) {
    return cached || Response.error()
  }
}

async function networkFirst(req) {
  // HTML-sivulatauksille (jotta uusin deploy löytyy heti kun netti toimii)
  // ja Supabase-datalle (tuorein tieto ensisijainen, viimeksi ladattu toimii
  // varalla offline).
  try {
    const res = await fetch(req)
    if (res.ok) { const cache = await caches.open(CACHE_NAME); cache.put(req, res.clone()) }
    return res
  } catch (e) {
    const cached = await caches.match(req)
    if (cached) return cached
    throw e
  }
}

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return // ei välimuistiteta kirjoituksia

  const url = new URL(req.url)

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req))
    return
  }
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req))
    return
  }
  if (url.hostname.endsWith('.supabase.co')) {
    event.respondWith(networkFirst(req))
    return
  }
})
