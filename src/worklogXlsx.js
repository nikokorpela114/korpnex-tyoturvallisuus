// src/worklogXlsx.js — Työajat-kuukauden Excel-raportti (.xlsx, ExcelJS).
//
// Välilehdet:
//   Työpäivät    kaikki päivät, summarivi, suodattimet, jäädytetty otsikko
//   Laskurivit   asiakkaittain laskulle valmiit rivit + tilaajan materiaalit tiedoksi
//   Matkalasku   oma verovapaa matkalasku (km-korvaukset + päivärahat)
//   Materiaalit  kulutus työmaittain
// Summat ovat kaavoja (välimuistiarvoineen), jotta luvut näkyvät heti ja
// päivittyvät, jos riviä muokataan Excelissä.
import {
  KIND_LABELS, PER_DIEM_LABELS, num, round2, unitPrice, entryTotals,
  buildInvoice, buildTravelClaim, buildMaterialUsage, monthLabel, fmtTime, clientInfoLines, buildDriveLog,
} from './worklog.js'

const NAVY = 'FF0A1428'
const BLUE = 'FF0878E8'
const LIGHT = 'FFF4F6FA'
const LINE = 'FFE3E8EF'
const FONT = 'Arial'
const EUR = '#,##0.00 "€"'
const NUM = '#,##0.##'

const d = iso => { const [y, m, dd] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)) }
const weekday = iso => d(iso).toLocaleDateString('fi-FI', { weekday: 'short', timeZone: 'UTC' })

function styleSheet(ws) {
  ws.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: true }, c => {
    c.font = { name: FONT, size: 10, ...(c.font || {}), name: FONT }
  }))
}

function title(ws, text, sub, cols) {
  ws.mergeCells(1, 1, 1, cols)
  ws.getCell(1, 1).value = text
  ws.getCell(1, 1).font = { name: FONT, size: 15, bold: true, color: { argb: NAVY } }
  ws.getRow(1).height = 24
  ws.mergeCells(2, 1, 2, cols)
  ws.getCell(2, 1).value = sub
  ws.getCell(2, 1).font = { name: FONT, size: 10, color: { argb: 'FF64748B' } }
}

function header(ws, rowNo, labels) {
  const row = ws.getRow(rowNo)
  labels.forEach((l, i) => {
    const c = row.getCell(i + 1)
    c.value = l
    c.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
    c.alignment = { vertical: 'middle', wrapText: true }
    c.border = { bottom: { style: 'thin', color: { argb: NAVY } } }
  })
  row.height = 22
}

function zebra(row, i, cols) {
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c)
    if (i % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } }
    cell.border = { bottom: { style: 'hair', color: { argb: LINE } } }
    cell.alignment = { vertical: 'top', wrapText: true, ...(cell.alignment || {}) }
  }
}

function totalRow(row, cols) {
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c)
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: NAVY } }
    cell.border = { top: { style: 'medium', color: { argb: NAVY } } }
  }
}

const sumF = (col, from, to) => `SUM(${col}${from}:${col}${to})`
const colL = n => String.fromCharCode(64 + n)

export function buildWorkbook(ExcelJS, entries, settings, month, clients = [], sites = [], trips = []) {
  const clientFor = (name, list) => {
    const sid = list.find(e => e.site_id)?.site_id
    const site = sites.find(x => x.id === sid)
    return (site && clients.find(c => c.id === site.client_id))
      || clients.find(c => c.name.trim().toLowerCase() === name.trim().toLowerCase()) || null
  }
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Korpnex Oy'
  wb.created = new Date()
  const sorted = [...entries].sort((a, b) => a.work_date.localeCompare(b.work_date) || a.id - b.id)
  const mLabel = monthLabel(month)

  // ---- 1) Työpäivät ----------------------------------------------------------
  {
    const ws = wb.addWorksheet('Työpäivät', { views: [{ state: 'frozen', ySplit: 4 }] })
    const cols = [
      ['Päivä', 11], ['Vk-pv', 6], ['Asiakas', 18], ['Työmaa', 24], ['Tyyppi', 12],
      ['Alkoi', 7], ['Loppui', 7], ['Tauko min', 7], ['Tunnit', 8], ['€/h', 9], ['Urakka', 28], ['Työ €', 11], ['Km', 7], ['Km €', 10],
      ['Matka-aika €', 11], ['Päiväraha lask. €', 11], ['Yhteensä alv 0', 13], ['Päiväraha', 14], ['Päiväraha €', 11],
      ['Lähtö kotoa', 8], ['Paluu kotiin', 8],
      ['Materiaalit (tilaajan)', 26], ['Lisätieto', 34], ['Laskutettu', 11],
    ]
    const C = Object.fromEntries(cols.map(([l], i) => [l, i + 1]))
    title(ws, `Työajat · ${mLabel}`, `Korpnex Oy · ${sorted.length} työpäivää · summat alv 0`, cols.length)
    header(ws, 4, cols.map(c => c[0]))
    cols.forEach(([, w], i) => { ws.getColumn(i + 1).width = w })

    const first = 5
    sorted.forEach((e, i) => {
      const r = first + i
      const t = entryTotals(e, settings)
      const row = ws.getRow(r)
      const L = n => `${colL(n)}${r}`
      row.getCell(C['Päivä']).value = d(e.work_date)
      row.getCell(C['Päivä']).numFmt = 'd.m.yyyy'
      row.getCell(C['Vk-pv']).value = weekday(e.work_date)
      row.getCell(C['Asiakas']).value = e.client_name
      row.getCell(C['Työmaa']).value = e.site || ''
      row.getCell(C['Tyyppi']).value = KIND_LABELS[e.kind]
      row.getCell(C['Alkoi']).value = fmtTime(e.start_time)
      row.getCell(C['Loppui']).value = fmtTime(e.end_time)
      row.getCell(C['Tauko min']).value = e.break_minutes || null
      row.getCell(C['Lähtö kotoa']).value = fmtTime(e.depart_time)
      row.getCell(C['Paluu kotiin']).value = fmtTime(e.return_time)
      if (e.kind === 'urakka') {
        row.getCell(C['Urakka']).value = (e.lines || [])
          .map(l => `${l.tyolaji} ${String(num(l.maara)).replace('.', ',')} ${l.yksikko} × ${String(unitPrice(l, e.multiplier).toFixed(2)).replace('.', ',')} €`).join('\n')
        row.getCell(C['Työ €']).value = t.work
      } else {
        row.getCell(C['Tunnit']).value = num(e.hours)
        row.getCell(C['€/h']).value = num(e.hourly_rate)
        row.getCell(C['Työ €']).value = { formula: `ROUND(${L(C['Tunnit'])}*${L(C['€/h'])},2)`, result: t.work }
      }
      row.getCell(C['Km']).value = num(e.km) || null
      row.getCell(C['Km €']).value = e.km_billable && num(e.km)
        ? { formula: `ROUND(${L(C['Km'])}*${num(e.km_rate)},2)`, result: round2(num(e.km) * num(e.km_rate)) }
        : null
      const tt = round2(num(e.travel_hours) * num(e.travel_rate))
      row.getCell(C['Matka-aika €']).value = tt || null
      row.getCell(C['Päiväraha lask. €']).value = t.perDiemBill || null
      row.getCell(C['Yhteensä alv 0']).value = {
        formula: `${L(C['Työ €'])}+${L(C['Km €'])}+${L(C['Matka-aika €'])}+${L(C['Päiväraha lask. €'])}`, result: t.total,
      }
      row.getCell(C['Päiväraha']).value = e.per_diem === 'ei' ? '' : PER_DIEM_LABELS[e.per_diem]
      row.getCell(C['Päiväraha €']).value = t.perDiem || null
      row.getCell(C['Materiaalit (tilaajan)']).value = (e.materials || []).map(m => `${m.nimi} ${String(num(m.maara)).replace('.', ',')} ${m.yksikko}`).join('\n')
      row.getCell(C['Lisätieto']).value = e.notes || ''
      row.getCell(C['Laskutettu']).value = e.invoiced_at ? d(e.invoiced_at.slice(0, 10)) : ''
      row.getCell(C['Laskutettu']).numFmt = 'd.m.yyyy'
      for (const k of ['€/h', 'Työ €', 'Km €', 'Matka-aika €', 'Päiväraha lask. €', 'Yhteensä alv 0', 'Päiväraha €']) row.getCell(C[k]).numFmt = EUR
      for (const k of ['Tunnit', 'Km']) row.getCell(C[k]).numFmt = NUM
      zebra(row, i, cols.length)
      row.getCell(C['Yhteensä alv 0']).font = { name: FONT, size: 10, bold: true }
    })
    const last = first + sorted.length - 1
    const tr = ws.getRow(last + 1)
    tr.getCell(1).value = 'Yhteensä'
    const sums = { 'Tunnit': NUM, 'Työ €': EUR, 'Km': NUM, 'Km €': EUR, 'Matka-aika €': EUR, 'Päiväraha lask. €': EUR, 'Yhteensä alv 0': EUR, 'Päiväraha €': EUR }
    for (const [k, fmt] of Object.entries(sums)) {
      const col = colL(C[k])
      let result = 0
      for (let r = first; r <= last; r++) {
        const v = ws.getCell(`${col}${r}`).value
        result += typeof v === 'number' ? v : (v && typeof v.result === 'number' ? v.result : 0)
      }
      tr.getCell(C[k]).value = { formula: sumF(col, first, last), result: round2(result) }
      tr.getCell(C[k]).numFmt = fmt
    }
    totalRow(tr, cols.length)
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: last, column: cols.length } }
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }
    styleSheet(ws)
  }

  // ---- 2) Laskurivit ---------------------------------------------------------
  {
    const ws = wb.addWorksheet('Laskurivit')
    const cols = [['Rivi', 38], ['Ajanjakso', 24], ['Määrä', 10], ['Yks.', 8], ['À-hinta', 12], ['Yhteensä', 14]]
    cols.forEach(([, w], i) => { ws.getColumn(i + 1).width = w })
    title(ws, `Laskurivit · ${mLabel}`, 'Laskuttamattomat päivät asiakkaittain, kopioi UKKO:hon', cols.length)
    let r = 4
    const byClient = new Map()
    for (const e of sorted.filter(e => !e.invoiced_at)) {
      if (!byClient.has(e.client_name)) byClient.set(e.client_name, [])
      byClient.get(e.client_name).push(e)
    }
    if (!byClient.size) {
      ws.getCell(r, 1).value = 'Kaikki kuukauden päivät on merkitty laskutetuiksi.'
    }
    for (const [client, list] of byClient) {
      const inv = buildInvoice(list, settings)
      ws.mergeCells(r, 1, r, cols.length)
      const h = ws.getCell(r, 1)
      h.value = client
      h.font = { name: FONT, size: 13, bold: true, color: { argb: BLUE } }
      r += 1
      for (const line of clientInfoLines(clientFor(client, list))) {
        ws.mergeCells(r, 1, r, cols.length)
        ws.getCell(r, 1).value = line
        ws.getCell(r, 1).font = { name: FONT, size: 9, color: { argb: 'FF475569' } }
        r += 1
      }
      for (const cls of ['kaannetty', 'alv']) {
        const g = inv[cls]
        if (!g) continue
        ws.mergeCells(r, 1, r, cols.length)
        ws.getCell(r, 1).value = cls === 'kaannetty'
          ? 'Rakentamispalvelu, alv 0 % (käännetty verovelvollisuus, AVL 8 c §)'
          : `Palvelut, alv ${String(settings.vatPct).replace('.', ',')} %`
        ws.getCell(r, 1).font = { name: FONT, size: 10, bold: true, color: { argb: 'FF334155' } }
        r += 1
        header(ws, r, cols.map(c => c[0]))
        r += 1
        const from = r
        g.lines.forEach((l, i) => {
          const row = ws.getRow(r)
          row.getCell(1).value = l.desc
          row.getCell(2).value = l.period
          row.getCell(3).value = l.qty
          row.getCell(3).numFmt = NUM
          row.getCell(4).value = l.unit
          row.getCell(5).value = l.price
          row.getCell(5).numFmt = EUR
          row.getCell(6).value = { formula: `ROUND(C${r}*E${r},2)`, result: l.total }
          row.getCell(6).numFmt = EUR
          zebra(row, i, cols.length)
          r += 1
        })
        const tr = ws.getRow(r)
        tr.getCell(1).value = 'Yhteensä alv 0'
        tr.getCell(6).value = { formula: sumF('F', from, r - 1), result: g.net }
        tr.getCell(6).numFmt = EUR
        totalRow(tr, cols.length)
        const netRef = `F${r}`
        r += 1
        if (cls === 'alv') {
          const vr = ws.getRow(r)
          vr.getCell(1).value = `ALV ${String(settings.vatPct).replace('.', ',')} %`
          vr.getCell(6).value = { formula: `ROUND(${netRef}*${num(settings.vatPct) / 100},2)`, result: g.vat }
          vr.getCell(6).numFmt = EUR
          r += 1
          const gr = ws.getRow(r)
          gr.getCell(1).value = 'Yhteensä verollinen'
          gr.getCell(6).value = { formula: `${netRef}+F${r - 1}`, result: g.gross }
          gr.getCell(6).numFmt = EUR
          gr.getCell(1).font = gr.getCell(6).font = { name: FONT, size: 10, bold: true }
          r += 1
        } else {
          ws.getCell(r, 1).value = 'Laskulle: ALV 0 %, merkintä "Käännetty verovelvollisuus, AVL 8 c §" ja asiakkaan Y-tunnus.'
          ws.getCell(r, 1).font = { name: FONT, size: 9, italic: true, color: { argb: 'FF64748B' } }
          r += 1
        }
        r += 1
      }
      if (inv.materials?.length) {
        ws.getCell(r, 1).value = 'Käytetyt materiaalit (tilaajan omat, ei laskuteta)'
        ws.getCell(r, 1).font = { name: FONT, size: 10, bold: true, color: { argb: 'FF334155' } }
        r += 1
        inv.materials.forEach((m, i) => {
          const row = ws.getRow(r)
          row.getCell(1).value = m.name
          row.getCell(2).value = m.site
          row.getCell(3).value = m.qty
          row.getCell(3).numFmt = NUM
          row.getCell(4).value = m.unit
          zebra(row, i, 4)
          r += 1
        })
        r += 1
      }
      r += 1
    }
    styleSheet(ws)
  }

  // ---- 3) Matkalasku ---------------------------------------------------------
  {
    const claim = buildTravelClaim(sorted, settings, trips)
    const ws = wb.addWorksheet('Matkalasku')
    const cols = [['Päivä', 11], ['Kohde', 30], ['Asiakas', 18], ['Km', 8], ['Km-korvaus', 12], ['Päiväraha', 16], ['Päiväraha €', 12], ['Yhteensä', 12]]
    cols.forEach(([, w], i) => { ws.getColumn(i + 1).width = w })
    title(ws, `Matkalasku · ${mLabel}`, `Korpnex Oy maksaa verovapaasti · km-korvaus ${String(settings.ownKmRate).replace('.', ',')} €/km`, cols.length)
    ws.getCell('J4').value = '€/km'
    ws.getCell('K4').value = num(settings.ownKmRate)
    ws.getCell('K4').numFmt = EUR
    ws.getCell('J4').font = { name: FONT, size: 9, color: { argb: 'FF64748B' } }
    header(ws, 5, cols.map(c => c[0]))
    const first = 6
    claim.rows.forEach((x, i) => {
      const r = first + i
      const row = ws.getRow(r)
      row.getCell(1).value = d(x.date)
      row.getCell(1).numFmt = 'd.m.yyyy'
      row.getCell(2).value = x.site
      row.getCell(3).value = x.client
      row.getCell(4).value = x.km || null
      row.getCell(4).numFmt = NUM
      row.getCell(5).value = x.km ? { formula: `ROUND(D${r}*$K$4,2)`, result: x.kmEur } : null
      row.getCell(5).numFmt = EUR
      row.getCell(6).value = x.pdEur ? PER_DIEM_LABELS[x.perDiem] : ''
      row.getCell(7).value = x.pdEur || null
      row.getCell(7).numFmt = EUR
      row.getCell(8).value = { formula: `E${r}+G${r}`, result: round2(x.kmEur + x.pdEur) }
      row.getCell(8).numFmt = EUR
      zebra(row, i, cols.length)
    })
    const last = first + claim.rows.length - 1
    const tr = ws.getRow(last + 1)
    tr.getCell(1).value = 'Yhteensä'
    const res = { D: claim.km, E: claim.kmEur, G: claim.pdEur, H: claim.total }
    for (const [col, v] of Object.entries(res)) {
      tr.getCell(col).value = { formula: sumF(col, first, Math.max(first, last)), result: v }
      tr.getCell(col).numFmt = col === 'D' ? NUM : EUR
    }
    totalRow(tr, cols.length)
    ws.getCell(last + 3, 1).value = 'Päiväraha edellyttää yli 15 km matkaa kotoa sekä yli 6 h (osa) tai yli 10 h (koko) kestoa kotoa lähdöstä paluuseen.'
    ws.getCell(last + 3, 1).font = { name: FONT, size: 9, italic: true, color: { argb: 'FF64748B' } }
    styleSheet(ws)
  }

  // ---- 4) Ajopäiväkirja -----------------------------------------------------
  {
    const log = buildDriveLog(sorted, trips, sites, settings.homeAddress)
    const ws = wb.addWorksheet('Ajopäiväkirja', { views: [{ state: 'frozen', ySplit: 4 }] })
    const cols = [['Päivä', 11], ['Lähtö', 7], ['Paluu', 7], ['Mittari alussa', 12], ['Mittari lopussa', 12], ['Km', 8], ['Reitti', 46], ['Tarkoitus', 40], ['Tyyppi', 13]]
    cols.forEach(([, w], i) => { ws.getColumn(i + 1).width = w })
    title(ws, `Ajopäiväkirja · ${mLabel}`, `Työajot omalla autolla${settings.vehicle ? ` (${settings.vehicle})` : ''}${settings.travelName ? ` · ${settings.travelName}` : ''}`, cols.length)
    header(ws, 4, cols.map(c => c[0]))
    let r = 5, i = 0
    const first = r
    for (const x of log.rows.filter(x => !x.open)) {
      if (x.privateBefore > 0) {
        ws.mergeCells(r, 1, r, cols.length)
        ws.getCell(r, 1).value = `Yksityisajoa välissä ${x.privateBefore} km (ei korvauksiin)`
        ws.getCell(r, 1).font = { name: FONT, size: 9, italic: true, color: { argb: 'FF94A3B8' } }
        r += 1
      }
      const row = ws.getRow(r)
      row.getCell(1).value = d(x.date); row.getCell(1).numFmt = 'd.m.yyyy'
      row.getCell(2).value = fmtTime(x.start)
      row.getCell(3).value = fmtTime(x.end)
      row.getCell(4).value = x.odoStart ?? null; row.getCell(4).numFmt = '#,##0'
      row.getCell(5).value = x.odoEnd ?? null; row.getCell(5).numFmt = '#,##0'
      row.getCell(6).value = x.odoStart != null && x.odoEnd != null ? { formula: `E${r}-D${r}`, result: x.km } : x.km
      row.getCell(6).numFmt = NUM
      row.getCell(7).value = x.route
      row.getCell(8).value = x.purpose
      row.getCell(9).value = x.source === 'ajo' ? 'Erillinen ajo' : 'Työpäivä'
      zebra(row, i++, cols.length)
      r += 1
    }
    const tr = ws.getRow(r)
    tr.getCell(1).value = 'Työajoa yhteensä'
    tr.getCell(6).value = { formula: `SUM(F${first}:F${Math.max(first, r - 1)})`, result: log.businessKm }
    tr.getCell(6).numFmt = NUM
    totalRow(tr, cols.length)
    if (log.privateKm) {
      ws.getCell(r + 1, 1).value = `Yksityisajoa työajojen välissä yhteensä ${log.privateKm} km (ei korvauksiin)`
      ws.getCell(r + 1, 1).font = { name: FONT, size: 9, italic: true, color: { argb: 'FF64748B' } }
    }
    styleSheet(ws)
  }

  // ---- 5) Materiaalit --------------------------------------------------------
  {
    const usage = buildMaterialUsage(sorted)
    const ws = wb.addWorksheet('Materiaalit')
    const cols = [['Työmaa', 30], ['Materiaali', 30], ['Määrä', 10], ['Yks.', 10]]
    cols.forEach(([, w], i) => { ws.getColumn(i + 1).width = w })
    title(ws, `Materiaalit · ${mLabel}`, 'Tilaajan omat tuotteet, kulutus työmaittain (ei laskuteta)', cols.length)
    header(ws, 4, cols.map(c => c[0]))
    if (!usage.length) ws.getCell(5, 1).value = 'Ei kirjattuja materiaaleja.'
    usage.forEach((u, i) => {
      const row = ws.getRow(5 + i)
      row.getCell(1).value = i === 0 || usage[i - 1].site !== u.site ? u.site : ''
      row.getCell(2).value = u.name
      row.getCell(3).value = u.qty
      row.getCell(3).numFmt = NUM
      row.getCell(4).value = u.unit
      zebra(row, i, cols.length)
    })
    styleSheet(ws)
  }

  return wb
}

// Selaimessa: ExcelJS ladataan vasta kun nappia painetaan (ei kasvata sovellusta)
export async function downloadWorkbook(entries, settings, month, clients = [], sites = [], trips = []) {
  const mod = await import('exceljs/dist/exceljs.min.js')
  const ExcelJS = mod.default || mod
  const wb = buildWorkbook(ExcelJS, entries, settings, month, clients, sites, trips)
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Korpnex-tyoajat-${month}.xlsx`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
