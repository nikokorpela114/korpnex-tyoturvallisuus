// src/worklog.js — Työajat-osion laskenta (puhdas logiikka, ei Reactia).
//
// Laskutus asiakkaalle:
//   tuntityö / konsultointi  tunnit × €/h
//   urakka                   määrä × (TES-hinta × kerroin), yksikköhinta
//                            pyöristetään senteille kuten laskulla
//   matkat                   km × €/km (jos laskutetaan) + matka-aika × €/h
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
}

const SETTINGS_KEY = 'korpnex_tt_worklog_settings_v1'

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS }
  } catch { return { ...DEFAULT_SETTINGS } }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* ei väliä */ }
}

export const KIND_LABELS = { tunti: 'Tuntityö', urakka: 'Urakka', konsultointi: 'Konsultointi' }
export const PER_DIEM_LABELS = { ei: 'Ei päivärahaa', osa: 'Osapäiväraha', koko: 'Kokopäiväraha' }
export const UNITS = ['m', 'm²', 'kpl', 'h']

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

export function unitPrice(line, multiplier) {
  return round2(num(line.tes) * num(multiplier))
}

export function vatClass(e) {
  return e.kind === 'konsultointi' ? 'alv' : 'kaannetty'
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
  const perDiem = e.per_diem === 'koko' ? num(settings.pdFull) : e.per_diem === 'osa' ? num(settings.pdPart) : 0
  const ownKm = round2(num(e.km) * num(settings.ownKmRate))
  return {
    work: round2(work),
    travel: round2(kmBill + travelTime),
    total: round2(work + kmBill + travelTime),
    perDiem,
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
        const name = (l.tyolaji || 'Urakkatyö').trim()
        add(cls, `u|${name}|${l.yksikko}|${price}|${site}`, { desc: `${name}${where}`, unit: l.yksikko || 'kpl', price, addQty: q }).entries.push(e)
      }
    } else if (num(e.hours) && num(e.hourly_rate)) {
      const label = e.kind === 'konsultointi' ? 'Työturvallisuuskonsultointi' : 'Tuntityö'
      add(cls, `h|${e.kind}|${num(e.hourly_rate)}|${site}`, { desc: `${label}${where}`, unit: 'h', price: num(e.hourly_rate), addQty: num(e.hours) }).entries.push(e)
    }
    if (e.km_billable && num(e.km) && num(e.km_rate)) {
      add(cls, `km|${num(e.km_rate)}`, { desc: 'Matkakulut', unit: 'km', price: num(e.km_rate), addQty: num(e.km) }).entries.push(e)
    }
    if (num(e.travel_hours) && num(e.travel_rate)) {
      add(cls, `tt|${num(e.travel_rate)}`, { desc: 'Matka-aika', unit: 'h', price: num(e.travel_rate), addQty: num(e.travel_hours) }).entries.push(e)
    }
  }
  const out = {}
  for (const cls of ['kaannetty', 'alv']) {
    const order = k => k.desc === 'Matkakulut' ? 1 : k.desc === 'Matka-aika' ? 2 : 0
    const lines = [...groups[cls].values()].sort((a, b) => order(a) - order(b)).map(l => {
      const ents = [...new Set(l.entries)]
      return { desc: l.desc, unit: l.unit, price: l.price, qty: l.qty, total: round2(l.qty * l.price), period: periodText(ents) }
    })
    if (!lines.length) continue
    const net = round2(lines.reduce((s, l) => s + l.total, 0))
    const vat = cls === 'alv' ? round2(net * num(settings.vatPct) / 100) : 0
    out[cls] = { lines, net, vat, gross: round2(net + vat) }
  }
  return out
}

export function invoiceText(clientName, invoice, settings = DEFAULT_SETTINGS) {
  const rows = []
  rows.push(`Lasku: ${clientName}`)
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
  return rows.join('\n')
}

// Oma matkalasku: päivä kerrallaan, kaikilta asiakkailta
export function buildTravelClaim(entries, settings = DEFAULT_SETTINGS) {
  const rows = entries
    .filter(e => num(e.km) > 0 || e.per_diem !== 'ei')
    .sort((a, b) => a.work_date.localeCompare(b.work_date))
    .map(e => {
      const t = entryTotals(e, settings)
      return { date: e.work_date, client: e.client_name, site: e.site || '', km: num(e.km), kmEur: t.ownKm, perDiem: e.per_diem, pdEur: t.perDiem }
    })
  const km = round2(rows.reduce((s, r) => s + r.km, 0))
  const kmEur = round2(rows.reduce((s, r) => s + r.kmEur, 0))
  const pdEur = round2(rows.reduce((s, r) => s + r.pdEur, 0))
  return { rows, km, kmEur, pdEur, total: round2(kmEur + pdEur) }
}

export function travelClaimText(claim, settings = DEFAULT_SETTINGS) {
  const rows = ['Matkalasku']
  for (const r of claim.rows) {
    const parts = [fmtDate(r.date), [r.site, r.client].filter(Boolean).join(' / ')]
    if (r.km) parts.push(`${fmtNum(r.km)} km × ${fmtEur(settings.ownKmRate)} = ${fmtEur(r.kmEur)}`)
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
  const head = ['Päivä', 'Asiakas', 'Työmaa', 'Tyyppi', 'Tunnit', '€/h', 'Urakkarivit', 'Työ €', 'Km', 'Km laskutetaan', 'Matkat €', 'Yhteensä alv 0 €', 'Päiväraha', 'Päiväraha €', 'Laskutettu', 'Lisätieto']
  const rows = entries.map(e => {
    const t = entryTotals(e, settings)
    const lines = e.kind === 'urakka'
      ? (e.lines || []).map(l => `${l.tyolaji} ${fmtNum(num(l.maara))} ${l.yksikko} × ${n(unitPrice(l, e.multiplier))}`).join(' | ')
      : ''
    return [fmtDate(e.work_date), e.client_name, e.site, KIND_LABELS[e.kind], e.kind === 'urakka' ? '' : n(e.hours), e.kind === 'urakka' ? '' : n(e.hourly_rate),
      lines, n(t.work), n(e.km), e.km_billable ? 'kyllä' : 'ei', n(t.travel), n(t.total), PER_DIEM_LABELS[e.per_diem], n(t.perDiem),
      e.invoiced_at ? fmtDate(e.invoiced_at.slice(0, 10)) : '', e.notes].map(esc).join(';')
  })
  return '\ufeff' + [head.join(';'), ...rows].join('\n')
}
