// src/ukkoMatkalasku.js — täyttää UKKO.fi:n oman matkalaskupohjan (2026).
//
// Pohja: public/ukko-matkalasku-2026.xlsx (UKKO:n alkuperäinen tiedosto).
// Täytetään kilometrikorvaukset (rivit 9–21) ja kotimaan päivärahat (27–41).
// Jos rivejä on enemmän kuin pohjassa, lisätään rivejä ja kirjoitetaan
// kaikki pohjan kaavat ja yhdistetyt solut uudelleen oikeille riveille,
// koska ExcelJS ei siirrä niitä itse.
import { num, round2, DEFAULT_SETTINGS, standaloneTrips } from './worklog.js'

const TEMPLATE_URL = '/ukko-matkalasku-2026.xlsx'
// Pohjan rakenne (rivinumerot alkuperäisessä tiedostossa)
const KM_FIRST = 9, KM_LAST = 21, KM_TOTAL = 22
const PD_FIRST = 27, PD_LAST = 41, PD_TOTAL = 42
const FX_FIRST = 47, FX_LAST = 63, FX_TOTAL = 64
const GRAND = 66

// pp.kk.vvvv [tt:mm], kuten pohja pyytää
const ddmmyyyy = iso => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}.${y}` }
const dt = (iso, time) => `${ddmmyyyy(iso)}${time ? ' ' + String(time).slice(0, 5) : ''}`

// Rivit matkalaskulle kuukauden merkinnöistä
export function travelRows(entries, sites, profile, trips = []) {
  const home = (profile.homeAddress || '').trim() || 'Koti'
  const byId = id => sites.find(s => s.id === id)
  const sorted = [...entries].sort((a, b) => a.work_date.localeCompare(b.work_date) || (a.id || 0) - (b.id || 0))
  const purpose = e => {
    const site = (e.site || '').trim()
    return `Työkeikka: ${e.client_name}${site ? `, ${site}` : ''}`
  }
  const place = e => {
    const s = e.site_id && byId(e.site_id)
    return (s?.address || e.site || '').trim()
  }
  const linked = new Map(trips.filter(t => t.entry_id && !t.archived).map(t => [t.entry_id, t]))
  const km = sorted.filter(e => num(e.km) > 0).map(e => ({
    sort: e.work_date,
    date: dt(e.work_date),
    route: linked.get(e.id)?.route || `${home} – ${place(e) || e.site || e.client_name} – ${home}`,
    purpose: purpose(e),
    km: num(e.km),
  }))
  for (const t of standaloneTrips(trips)) {
    km.push({ sort: t.trip_date, date: dt(t.trip_date), route: t.route || '', purpose: t.purpose || 'Työajo', km: num(t.km) })
  }
  km.sort((a, b) => a.sort.localeCompare(b.sort))
  const pd = sorted.filter(e => e.per_diem === 'osa' || e.per_diem === 'koko').map(e => ({
    depart: dt(e.work_date, e.depart_time || e.start_time),
    place: place(e) || e.site || '',
    purpose: purpose(e),
    ret: dt(e.work_date, e.return_time || e.end_time),
    full: e.per_diem === 'koko' ? 1 : 0,
    part: e.per_diem === 'osa' ? 1 : 0,
  }))
  return { km, pd }
}

export async function fillUkkoTravelClaim(ExcelJS, templateBuf, entries, sites, profile, settings = DEFAULT_SETTINGS, trips = []) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(templateBuf)
  const ws = wb.worksheets[0]
  const { km, pd } = travelRows(entries, sites, profile, trips)
  const kmRate = num(settings.ownKmRate) || 0.55
  const pdFull = num(settings.pdFull) || 54
  const pdPart = num(settings.pdPart) || 25

  const kmExtra = Math.max(0, km.length - (KM_LAST - KM_FIRST + 1))
  const pdExtra = Math.max(0, pd.length - (PD_LAST - PD_FIRST + 1))

  // Datarivien tyylit talteen (pohjan rivit eivät ole keskenään yhtenäisiä)
  const cols = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
  const styleOf = r => Object.fromEntries(cols.map(c => [c, JSON.parse(JSON.stringify(ws.getCell(`${c}${r}`).style || {}))]))
  const kmStyle = styleOf(KM_FIRST + 1)
  const pdStyle = styleOf(PD_FIRST)
  // Yhdistetyt solut talteen ja auki ennen rivien lisäystä
  const merges = [...(ws.model.merges || [])]
  merges.forEach(m => { try { ws.unMergeCells(m) } catch { /* ok */ } })
  const shiftRow = r => r + (r >= KM_TOTAL ? kmExtra : 0) + (r >= PD_TOTAL ? pdExtra : 0)
  // Lisätään rivit (alempi ensin, ettei ylempi lisäys sotke rivinumeroita)
  const blank = n => Array.from({ length: n }, () => [])
  if (pdExtra) ws.insertRows(PD_TOTAL, blank(pdExtra), 'i')
  if (kmExtra) ws.insertRows(KM_TOTAL, blank(kmExtra), 'i')
  const kmTotal = shiftRow(KM_TOTAL), pdFirst = shiftRow(PD_FIRST), pdTotal = shiftRow(PD_TOTAL)
  const fxFirst = shiftRow(FX_FIRST), fxTotal = shiftRow(FX_TOTAL), grand = shiftRow(GRAND)
  const kmLast = kmTotal - 1, pdLast = pdTotal - 1, fxLast = fxTotal - 1

  // Yhdistetyt solut takaisin siirretyille riveille + reittisarake C:E uusille km-riveille
  const shifted = merges.map(m => m.replace(/([A-Z]+)(\d+)/g, (_, c, r) => c + shiftRow(Number(r))))
  for (let r = KM_FIRST; r <= kmLast; r++) shifted.push(`C${r}:E${r}`)
  for (const m of new Set(shifted)) { try { ws.mergeCells(m) } catch { /* jo yhdistetty */ } }

  // Otsikkotiedot
  const now = new Date()
  ws.getCell('C3').value = ddmmyyyy(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
  ws.getCell('C4').value = profile.name || ''
  ws.getCell('C5').value = profile.vehicle || ''

  // Kilometrikorvaukset
  let kmSum = 0, kmEur = 0
  for (let r = KM_FIRST; r <= kmLast; r++) {
    const x = km[r - KM_FIRST]
    const row = ws.getRow(r)
    for (const c of cols.slice(0, 8)) row.getCell(c).style = JSON.parse(JSON.stringify(kmStyle[c]))
    for (const c of ['B', 'C', 'F']) row.getCell(c).alignment = { vertical: 'top', horizontal: 'left', wrapText: true }
    row.getCell('G').numFmt = '#,##0'
    for (const c of ['G', 'H', 'I']) row.getCell(c).alignment = { vertical: 'top', horizontal: 'right' }
    if (x) row.height = 30
    row.getCell('B').value = x ? x.date : null
    row.getCell('C').value = x ? x.route : null
    row.getCell('F').value = x ? x.purpose : null
    row.getCell('G').value = x ? x.km : null
    row.getCell('H').value = kmRate
    const eur = x ? round2(x.km * kmRate) : 0
    row.getCell('I').value = { formula: `G${r}*H${r}`, result: eur }
    if (x) { kmSum += x.km; kmEur += eur }
  }
  ws.getCell(`G${kmTotal}`).value = { formula: `SUM(G${KM_FIRST}:G${kmLast})`, result: round2(kmSum) }
  ws.getCell(`I${kmTotal}`).value = { formula: `SUM(I${KM_FIRST}:I${kmLast})`, result: round2(kmEur) }

  // Kotimaan päivärahat
  let nFull = 0, nPart = 0, pdEur = 0
  for (let r = pdFirst; r <= pdLast; r++) {
    const x = pd[r - pdFirst]
    const row = ws.getRow(r)
    for (const c of cols) row.getCell(c).style = JSON.parse(JSON.stringify(pdStyle[c]))
    for (const c of ['B', 'C', 'D', 'E']) row.getCell(c).alignment = { vertical: 'top', horizontal: 'left', wrapText: true }
    for (const c of ['G', 'H', 'I']) row.getCell(c).numFmt = '0'
    for (const c of ['G', 'H', 'I', 'J']) row.getCell(c).alignment = { vertical: 'top', horizontal: 'right' }
    if (x) row.height = 30
    row.getCell('B').value = x ? x.depart : null
    row.getCell('C').value = x ? x.place : null
    row.getCell('D').value = x ? x.purpose : null
    row.getCell('E').value = x ? x.ret : null
    row.getCell('G').value = x ? x.full : null
    row.getCell('H').value = x ? x.part : null
    row.getCell('I').value = x ? 0 : null
    const eur = x ? x.full * pdFull + x.part * pdPart : 0
    row.getCell('J').value = { formula: `(G${r}*54)+(H${r}*25)`, result: eur }
    if (x) { nFull += x.full; nPart += x.part; pdEur += eur }
  }
  ws.getCell(`G${pdTotal}`).value = { formula: `SUM(G${pdFirst}:G${pdLast})`, result: nFull }
  ws.getCell(`H${pdTotal}`).value = { formula: `SUM(H${pdFirst}:H${pdLast})`, result: nPart }
  ws.getCell(`J${pdTotal}`).value = { formula: `SUM(J${pdFirst}:J${pdLast})`, result: pdEur }

  // Ulkomaanpäivärahat: tyhjät, mutta kaavat oikeille riveille
  for (let r = fxFirst; r <= fxLast; r++) {
    ws.getCell(`J${r}`).value = { formula: `(G${r}*F${r})+(H${r}*F${r}*0.5)`, result: 0 }
  }
  ws.getCell(`G${fxTotal}`).value = { formula: `SUM(G${fxFirst}:G${fxLast})`, result: 0 }
  ws.getCell(`H${fxTotal}`).value = { formula: `SUM(H${fxFirst}:H${fxLast})`, result: 0 }
  ws.getCell(`J${fxTotal}`).value = { formula: `SUM(J${fxFirst}:J${fxLast})`, result: 0 }

  // Summasarakkeet leveämmiksi, ettei isoista summista tule ####
  ws.getColumn('I').width = Math.max(ws.getColumn('I').width || 0, 13)
  ws.getColumn('J').width = Math.max(ws.getColumn('J').width || 0, 13)
  ws.getCell(`C${grand}`).value = { formula: `I${kmTotal}+J${pdTotal}+J${fxTotal}`, result: round2(kmEur + pdEur) }
  return { wb, total: round2(kmEur + pdEur), kmCount: km.length, pdCount: pd.length }
}

export async function downloadUkkoTravelClaim(entries, sites, profile, settings, month, trips = []) {
  const mod = await import('exceljs/dist/exceljs.min.js')
  const ExcelJS = mod.default || mod
  const res = await fetch(TEMPLATE_URL)
  if (!res.ok) throw new Error('UKKO-pohjaa ei löytynyt')
  const { wb } = await fillUkkoTravelClaim(ExcelJS, await res.arrayBuffer(), entries, sites, profile, settings, trips)
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Matkalasku-${month}-Korpnex.xlsx`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
