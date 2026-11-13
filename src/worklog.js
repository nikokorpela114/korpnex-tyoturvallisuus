// src/worklog.js — Työajat-osion laskenta (puhdas logiikka, ei Reactia).
//
// Laskutus asiakkaalle:
//   tuntityö / konsultointi  tunnit × €/h
//   urakka                   määrä × (TES-hinta × kerroin), yksikköhinta
//                            pyöristetään senteille kuten laskulla
//   materiaalit              EI laskuteta: tilaajan omat tuotteet, joiden kulutus
//                            näytetään laskulla tiedoksi (tilaaja laskuttaa ne eteenpäin)
//   matkat                   km × €/km (jos laskutetaan) + matka-aika × €/h
//   päivärahat               vain jos laskutus on sovittu asiakkaan kanssa (per_diem_billable)
//
// ALV: tuntityö ja urakka ovat rakentamispalvelua → käännetty verovelvollisuus
// (alv 0, AVL 8 c §). Konsultointi ei ole rakentamispalvelua → alv 25,5 %.
//
// Oma matkalasku (Korpnex maksaa konsultille verovapaasti): kaikki omalla
// autolla ajetut km × verovapaa km-korvaus + päivärahat.

export const DEFAULT_SETTINGS = {
  hourlyRate: 30,      // €/h alv 0
  consultRate: 65,     // €/h alv 0, konsultointi
  multiplier: 1.75,    // urakka: TES-hinta × kerroin
  kmRate: 0.55,        // €/km asiakkaalle
  ownKmRate: 0.55,     // verovapaa km-korvaus 2026
  pdPart: 25,          // osapäiväraha 2026 (yli 6 h)
  pdFull: 54,          // kokopäiväraha 2026 (yli 10 h)
  vatPct: 25.5,
  // UKKO-matkalaskupohjaa varten (tekstiä)
  invoiceTitle: 'Kiireapu', // UKKO-laskun otsikon alku: "Kiireapu Kauhajoki 3.11 & 6.11.2026"
  travelName: '',
  homeAddress: '',
  vehicle: '',
}

const SETTINGS_KEY = 'korpnex_tt_worklog_settings_v1'

// --- Verovapaat korvaukset vuosittain ----------------------------------------
// Jokainen päivä ja ajo lasketaan OMAN vuotensa määrillä, joten vanhat
// matkalaskut ja laskutetut päivärahat eivät muutu, kun uuden vuoden määrät
// lisätään. Verohallinnon päätös julkaistaan joulukuussa; lisää uusi vuosi
// Asetuksiin. Puuttuva vuosi käyttää edellisen tunnetun vuoden määriä.
export const OFFICIAL_RATES = {
  2026: { ownKmRate: 0.55, pdPart: 25, pdFull: 54 },
}
export const RATE_KEYS = ['ownKmRate', 'pdPart', 'pdFull']
export function rateTable(settings) {
  return { ...OFFICIAL_RATES, ...(settings?.yearRates || {}) }
}
export function yearRates(settings, date) {
  const y = String(date || '').slice(0, 4) || String(new Date().getFullYear())
  const table = rateTable(settings)
  if (table[y]) return { year: y, from: y, fallback: false, ...table[y] }
  const years = Object.keys(table).sort()
  const from = years.filter(k => k <= y).pop() || years[0]
  return { year: y, from, fallback: true, ...table[from] }
}
// Asetukset, joissa korvaukset ovat päivän vuoden mukaiset
export function ratesFor(settings, date) {
  const r = yearRates(settings, date)
  return { ...settings, ownKmRate: num(r.ownKmRate), pdPart: num(r.pdPart), pdFull: num(r.pdFull) }
}

function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) }
  // Vanhat asetukset (yksi määrä kaikille vuosille) → vuoden 2026 määriksi
  if (!s.yearRates) {
    s.yearRates = { 2026: Object.fromEntries(RATE_KEYS.map(k => [k, num(raw?.[k] ?? OFFICIAL_RATES[2026][k])])) }
  }
  return s
}
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return normalizeSettings(raw ? JSON.parse(raw) : null)
  } catch { return normalizeSettings(null) }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* ei väliä */ }
}
// Tietokannasta (wl_settings) tulleet asetukset; puhelin ja kone käyttävät samoja
export function mergeDbSettings(data) { return normalizeSettings(data) }

export const KIND_LABELS = { tunti: 'Tuntityö', urakka: 'Urakka', konsultointi: 'Konsultointi' }
export const PER_DIEM_LABELS = { ei: 'Ei päivärahaa', osa: 'Osapäiväraha', koko: 'Kokopäiväraha' }
export const UNITS = ['jm', 'm', 'm²', 'kpl', 'h']

// Saumaustyöt-nimikkeet ja TES-hinnat 2026 (samat kuin Zaumaxin Urakka-sovelluksen hinnastossa).
// Valinta täyttää työlajin, yksikön ja TES-hinnan; hintaa voi muuttaa rivillä.
export const TES_NIMIKKEET = [
  ['Elementti- ja ikkunasauma', [
    ['Elementti- ja ikkunasauma 0…20 mm', 'jm', 1.61], ['Elementti- ja ikkunasauma 21…30 mm', 'jm', 2.07],
    ['Elementti- ja ikkunasauma 31…40 mm', 'jm', 2.61], ['Elementti- ja ikkunasauma 41…50 mm', 'jm', 3.01],
    ['Elementti- ja ikkunasauma yli 50 mm', 'jm', 3.61],
  ]],
  ['Ikkunasauma', [['Ikkunasauma 0…15 mm', 'jm', 1.67], ['Ikkunasauma 16…25 mm', 'jm', 1.80], ['Ikkunasauma 26…35 mm', 'jm', 3.01]]],
  ['Graniitin saumaus', [['Graniitin saumaus 0…15 mm', 'jm', 1.88]]],
  // 0…5 ja 6…10 mm kirjataan erikseen (viestiin), laskulle ne yhdistyvät TES-nimikkeeksi 0…10 mm
  ['Silikonisaumaus', [
    ['Silikonisaumaus 0…5 mm', 'jm', 1.07, 'Silikonisaumaus 0…10 mm'], ['Silikonisaumaus 6…10 mm', 'jm', 1.07, 'Silikonisaumaus 0…10 mm'],
    ['Silikonisaumaus 0…10 mm', 'jm', 1.07], ['Silikonisaumaus 11…15 mm', 'jm', 1.21],
  ]],
  ['Akryylisaumaus', [['Akryylisaumaus 0…10 mm', 'jm', 1.00], ['Akryylisaumaus 11…15 mm', 'jm', 1.13]]],
  ['Vaahdotus', [['Vaahdotus 0…20 mm', 'jm', 0.94], ['Vaahdotus, leikattuna yli 20 mm', 'jm', 1.13]]],
  ['Läpimenot', [
    ['Läpimeno, kevyet väliseinät 0…100 mm', 'kpl', 0.60], ['Läpimeno, kevyet väliseinät 100…300 mm', 'kpl', 0.80],
    ['Läpimeno, kevyet väliseinät 300…500 mm', 'kpl', 1.00], ['Läpimeno, tiiliseinät 0…100 mm', 'kpl', 0.87],
    ['Läpimeno, tiiliseinät 100…300 mm', 'kpl', 1.13], ['Läpimeno, tiiliseinät 300…500 mm', 'kpl', 2.55],
  ]],
  ['Uusintasaumaus', [['Uusintasaumaus, elementit', 'jm', 3.61]]],
]
export const findNimike = name => {
  for (const [, items] of TES_NIMIKKEET) for (const it of items) if (it[0] === name) return { label: it[0], unit: it[1], tes: it[2], invoiceAs: it[3] || it[0] }
  return null
}
// Laskulla käytettävä nimike (tarkemmat leveydet yhdistyvät TES-nimikkeeseen)
export const invoiceName = name => findNimike(name)?.invoiceAs || (name || '').trim()
export const MATERIAL_UNITS = ['kpl', 'm', 'jm', 'l', 'dl', 'rll', 'pkt', 'm²', 'kg']


// Senttipyöristys, joka ei kompastu liukulukuihin (0,94 × 1,75 = 1,645 → 1,65)
export function round2(n) {
  const x = Number(n) || 0
  return Math.round(parseFloat((x * 100).toFixed(6))) / 100
}
export const num = v => {
  if (typeof v === 'number') return isFinite(v) ? v : 0
  const x = parseFloat(String(v ?? '').replace(',', '.').replace(/\s/g, ''))
  return isFinite(x) ? x : 0
}

// Urakkarivi: TES-hinta × kerroin. Tuntirivi (hourly, esim. siivous urakan ohessa): €/h sellaisenaan.
export function unitPrice(line, multiplier) {
  if (line.hourly) return round2(num(line.tes))
  return round2(num(line.tes) * num(multiplier))
}

// Konsultointi ei ole rakentamispalvelua → aina alv. Muuten asiakkaan ALV-käsittely
// (vat_mode 'alv' = asiakas ei myy rakentamispalveluja, esim. kuluttaja tai muu yritys).
export function vatClass(e) {
  return e.kind === 'konsultointi' || e.vat_mode === 'alv' ? 'alv' : 'kaannetty'
}

// --- Kellonajat ---------------------------------------------------------------
export const VAT_MODE_LABELS = {
  kaannetty: 'Käännetty ALV (rakentamispalvelu, alv 0 %)',
  alv: 'Normaali ALV 25,5 %',
}
export function timeToMin(t) {
  if (!t) return null
  const m = /^(\d{1,2})[:.](\d{2})/.exec(String(t))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
export const fmtTime = t => (t ? String(t).slice(0, 5).replace(':', '.') : '')
export function fmtDuration(min) {
  const h = Math.floor(min / 60), m = min % 60
  return m ? `${h} h ${m} min` : `${h} h`
}
// Työaika = loppu − alku − tauko, pyöristettynä lähimpään 15 minuuttiin.
// Yön yli menevä vuoro (loppu < alku) lasketaan seuraavalle päivälle.
export function calcHours(start, end, breakMin = 0) {
  const a = timeToMin(start), b = timeToMin(end)
  if (a === null || b === null) return null
  let raw = b - a
  if (raw <= 0) raw += 24 * 60
  raw -= Number(breakMin) || 0
  if (raw <= 0) return null
  const rounded = Math.round(raw / 15) * 15
  return { raw, rounded, hours: rounded / 60 }
}
// Päivärahaehdotus kodista kotiin -keston mukaan. Edellyttää yli 15 km
// yhteen suuntaan (meno-paluu yli 30 km). Etäisyys tulee omasta km-kirjauksesta
// tai, jos kuljit toisen kyydillä (km = 0), työmaan km-tiedosta. Jos etäisyyttä
// ei tiedetä lainkaan, ehdotus tehdään keston perusteella ja muistutetaan siitä.
export function suggestPerDiem(depart, ret, distanceRoundTrip) {
  const a = timeToMin(depart), b = timeToMin(ret)
  if (a === null || b === null) return null
  let dur = b - a
  if (dur <= 0) dur += 24 * 60
  const dist = num(distanceRoundTrip)
  if (dist > 0 && dist <= 30) return { dur, value: 'ei', reason: 'matka alle 15 km suuntaansa' }
  const note = dist > 0 ? '' : ', tarkista että matka on yli 15 km suuntaansa'
  if (dur > 600) return { dur, value: 'koko', reason: `yli 10 h${note}` }
  if (dur > 360) return { dur, value: 'osa', reason: `yli 6 h${note}` }
  return { dur, value: 'ei', reason: 'alle 6 h' }
}

export function entryTotals(e, settings = DEFAULT_SETTINGS) {
  let work = 0
  if (e.kind === 'urakka') {
    for (const l of e.lines || []) work += round2(num(l.maara) * unitPrice(l, e.multiplier))
  } else {
    work = round2(num(e.hours) * num(e.hourly_rate))
  }
  const kmBill = e.km_billable ? round2(num(e.km) * num(e.km_rate)) : 0
  const travelTime = round2(num(e.travel_hours) * num(e.travel_rate))
  const r = yearRates(settings, e.work_date)
  const perDiem = e.per_diem === 'koko' ? num(r.pdFull) : e.per_diem === 'osa' ? num(r.pdPart) : 0
  const ownKm = round2(num(e.km) * num(r.ownKmRate))
  const perDiemBill = e.per_diem_billable ? perDiem : 0
  return {
    work: round2(work),
    travel: round2(kmBill + travelTime + perDiemBill),
    total: round2(work + kmBill + travelTime + perDiemBill),
    perDiem,
    perDiemBill,
    ownKm,
  }
}

export function monthKey(d) {
  const x = typeof d === 'string' ? new Date(d + 'T12:00:00') : d
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`
}
export function monthRange(key) {
  const [y, m] = key.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` }
}
export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number)
  return monthKey(new Date(y, m - 1 + delta, 15))
}
export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number)
  const s = new Date(y, m - 1, 15).toLocaleDateString('fi-FI', { month: 'long', year: 'numeric' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// --- Jaksot: viikko / kuukausi / vuosi ----------------------------------------
const pad2 = n => String(n).padStart(2, '0')
export const toISODate = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const parseISO = s => new Date(String(s).slice(0, 10) + 'T12:00:00')
export function addDays(dateStr, n) {
  const d = parseISO(dateStr); d.setDate(d.getDate() + n); return toISODate(d)
}
// Viikon maanantai
export function weekStart(dateStr) {
  const d = parseISO(dateStr)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return toISODate(d)
}
// ISO 8601 -viikkonumero (viikko, jolla on vuoden ensimmäinen torstai = vk 1)
export function isoWeek(dateStr) {
  const d = parseISO(dateStr)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)) // saman viikon torstai
  const jan4 = new Date(d.getFullYear(), 0, 4, 12)
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7)
  return { year: d.getFullYear(), week }
}
export const PERIOD_LABELS = { week: 'Viikko', month: 'Kuukausi', year: 'Vuosi' }
export function periodRange(mode, anchor) {
  if (mode === 'week') { const from = weekStart(anchor); return { from, to: addDays(from, 6) } }
  if (mode === 'year') { const y = String(anchor).slice(0, 4); return { from: `${y}-01-01`, to: `${y}-12-31` } }
  return monthRange(monthKey(anchor))
}
export function shiftPeriod(mode, anchor, delta) {
  if (mode === 'week') return addDays(weekStart(anchor), 7 * delta)
  if (mode === 'year') return `${Number(String(anchor).slice(0, 4)) + delta}-01-15`
  return `${shiftMonth(monthKey(anchor), delta)}-15`
}
const shortDate = s => { const d = parseISO(s); return `${d.getDate()}.${d.getMonth() + 1}.` }
export function periodLabel(mode, anchor) {
  if (mode === 'week') {
    const { from, to } = periodRange('week', anchor)
    return `Viikko ${isoWeek(from).week} · ${shortDate(from)}–${shortDate(to)}${to.slice(0, 4)}`
  }
  if (mode === 'year') return String(anchor).slice(0, 4)
  return monthLabel(monthKey(anchor))
}
// Tiedostonimiin ja Excelin otsikoihin
export function periodKey(mode, anchor) {
  if (mode === 'week') { const w = isoWeek(weekStart(anchor)); return `${w.year}-vk${pad2(w.week)}` }
  if (mode === 'year') return String(anchor).slice(0, 4)
  return monthKey(anchor)
}

// --- Tunnit ja laskutustila ---------------------------------------------------
// Työtunnit: tunti/konsultointi kirjatut tunnit, urakassa kellonajoista (tiedoksi)
export function workHours(e) {
  if (e.kind !== 'urakka') return num(e.hours)
  const c = calcHours(e.start_time, e.end_time, e.break_minutes)
  return c ? c.hours : 0
}
export const isBillable = e => e.billing !== 'ei'
export const billingState = e => (e.billing === 'ei' ? 'ei' : e.invoiced_at ? 'laskutettu' : 'laskuttamatta')
export const BILLING_LABELS = { laskuttamatta: 'Laskuttamatta', laskutettu: 'Laskutettu', ei: 'Ei laskuteta' }

const spanMin = (a, b) => { const x = timeToMin(a), y = timeToMin(b); if (x === null || y === null) return null; let d = y - x; if (d <= 0) d += 1440; return d }
// Matka-aika päivittäin: (paluu kotiin − lähtö kotoa) − työmailla vietetty aika.
// Vain tiedoksi, matka-aikaa ei laskuteta.
export function dayTravel(entries) {
  const byDate = new Map()
  for (const e of entries) {
    if (!byDate.has(e.work_date)) byDate.set(e.work_date, [])
    byDate.get(e.work_date).push(e)
  }
  const out = new Map()
  for (const [date, list] of byDate) {
    const deps = list.map(e => timeToMin(e.depart_time)).filter(x => x !== null)
    const rets = list.map(e => timeToMin(e.return_time)).filter(x => x !== null)
    if (!deps.length || !rets.length) continue
    const dep = Math.min(...deps), ret = Math.max(...rets)
    let away = ret - dep
    if (away <= 0) away += 1440
    const onSite = list.reduce((s, e) => s + (spanMin(e.start_time, e.end_time) || 0), 0)
    out.set(date, { away, travel: Math.max(0, away - onSite) })
  }
  return out
}

// Jakson yhteenveto: palkit (viikko → päivät, kuukausi → viikot, vuosi → kuukaudet),
// kokonaissummat ja asiakkaittainen jako.
export function summarizePeriod(entries, settings, mode, anchor) {
  const { from, to } = periodRange(mode, anchor)
  const buckets = []
  if (mode === 'week') {
    for (let i = 0; i < 7; i++) {
      const d = addDays(from, i)
      buckets.push({ key: d, label: parseISO(d).toLocaleDateString('fi-FI', { weekday: 'short' }), sub: shortDate(d), match: e => e.work_date === d })
    }
  } else if (mode === 'month') {
    for (let w = weekStart(from); w <= to; w = addDays(w, 7)) {
      const end = addDays(w, 6)
      buckets.push({ key: w, label: `Vk ${isoWeek(w).week}`, sub: `${shortDate(w < from ? from : w)}–${shortDate(end > to ? to : end)}`, anchor: w, match: e => e.work_date >= w && e.work_date <= end })
    }
  } else {
    const y = from.slice(0, 4)
    for (let m = 1; m <= 12; m++) {
      const k = `${y}-${pad2(m)}`
      buckets.push({ key: k, label: new Date(Number(y), m - 1, 15).toLocaleDateString('fi-FI', { month: 'short' }).replace('.', ''), sub: '', anchor: `${k}-15`, match: e => e.work_date.slice(0, 7) === k })
    }
  }
  const travel = dayTravel(entries)
  const sumOf = list => {
    const dates = new Set(list.map(e => e.work_date))
    let travelMin = 0
    for (const d of dates) travelMin += travel.get(d)?.travel || 0
    const bill = list.filter(isBillable)
    return {
      hours: round2(list.reduce((s, e) => s + workHours(e), 0)),
      travelH: round2(travelMin / 60),
      km: round2(list.reduce((s, e) => s + num(e.km), 0)),
      days: dates.size,
      eur: round2(bill.reduce((s, e) => s + entryTotals(e, settings).total, 0)),
      unbilled: round2(bill.filter(e => !e.invoiced_at).reduce((s, e) => s + entryTotals(e, settings).total, 0)),
      billed: round2(bill.filter(e => e.invoiced_at).reduce((s, e) => s + entryTotals(e, settings).total, 0)),
    }
  }
  const rows = buckets.map(b => ({ ...b, ...sumOf(entries.filter(b.match)), match: undefined }))
  const clients = new Map()
  for (const e of entries) {
    if (!clients.has(e.client_name)) clients.set(e.client_name, [])
    clients.get(e.client_name).push(e)
  }
  const byClient = [...clients.entries()].map(([name, list]) => ({ name, ...sumOf(list) }))
    .sort((a, b) => b.hours - a.hours || b.eur - a.eur)
  return { rows, total: sumOf(entries), byClient }
}

// Päivän kilometrien jako työmaille. legs: [{ known: km | null, weight }].
// Tunnetut (mittarilukemista lasketut) pidetään, loput jaetaan painojen suhteessa
// (työmaan km-tieto, tai tasan). Pyöristys kokonaisiin km, summa täsmää.
export function allocateDayKm(legs, totalKm) {
  const total = Math.max(0, Math.round(num(totalKm)))
  const out = legs.map(l => (l.known != null ? Math.max(0, Math.round(num(l.known))) : null))
  const knownSum = out.reduce((s, x) => s + (x || 0), 0)
  const open = legs.map((l, i) => i).filter(i => out[i] === null)
  if (!open.length) return out
  const rest = Math.max(0, total - knownSum)
  const w = open.map(i => (num(legs[i].weight) > 0 ? num(legs[i].weight) : 1))
  const wSum = w.reduce((s, x) => s + x, 0)
  let given = 0
  open.forEach((i, j) => {
    const v = j === open.length - 1 ? rest - given : Math.round(rest * w[j] / wSum)
    out[i] = Math.max(0, v); given += out[i]
  })
  return out
}

export const fmtEur = n => (Number(n) || 0).toLocaleString('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
export const fmtNum = (n, max = 2) => (Number(n) || 0).toLocaleString('fi-FI', { maximumFractionDigits: max })
export const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('fi-FI')

function periodText(entries) {
  const ds = entries.map(e => e.work_date).sort()
  if (!ds.length) return ''
  return ds[0] === ds[ds.length - 1] ? fmtDate(ds[0]) : `${fmtDate(ds[0])}–${fmtDate(ds[ds.length - 1])}`
}

// Kokoaa yhden asiakkaan merkinnät laskuriveiksi. Samanlaiset rivit
// yhdistetään (sama työmaa + sama hinta), jotta lasku pysyy lyhyenä.
export function buildInvoice(entries, settings = DEFAULT_SETTINGS) {
  const groups = { kaannetty: new Map(), alv: new Map() }
  const add = (cls, key, base) => {
    const m = groups[cls]
    const cur = m.get(key) || { ...base, qty: 0, entries: [] }
    cur.qty = round2(cur.qty + base.addQty)
    m.set(key, cur)
    return cur
  }
  for (const e of entries) {
    const cls = vatClass(e)
    const site = (e.site || '').trim()
    const where = site ? `, ${site}` : ''
    if (e.kind === 'urakka') {
      for (const l of e.lines || []) {
        const price = unitPrice(l, e.multiplier)
        const q = num(l.maara)
        if (!q || !price) continue
        const name = invoiceName(l.tyolaji) || 'Urakkatyö'
        add(cls, `u|${name}|${l.yksikko}|${price}|${site}`, { desc: `${name}${where}`, unit: l.yksikko || 'kpl', price, addQty: q }).entries.push(e)
      }
    } else if (num(e.hours) && num(e.hourly_rate)) {
      const label = e.kind === 'konsultointi' ? 'Työturvallisuuskonsultointi' : 'Tuntityö'
      add(cls, `h|${e.kind}|${num(e.hourly_rate)}|${site}`, { desc: `${label}${where}`, unit: 'h', price: num(e.hourly_rate), addQty: num(e.hours) }).entries.push(e)
    }
    if (e.km_billable && num(e.km) && num(e.km_rate)) {
      add(cls, `km|${num(e.km_rate)}`, { desc: 'Matkakulut', unit: 'km', price: num(e.km_rate), addQty: num(e.km) }).entries.push(e)
    }
    if (e.per_diem_billable && e.per_diem !== 'ei') {
      const r = yearRates(settings, e.work_date)
      const amount = e.per_diem === 'koko' ? num(r.pdFull) : num(r.pdPart)
      if (amount) add(cls, `pd|${e.per_diem}|${amount}`, { desc: PER_DIEM_LABELS[e.per_diem], unit: 'pv', price: amount, addQty: 1, pd: true }).entries.push(e)
    }
    if (num(e.travel_hours) && num(e.travel_rate)) {
      add(cls, `tt|${num(e.travel_rate)}`, { desc: 'Matka-aika', unit: 'h', price: num(e.travel_rate), addQty: num(e.travel_hours) }).entries.push(e)
    }
  }
  const out = {}
  for (const cls of ['kaannetty', 'alv']) {
    const order = k => k.desc === 'Matkakulut' ? 1 : k.pd ? 2 : k.desc === 'Matka-aika' ? 3 : 0
    const lines = [...groups[cls].values()].sort((a, b) => order(a) - order(b)).map(l => {
      const ents = [...new Set(l.entries)]
      return { desc: l.desc, unit: l.unit, price: l.price, qty: l.qty, total: round2(l.qty * l.price), period: periodText(ents) }
    })
    if (!lines.length) continue
    const net = round2(lines.reduce((s, l) => s + l.total, 0))
    const vat = cls === 'alv' ? round2(net * num(settings.vatPct) / 100) : 0
    out[cls] = { lines, net, vat, gross: round2(net + vat) }
  }
  const usage = buildMaterialUsage(entries)
  if (usage.length) out.materials = usage
  return out
}

export function clientInfoLines(client) {
  if (!client) return []
  return [
    client.business_id && `Y-tunnus: ${client.business_id}`,
    client.address && client.address.replace(/\n+/g, ', '),
    client.einvoice && `Verkkolaskuosoite: ${client.einvoice}`,
    client.email && `Sähköposti: ${client.email}`,
  ].filter(Boolean)
}

export function invoiceText(clientName, invoice, settings = DEFAULT_SETTINGS, client = null) {
  const rows = []
  rows.push(`Lasku: ${clientName}`)
  rows.push(...clientInfoLines(client))
  for (const cls of ['kaannetty', 'alv']) {
    const g = invoice[cls]
    if (!g) continue
    rows.push('')
    rows.push(cls === 'kaannetty' ? 'Rakentamispalvelu (alv 0 %)' : `Palvelut (alv ${fmtNum(settings.vatPct, 1)} %)`)
    for (const l of g.lines) {
      rows.push(`${l.desc} (${l.period}): ${fmtNum(l.qty)} ${l.unit} × ${fmtEur(l.price)} = ${fmtEur(l.total)}`)
    }
    rows.push(`Yhteensä alv 0: ${fmtEur(g.net)}`)
    if (cls === 'kaannetty') rows.push('Käännetty verovelvollisuus, AVL 8 c §')
    else rows.push(`ALV ${fmtNum(settings.vatPct, 1)} %: ${fmtEur(g.vat)} · Yhteensä: ${fmtEur(g.gross)}`)
  }
  if (invoice.materials?.length) {
    rows.push('')
    rows.push('Käytetyt materiaalit (tilaajan omat, ei laskuteta):')
    let site = null
    for (const r of invoice.materials) {
      if (r.site !== site) { site = r.site; rows.push(`${site}:`) }
      rows.push(`- ${r.name} ${fmtNum(r.qty)} ${r.unit}`)
    }
  }
  return rows.join('\n')
}

// --- Kopioitavat tekstit: UKKO-laskun rivit ja viesti tilaajan ryhmään ---------
const unitOut = u => (u === 'jm' ? 'm' : u || '')
const dm = d => { const x = new Date(d + 'T12:00:00'); return `${x.getDate()}.${x.getMonth() + 1}` }
// "3.11 & 6.11.2026" tai "27.10, 28.10 & 30.10.2026"
export function datesText(dates, withYear = true) {
  const ds = [...new Set(dates)].sort()
  if (!ds.length) return ''
  const parts = ds.map(dm)
  const head = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}` : parts[0]
  return withYear ? `${head}.${ds[ds.length - 1].slice(0, 4)}` : head
}
// Tuntirivien kuvaukset yhteen ilman toistoa: kuvaukset pilkotaan osiin (pilkku, &, ja),
// ja sama tai lähes sama osa (kirjoitusvirhe, taivutus: "tavaroiden" / "tavaroitten")
// otetaan vain kerran. "Siivous, tavaroiden siirtely & putsaus" + "tavaroitten siirtely
// & putsaus" → "Siivous, tavaroiden siirtely, putsaus".
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9åäö]/g, '')
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}
const sameName = (a, b) => a === b || (a.length > 5 && b.length > 5 && (editDistance(a, b) <= 2 || a.includes(b) || b.includes(a)))
export function nameParts(names) {
  const out = []
  for (const n of names) {
    for (const raw of String(n || '').split(/\s*(?:,|&|\+|\bja\b)\s*/i)) {
      const part = raw.trim()
      const k = normName(part)
      if (!k) continue
      const hit = out.find(o => sameName(o.k, k))
      if (hit) { if (k.length > hit.k.length && hit.k.length > 5 && k.includes(hit.k)) { hit.k = k; hit.part = part } continue }
      out.push({ k, part })
    }
  }
  return out.map(o => o.part)
}
function mergeNames(names) {
  const parts = nameParts(names)
  if (!parts.length) return ''
  const s = parts.join(', ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
// UKKO-laskun rivit: nimikkeet yhdistetään työmaista ja päivistä riippumatta,
// ei asiakastietoja eikä materiaaleja (ne ovat UKKO:n laskupohjassa).
// Rivit erotellaan verokäsittelyn mukaan: rakentamispalvelu (käännetty ALV, alv 0)
// ja muut palvelut (esim. konsultointi, ALV 25,5 %). Rivillä vat = 'kaannetty' | 'alv'.
export function buildUkkoRows(entries, settings = DEFAULT_SETTINGS) {
  const rows = new Map()
  const add = (vat, key, base, qty) => {
    const k = `${vat}|${key}`
    const r = rows.get(k) || { ...base, vat, qty: 0, names: [] }
    r.qty = round2(r.qty + qty)
    if (base.name) r.names.push(base.name)
    rows.set(k, r)
  }
  for (const e of entries) {
    const vat = vatClass(e)
    if (e.kind === 'urakka') {
      for (const l of e.lines || []) {
        const q = num(l.maara), price = unitPrice(l, e.multiplier)
        if (!q || !price) continue
        if (l.hourly) add(vat, `h|${price}`, { order: 1, unit: 'h', price, name: l.tyolaji || 'Tuntityö' }, q)
        else { const n = invoiceName(l.tyolaji) || 'Urakkatyö'; add(vat, `u|${n}|${unitOut(l.yksikko)}|${price}`, { order: 0, desc: n, unit: unitOut(l.yksikko), price }, q) }
      }
    } else if (num(e.hours) && num(e.hourly_rate)) {
      const n = e.kind === 'konsultointi' ? 'Työturvallisuuskonsultointi' : (settings.invoiceTitle || 'Tuntityö')
      add(vat, `t|${e.kind}|${num(e.hourly_rate)}`, { order: 1, desc: n, unit: 'h', price: num(e.hourly_rate) }, num(e.hours))
    }
    if (e.km_billable && num(e.km) && num(e.km_rate)) add(vat, `km|${num(e.km_rate)}`, { order: 2, desc: 'Kilometrikorvaus', unit: 'km', price: num(e.km_rate) }, num(e.km))
    if (e.per_diem_billable && e.per_diem !== 'ei') {
      const r = yearRates(settings, e.work_date)
      const amount = e.per_diem === 'koko' ? num(r.pdFull) : num(r.pdPart)
      if (amount) add(vat, `pd|${e.per_diem}|${amount}`, { order: 3, desc: PER_DIEM_LABELS[e.per_diem], unit: 'pv', price: amount }, 1)
    }
    if (num(e.travel_hours) && num(e.travel_rate)) add(vat, `tt|${num(e.travel_rate)}`, { order: 3, desc: 'Matka-aika', unit: 'h', price: num(e.travel_rate) }, num(e.travel_hours))
  }
  const vatOrder = v => (v === 'kaannetty' ? 0 : 1)
  return [...rows.values()]
    .map(r => ({ desc: r.desc || mergeNames(r.names), unit: r.unit, price: r.price, qty: r.qty, total: round2(r.qty * r.price), order: r.order, vat: r.vat }))
    .sort((a, b) => vatOrder(a.vat) - vatOrder(b.vat) || a.order - b.order)
}
// Rivit verokäsittelyittäin: [{ vat, title, rows, net, vatEur, gross }]
export function ukkoGroups(rows, settings = DEFAULT_SETTINGS) {
  const out = []
  for (const vat of ['kaannetty', 'alv']) {
    const rs = rows.filter(r => r.vat === vat)
    if (!rs.length) continue
    const net = round2(rs.reduce((s, r) => s + r.total, 0))
    const vatEur = vat === 'alv' ? round2(net * num(settings.vatPct) / 100) : 0
    out.push({
      vat, rows: rs, net, vatEur, gross: round2(net + vatEur),
      title: vat === 'kaannetty' ? 'Rakentamispalvelu, käännetty verovelvollisuus (alv 0 %)' : `Palvelut, alv ${fmtNum(settings.vatPct, 1)} %`,
    })
  }
  return out
}
export function ukkoText(entries, settings = DEFAULT_SETTINGS) {
  const rows = buildUkkoRows(entries, settings)
  const groups = ukkoGroups(rows, settings)
  const sites = [...new Set(entries.map(e => (e.site || '').trim()).filter(Boolean))]
  const title = [settings.invoiceTitle || '', sites.join(', '), datesText(entries.map(e => e.work_date))].filter(Boolean).join(' ')
  const out = [title, '']
  const line = r => `${r.desc}: ${fmtNum(r.qty)} ${r.unit} × ${fmtEur(r.price)} = ${fmtEur(r.total)}`
  if (!groups.length || (groups.length === 1 && groups[0].vat === 'kaannetty')) {
    // Tavallinen tapaus: pelkkä rakentamispalvelu (käännetty ALV)
    for (const r of rows) out.push(line(r))
    out.push('', `Yhteensä alv 0: ${fmtEur(groups[0]?.net || 0)}`)
  } else {
    // Eri verokäsittelyt omina ryhminään (UKKO:ssa omat rivinsä oikealla ALV:lla)
    groups.forEach((g, i) => {
      if (i) out.push('')
      out.push(`${g.title}:`)
      for (const r of g.rows) out.push(line(r))
      out.push(g.vat === 'kaannetty'
        ? `Yhteensä alv 0: ${fmtEur(g.net)}`
        : `Yhteensä veroton ${fmtEur(g.net)} + ALV ${fmtNum(settings.vatPct, 1)} % ${fmtEur(g.vatEur)} = ${fmtEur(g.gross)}`)
    })
  }
  return out.join('\n')
}
// Viesti tilaajan ryhmään: työmaittain, kohdittain, määrät ilman hintoja
export function groupMessageText(entries) {
  const bySite = new Map()
  for (const e of [...entries].sort((a, b) => a.work_date.localeCompare(b.work_date))) {
    const k = (e.site || e.client_name || '').trim()
    if (!bySite.has(k)) bySite.set(k, [])
    bySite.get(k).push(e)
  }
  const blocks = []
  for (const [site, list] of bySite) {
    const out = [`${site} ${datesText(list.map(e => e.work_date), false)}`]
    const kohdat = new Map() // kohta → Map(nimike|yks → määrä)
    // Tunnit hinnoittain: eri hinnalla tehdyt (esim. palokatkot 40 €/h) omalle rivilleen
    const hours = new Map(), mats = new Map()
    const addHours = (name, qty, price) => {
      const k = String(round2(num(price)))
      const cur = hours.get(k) || { names: [], qty: 0 }
      cur.names.push(name); cur.qty = round2(cur.qty + qty); hours.set(k, cur)
    }
    for (const e of list) {
      if (e.kind !== 'urakka' && num(e.hours)) addHours(e.kind === 'konsultointi' ? 'konsultointi' : 'tuntityö', num(e.hours), e.hourly_rate)
      for (const l of e.lines || []) {
        const q = num(l.maara)
        if (!q) continue
        if (l.hourly || (l.yksikko === 'h' && e.kind !== 'urakka')) {
          addHours((l.tyolaji || 'tunnit').trim(), q, l.tes)
          continue
        }
        const kohta = (l.kohta || '').trim()
        if (!kohdat.has(kohta)) kohdat.set(kohta, new Map())
        const m = kohdat.get(kohta), key = `${(l.tyolaji || 'Urakkatyö').trim()}|${unitOut(l.yksikko)}`
        m.set(key, round2((m.get(key) || 0) + q))
      }
      for (const x of e.materials || []) {
        const q = num(x.maara)
        if (!q) continue
        const key = `${(x.nimi || '').trim().toLowerCase()}|${x.yksikko}`
        const cur = mats.get(key) || { name: (x.nimi || '').trim(), unit: x.yksikko, qty: 0 }
        cur.qty = round2(cur.qty + q); mats.set(key, cur)
      }
    }
    const ks = [...kohdat.keys()].sort((a, b) => (a ? 1 : 0) - (b ? 1 : 0)) // ilman kohtaa ensin
    for (const k of ks) {
      out.push('')
      if (k) out.push(k)
      for (const [key, q] of kohdat.get(k)) { const [n, u] = key.split('|'); out.push(`${n}: ${fmtNum(q)} ${u}`) }
    }
    if (mats.size) {
      out.push('', 'Materiaalit')
      for (const m of mats.values()) out.push(`${m.name}: ${fmtNum(m.qty)} ${m.unit}`)
    }
    // Suurin tuntiryhmä "Tunnit: 9 h siivous, …", muut omina riveinään "Palokatkot: 2 h"
    const hrs = [...hours.values()].sort((a, b) => b.qty - a.qty)
    if (hrs.length || list.some(e => num(e.km) > 0)) out.push('')
    hrs.forEach((h, i) => {
      const desc = mergeNames(h.names)
      out.push(i === 0 ? `Tunnit: ${fmtNum(h.qty)} h ${desc.toLowerCase()}` : `${desc}: ${fmtNum(h.qty)} h`)
    })
    const kmDays = list.filter(e => num(e.km) > 0).length
    if (kmDays) out.push(`Kilsat x${kmDays}`)
    blocks.push(out.join('\n'))
  }
  return blocks.join('\n\n')
}

// Materiaalien kulutus työmaittain (myös ne, joita ei laskuteta)
export function buildMaterialUsage(entries) {
  const m = new Map()
  for (const e of entries) {
    for (const x of e.materials || []) {
      const q = num(x.maara)
      if (!q) continue
      const name = (x.nimi || 'Materiaali').trim()
      const site = (e.site || '').trim() || e.client_name
      const key = `${site}|${name.toLowerCase()}|${x.yksikko}`
      const cur = m.get(key) || { site, name, unit: x.yksikko || 'kpl', qty: 0 }
      cur.qty = round2(cur.qty + q)
      m.set(key, cur)
    }
  }
  return [...m.values()].sort((a, b) => a.site.localeCompare(b.site, 'fi') || a.name.localeCompare(b.name, 'fi'))
}

export function materialUsageText(rows) {
  const out = ['Materiaalit']
  let site = null
  for (const r of rows) {
    if (r.site !== site) { site = r.site; out.push(''); out.push(site) }
    out.push(`${r.name}: ${fmtNum(r.qty)} ${r.unit}`)
  }
  return out.join('\n')
}

// Oma matkalasku: päivä kerrallaan, kaikilta asiakkailta
// --- Ajopäiväkirja ------------------------------------------------------------
// Erillinen ajo = valmis ajo, jota ei ole liitetty työpäivään (esim. tarvikeostokset).
// Työpäivään liitetyn ajon km:t ovat jo työpäivän km-kentässä, joten niitä ei
// lasketa kahteen kertaan.
export function standaloneTrips(trips = []) {
  return trips.filter(t => !t.archived && !t.entry_id && !isOpenTrip(t) && num(t.km) > 0)
}
export const isOpenTrip = t => t.odo_start != null && t.odo_end == null && !t.end_time
export function tripRoute(homeAddress, site, fallback) {
  const home = (homeAddress || '').trim() || 'Koti'
  const dest = (site?.address || site?.name || fallback || '').trim()
  return dest ? `${home} – ${dest} – ${home}` : ''
}
// Yhdistetty ajopäiväkirja: työpäivät km:llä + erilliset ajot + käynnissä oleva ajo.
// Peräkkäisten mittarilukemien väli näytetään yksityisajona (ei korvauksiin).
export function buildDriveLog(entries, trips, sites, homeAddress) {
  const siteById = id => sites.find(x => x.id === id)
  const byEntry = new Map(trips.filter(t => t.entry_id && !t.archived).map(t => [t.entry_id, t]))
  const rows = []
  for (const e of entries) {
    const t = byEntry.get(e.id)
    if (!(num(e.km) > 0) && !t) continue
    const site = e.site_id && siteById(e.site_id)
    rows.push({
      date: e.work_date,
      start: t?.start_time || e.depart_time || '', end: t?.end_time || e.return_time || '',
      route: t?.route || tripRoute(homeAddress, site, e.site),
      purpose: t?.purpose || `Työkeikka: ${e.client_name}${e.site ? `, ${e.site}` : ''}`,
      odoStart: t?.odo_start ?? null, odoEnd: t?.odo_end ?? null,
      km: num(e.km) || num(t?.km), source: 'tyopaiva', entryId: e.id, tripId: t?.id || null,
      open: !!t && isOpenTrip(t),
    })
  }
  for (const t of trips) {
    if (t.archived || (t.entry_id && entries.some(e => e.id === t.entry_id))) continue
    rows.push({
      date: t.trip_date, start: t.start_time || '', end: t.end_time || '',
      route: t.route || '', purpose: t.purpose || '', odoStart: t.odo_start ?? null, odoEnd: t.odo_end ?? null,
      km: num(t.km), source: 'ajo', entryId: t.entry_id || null, tripId: t.id,
      open: isOpenTrip(t),
    })
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)) || (a.odoStart ?? 0) - (b.odoStart ?? 0))
  // Yksityisajo kahden lukemallisen työajon välissä
  let prevEnd = null
  for (const r of rows) {
    if (r.odoStart != null && prevEnd != null && r.odoStart > prevEnd) r.privateBefore = r.odoStart - prevEnd
    if (r.odoEnd != null) prevEnd = r.odoEnd
  }
  const businessKm = round2(rows.filter(r => !r.open).reduce((s, r) => s + r.km, 0))
  const privateKm = rows.reduce((s, r) => s + (r.privateBefore || 0), 0)
  return { rows, businessKm, privateKm }
}

export function buildTravelClaim(entries, settings = DEFAULT_SETTINGS, trips = []) {
  const rows = entries
    .filter(e => num(e.km) > 0 || e.per_diem !== 'ei')
    .map(e => {
      const t = entryTotals(e, settings)
      return { date: e.work_date, client: e.client_name, site: e.site || '', km: num(e.km), kmEur: t.ownKm, kmRate: num(yearRates(settings, e.work_date).ownKmRate), perDiem: e.per_diem, pdEur: t.perDiem }
    })
  for (const t of standaloneTrips(trips)) {
    const rate = num(yearRates(settings, t.trip_date).ownKmRate)
    rows.push({ date: t.trip_date, client: t.client_name || '', site: t.purpose || t.route || 'Työajo', km: num(t.km), kmEur: round2(num(t.km) * rate), kmRate: rate, perDiem: 'ei', pdEur: 0 })
  }
  rows.sort((a, b) => a.date.localeCompare(b.date))
  const km = round2(rows.reduce((s, r) => s + r.km, 0))
  const kmEur = round2(rows.reduce((s, r) => s + r.kmEur, 0))
  const pdEur = round2(rows.reduce((s, r) => s + r.pdEur, 0))
  return { rows, km, kmEur, pdEur, total: round2(kmEur + pdEur) }
}

export function travelClaimText(claim, settings = DEFAULT_SETTINGS) {
  const rows = ['Matkalasku']
  for (const r of claim.rows) {
    const parts = [fmtDate(r.date), [r.site, r.client].filter(Boolean).join(' / ')]
    if (r.km) parts.push(`${fmtNum(r.km)} km × ${fmtEur(r.kmRate ?? settings.ownKmRate)} = ${fmtEur(r.kmEur)}`)
    if (r.pdEur) parts.push(`${PER_DIEM_LABELS[r.perDiem]} ${fmtEur(r.pdEur)}`)
    rows.push(parts.join(' · '))
  }
  rows.push('')
  rows.push(`Kilometrikorvaukset: ${fmtNum(claim.km)} km = ${fmtEur(claim.kmEur)}`)
  rows.push(`Päivärahat: ${fmtEur(claim.pdEur)}`)
  rows.push(`Yhteensä (verovapaa): ${fmtEur(claim.total)}`)
  return rows.join('\n')
}

export function entriesCSV(entries, settings = DEFAULT_SETTINGS) {
  const esc = v => {
    const s = String(v ?? '')
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const n = v => String(round2(v)).replace('.', ',')
  const head = ['Päivä', 'Asiakas', 'Työmaa', 'Tyyppi', 'Tunnit', '€/h', 'Urakkarivit', 'Työ €', 'Materiaalit (tilaajan)', 'Km', 'Km laskutetaan', 'Matkat €', 'Yhteensä alv 0 €', 'Päiväraha', 'Päiväraha €', 'Laskutettu', 'Lisätieto']
  const rows = entries.map(e => {
    const t = entryTotals(e, settings)
    const lines = e.kind === 'urakka'
      ? (e.lines || []).map(l => `${l.tyolaji} ${fmtNum(num(l.maara))} ${l.yksikko} × ${n(unitPrice(l, e.multiplier))}`).join(' | ')
      : ''
    return [fmtDate(e.work_date), e.client_name, e.site, KIND_LABELS[e.kind], e.kind === 'urakka' ? '' : n(e.hours), e.kind === 'urakka' ? '' : n(e.hourly_rate),
      lines, n(t.work),
      (e.materials || []).map(m => `${m.nimi} ${fmtNum(num(m.maara))} ${m.yksikko}`).join(' | '),
      n(e.km), e.km_billable ? 'kyllä' : 'ei', n(t.travel), n(t.total), PER_DIEM_LABELS[e.per_diem], n(t.perDiem),
      e.invoiced_at ? fmtDate(e.invoiced_at.slice(0, 10)) : '', e.notes].map(esc).join(';')
  })
  return '﻿' + [head.join(';'), ...rows].join('\n')
}
