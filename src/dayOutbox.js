// src/dayOutbox.js — Työajat: "Päivä käynnissä" -kirjaukset toimivat ilman verkkoa.
//
// Jokainen napin painallus (Lähden kotoa, Saavuin, Tauko, Työt loppui, Vaihdan
// työmaata, Kotona, Määrät, Peru päivä) tallennetaan ensin puhelimeen jonoon
// (localStorage) ja lähetetään Supabaseen järjestyksessä. Jos yhteyttä ei ole,
// jono jää odottamaan ja lähtee automaattisesti, kun verkko palaa.
//
//   op = { table, action: 'insert', tmp, row }       → uusi rivi, tmp = väliaikainen id
//   op = { table, action: 'update', match, fields }  → match { sarake: arvo | [arvot] }
// Väliaikaiset id:t ('tmp-…') korvataan oikeilla, kun insert on mennyt läpi
// (myös myöhempien operaatioiden match- ja row-arvoissa, esim. ajon entry_id).
// Näkymä näyttää päivän heti: viimeksi haettu tila + jonossa olevat muutokset.
import { sb } from './supabaseClient.js'

const KEY = 'korpnex_tt_outbox_v1'
const MAP = 'korpnex_tt_outbox_ids_v1'
const LIVE = 'korpnex_tt_live_cache_v1'
const MAP_TTL = 3 * 24 * 3600 * 1000

const readJSON = (k, def) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : def } catch { return def } }
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true } catch { return false } }

export const tmpId = () => `tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
export const isTmp = v => typeof v === 'string' && v.startsWith('tmp-')

export const pendingOps = () => readJSON(KEY, [])
export const pendingCount = () => pendingOps().length
const writeOps = ops => writeJSON(KEY, ops)

function readMap() {
  const m = readJSON(MAP, {}), now = Date.now(), out = {}
  for (const [k, v] of Object.entries(m)) if (v && now - v.at < MAP_TTL) out[k] = v
  return out
}
function resolve(v, map) {
  if (isTmp(v)) return map[v]?.id ?? v
  if (Array.isArray(v)) return v.map(x => resolve(x, map))
  return v
}
const resolveObj = (o, map) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, resolve(v, map)]))
const hasTmp = o => Object.values(o || {}).some(v => isTmp(v) || (Array.isArray(v) && v.some(isTmp)))
// Väliaikainen id → oikea id (jos insert on jo mennyt läpi)
export const realId = id => resolve(id, readMap())

// Verkkovirhe tai vanhentunut kirjautuminen → yritetään myöhemmin uudelleen.
// Muut (esim. puuttuva sarake) ovat oikeita virheitä, joita uudelleenyritys ei korjaa.
export function isRetryable(err) {
  if (!err) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const msg = String(err.message || err)
  if (/fetch|network|load failed|timeout|aborted|JWT/i.test(msg)) return true
  if (err.code === 'PGRST301' || err.code === 'PGRST302') return true
  return !err.code
}

let flushing = null
// Lähettää jonon järjestyksessä. Palauttaa { pending, fatal?, fatalBatch? }.
export function flushOutbox() {
  if (flushing) return flushing
  flushing = (async () => {
    let fatal = null, fatalBatch = null
    for (let guard = 0; guard < 500; guard++) {
      const ops = pendingOps()
      if (!ops.length) break
      const op = ops[0]
      const map = readMap()
      let error = null, data = null
      try {
        if (op.action === 'insert') {
          const row = resolveObj(op.row, map)
          if (hasTmp(row)) error = { message: 'riippuvuus puuttuu', code: 'LOCAL' }
          else ({ data, error } = await sb.from(op.table).insert([row]).select('id'))
        } else {
          const match = resolveObj(op.match, map), fields = resolveObj(op.fields, map)
          if (hasTmp(match) || hasTmp(fields)) error = { message: 'riippuvuus puuttuu', code: 'LOCAL' }
          else {
            let q = sb.from(op.table).update(fields)
            for (const [k, v] of Object.entries(match)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v)
            ;({ error } = await q)
          }
        }
      } catch (e) { error = e }

      if (error && isRetryable(error)) break // ei yhteyttä → odotetaan
      if (error) {
        // Oikea virhe: pudotetaan tämä ja saman painalluksen loput (ne riippuvat tästä)
        console.error('outbox op failed, dropped:', op, error)
        fatal = error; fatalBatch = op.batch
        writeOps(pendingOps().filter(o => o.batch !== op.batch))
        continue
      }
      if (op.action === 'insert' && data?.[0]?.id != null) {
        const m = readMap(); m[op.tmp] = { id: data[0].id, at: Date.now() }; writeJSON(MAP, m)
      }
      writeOps(pendingOps().filter(o => o.uid !== op.uid))
    }
    return { pending: pendingCount(), fatal, fatalBatch }
  })().finally(() => { flushing = null })
  return flushing
}

// Yhden napinpainalluksen muutokset: jonoon ja heti lähetykseen.
// Palauttaa { queued: true } jos jäi odottamaan yhteyttä, { error } jos tietokanta hylkäsi.
export async function exec(ops) {
  const batch = tmpId()
  const stamped = ops.map(o => ({ ...o, uid: tmpId(), batch, at: Date.now() }))
  if (!writeOps([...pendingOps(), ...stamped])) {
    // Puhelimen tallennustila ei käytössä (yksityinen selaus) → suoraan kantaan
    const local = {}
    for (const o of stamped) {
      const r = o.action === 'insert'
        ? await sb.from(o.table).insert([resolveObj(o.row, local)]).select('id')
        : await Object.entries(resolveObj(o.match, local)).reduce((q, [k, v]) => (Array.isArray(v) ? q.in(k, v) : q.eq(k, v)), sb.from(o.table).update(resolveObj(o.fields, local)))
      if (r.error) return { error: r.error }
      if (o.action === 'insert' && r.data?.[0]) local[o.tmp] = { id: r.data[0].id }
    }
    return { queued: false }
  }
  const r = await flushOutbox()
  if (r.fatal && r.fatalBatch === batch) return { error: r.fatal }
  return { queued: pendingOps().some(o => o.batch === batch) }
}

// Viimeksi haettu käynnissä oleva päivä (varalle, jos haku ei onnistu)
export const saveLiveCache = live => writeJSON(LIVE, live)
export const loadLiveCache = () => readJSON(LIVE, { entries: [], trips: [] })

// Haettu tila + jonossa olevat muutokset = mitä näytetään
export function applyPending(live, ops = pendingOps()) {
  const map = readMap()
  const entries = (live.entries || []).map(e => ({ ...e }))
  const trips = (live.trips || []).map(t => ({ ...t }))
  const matches = (x, match) => Object.entries(resolveObj(match, map)).every(([k, v]) => (Array.isArray(v) ? v.includes(x[k]) : x[k] === v))
  for (const op of ops) {
    const list = op.table === 'work_entries' ? entries : op.table === 'wl_trips' ? trips : null
    if (!list) continue
    if (op.action === 'insert') {
      const id = resolve(op.tmp, map)
      if (!list.some(x => x.id === id)) list.push({ archived: false, ...resolveObj(op.row, map), id, _pending: true })
    } else {
      for (const x of list) if (matches(x, op.match)) Object.assign(x, resolveObj(op.fields, map), { _pending: true })
    }
  }
  return {
    entries: entries.filter(e => !e.archived && e.status === 'kaynnissa'),
    trips: trips.filter(t => !t.archived),
  }
}
