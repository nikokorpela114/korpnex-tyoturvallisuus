// src/finalReport.js — työmaan loppuraportti (PDF) ja Excel-vienti (CSV).
//
// Kokoaa koko työmaan ajalta: avainluvut, TR-/MVR-indeksin kehityksen,
// urakoitsijavertailun, yleisimmät aiheet, avoimeksi jääneet puutteet ja
// koko havaintoluettelon (valinnaisesti kuvineen).
import {
  TR_CATEGORIES, MVR_CATEGORIES, overallIndex, contractorStats, fmtDays,
} from './shared.js'

const NAVY = [10, 20, 40], BLUE = [8, 120, 232], INK = [15, 23, 42], MUTED = [100, 116, 139], LINE = [227, 232, 239]
const RED = [220, 38, 38], AMBER = [217, 119, 6], GREEN = [5, 150, 105]
const fmt = d => d ? new Date(d).toLocaleDateString('fi-FI') : ''
const statusFi = s => s === 'korjattu' ? 'Korjattu' : s === 'kuitattu' ? 'Kuitattu' : s === 'tiedoksi' ? 'Tiedoksi' : 'Avoin'

export async function buildFinalReportPDF({ site, clientName, obs, trRows, mvrRows, photoLoader, onProgress }) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210, M = 16, CW = W - M * 2
  let y = 0
  const today = new Date().toLocaleDateString('fi-FI')

  const sorted = obs.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const allDates = [...sorted.map(o => o.created_at), ...trRows.map(r => r.created_at), ...mvrRows.map(r => r.created_at)].filter(Boolean).map(d => new Date(d).getTime())
  const from = allDates.length ? new Date(Math.min(...allDates)) : null
  const to = allDates.length ? new Date(Math.max(...allDates)) : null
  const rounds = new Set([
    ...sorted.map(o => o.report_id || new Date(o.created_at).toDateString()),
    ...[...trRows, ...mvrRows].map(r => r.report_id || new Date(r.created_at).toDateString()),
  ]).size
  const fixed = sorted.filter(o => o.status === 'korjattu')
  const openList = sorted.filter(o => o.status === 'avoin' || o.status === 'kuitattu')
  const needFix = sorted.filter(o => o.status !== 'tiedoksi')
  const fixDays = fixed.filter(o => o.fixed_at).map(o => (new Date(o.fixed_at) - new Date(o.created_at)) / 864e5)
  const avgFix = fixDays.length ? fixDays.reduce((a, b) => a + b, 0) / fixDays.length : null
  const crit = sorted.filter(o => o.sev === 'Kriittinen').length

  const pageTop = () => { y = 20 }
  const ensure = n => { if (y + n > 280) { doc.addPage(); pageTop() } }
  const h2 = (t, sub) => {
    ensure(22)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...NAVY); doc.text(t, M, y)
    if (sub) { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED); doc.text(sub, M, y + 5.5); y += 5.5 }
    y += 4; doc.setDrawColor(...BLUE); doc.setLineWidth(0.8); doc.line(M, y, M + 14, y); doc.setLineWidth(0.2); y += 7
  }
  const tableHead = (cols) => {
    doc.setFillColor(241, 244, 249); doc.rect(M, y, CW, 7.5, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.8); doc.setTextColor(...MUTED)
    cols.forEach(c => doc.text(c.t.toUpperCase(), c.align === 'right' ? M + c.x : M + c.x, y + 5, { align: c.align || 'left' }))
    y += 7.5
  }

  // --- Kansilehti -----------------------------------------------------------
  doc.setFillColor(...NAVY); doc.rect(0, 0, W, 118, 'F')
  doc.setFillColor(...BLUE); doc.rect(0, 118, W, 2.2, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(255, 255, 255)
  doc.text('K O R P N E X', M, 24)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(124, 200, 255)
  doc.text('TYÖTURVALLISUUS', M, 30)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(28); doc.setTextColor(255, 255, 255)
  doc.text('Työmaan turvallisuus-', M, 66); doc.text('yhteenveto', M, 78)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(200, 214, 235)
  doc.text(site || '', M, 94)
  if (clientName) { doc.setFontSize(10); doc.setTextColor(160, 178, 205); doc.text(clientName, M, 101) }

  y = 136
  const meta = [
    ['Aikaväli', from ? `${fmt(from)} – ${fmt(to)}` : '–'],
    ['Tarkastuskierroksia', String(rounds)],
    ['Havaintoja yhteensä', String(sorted.length)],
    ['TR-mittauksia / MVR-mittauksia', `${trRows.length} / ${mvrRows.length}`],
    ['Raportti laadittu', today],
  ]
  meta.forEach(([k, v]) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED); doc.text(k, M, y)
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK); doc.text(v, M + 70, y)
    y += 8
  })

  // Avainluvut
  y += 6
  const kpis = [
    ['Havainnot', String(sorted.length), INK],
    ['Kriittiset', String(crit), crit ? RED : INK],
    ['Korjattu', needFix.length ? `${Math.round(fixed.length / needFix.length * 100)} %` : '–', GREEN],
    ['Korjausaika ka.', avgFix == null ? '–' : `${fmtDays(avgFix)} pv`, INK],
    ['Avoinna', String(openList.length), openList.length ? AMBER : GREEN],
  ]
  const kw = (CW - 4 * 4) / 5
  kpis.forEach(([l, v, c], i) => {
    const x = M + i * (kw + 4)
    doc.setDrawColor(...LINE); doc.setFillColor(248, 250, 252); doc.roundedRect(x, y, kw, 24, 2, 2, 'FD')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...c); doc.text(v, x + 4, y + 11)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(...MUTED); doc.text(l, x + 4, y + 18.5)
  })
  y += 34

  const latest = rows => rows[0] ? overallIndex(rows[0].counts, rows === trRows ? TR_CATEGORIES : MVR_CATEGORIES).pct : null
  const firstIdx = rows => rows.length ? overallIndex(rows[rows.length - 1].counts, rows === trRows ? TR_CATEGORIES : MVR_CATEGORIES).pct : null
  const idxLine = []
  if (trRows.length) idxLine.push(`TR ${firstIdx(trRows)} % -> ${latest(trRows)} %`)
  if (mvrRows.length) idxLine.push(`MVR ${firstIdx(mvrRows)} % -> ${latest(mvrRows)} %`)
  if (idxLine.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...INK)
    doc.text(`Turvallisuusindeksi ensimmäisestä viimeiseen mittaukseen: ${idxLine.join(' · ')}`, M, y, { maxWidth: CW })
  }

  // --- Indeksin kehitys ----------------------------------------------------
  const series = [
    { name: 'TR', col: BLUE, pts: trRows.filter(r => r.index_pct != null).map(r => [new Date(r.created_at).getTime(), Number(r.index_pct)]).reverse() },
    { name: 'MVR', col: [6, 182, 212], pts: mvrRows.filter(r => r.index_pct != null).map(r => [new Date(r.created_at).getTime(), Number(r.index_pct)]).reverse() },
  ].filter(s => s.pts.length)
  doc.addPage(); pageTop()
  if (series.length && series.flatMap(s => s.pts).length >= 2) {
    h2('Turvallisuusindeksin kehitys', 'TR-/MVR-mittausten kokonaisindeksi (oikein / kaikki havainnot). Katkoviiva = tavoite 90 %.')
    const pts = series.flatMap(s => s.pts)
    const t0 = Math.min(...pts.map(p => p[0])), t1 = Math.max(...pts.map(p => p[0]))
    const vMin = Math.max(0, Math.floor((Math.min(...pts.map(p => p[1])) - 5) / 10) * 10)
    const cx = M + 10, cw = CW - 12, ch = 62, cy = y
    const X = t => cx + (t1 === t0 ? cw / 2 : (t - t0) / (t1 - t0) * cw)
    const Y = v => cy + ch - (v - vMin) / (100 - vMin) * ch
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5)
    for (let v = vMin; v <= 100; v += 10) {
      doc.setDrawColor(...LINE); doc.line(cx, Y(v), cx + cw, Y(v))
      doc.setTextColor(...MUTED); doc.text(String(v), cx - 2, Y(v) + 1, { align: 'right' })
    }
    if (vMin < 90) { doc.setDrawColor(...GREEN); doc.setLineDashPattern([1.5, 1.5], 0); doc.line(cx, Y(90), cx + cw, Y(90)); doc.setLineDashPattern([], 0) }
    series.forEach(s => {
      doc.setDrawColor(...s.col); doc.setLineWidth(0.7)
      for (let i = 1; i < s.pts.length; i++) doc.line(X(s.pts[i - 1][0]), Y(s.pts[i - 1][1]), X(s.pts[i][0]), Y(s.pts[i][1]))
      doc.setFillColor(255, 255, 255)
      s.pts.forEach(p => doc.circle(X(p[0]), Y(p[1]), 0.9, 'FD'))
      doc.setLineWidth(0.2)
    })
    doc.setTextColor(...MUTED); doc.text(fmt(t0), cx, cy + ch + 5); doc.text(fmt(t1), cx + cw, cy + ch + 5, { align: 'right' })
    let lx = cx
    series.forEach(s => { doc.setFillColor(...s.col); doc.rect(lx, cy + ch + 9, 3, 3, 'F'); doc.setTextColor(...INK); doc.text(s.name, lx + 4.5, cy + ch + 11.5); lx += 20 })
    y = cy + ch + 20
  }

  // --- Urakoitsijavertailu --------------------------------------------------
  const cs = contractorStats(sorted).sort((a, b) => b.total - a.total)
  if (cs.length) {
    h2('Urakoitsijavertailu', 'Havainnot koko työmaan ajalta urakoitsijoittain.')
    const cols = [{ t: 'Urakoitsija', x: 2 }, { t: 'Yht.', x: 76, align: 'right' }, { t: 'Kriitt.', x: 92, align: 'right' }, { t: 'Huomio', x: 108, align: 'right' }, { t: 'Info', x: 120, align: 'right' }, { t: 'Korjattu', x: 138, align: 'right' }, { t: 'Avoin', x: 152, align: 'right' }, { t: 'Korj.aika', x: CW - 2, align: 'right' }]
    tableHead(cols)
    const maxT = Math.max(...cs.map(r => r.total))
    cs.forEach((r, i) => {
      ensure(9)
      if (i % 2) { doc.setFillColor(250, 251, 253); doc.rect(M, y, CW, 9, 'F') }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...INK)
      doc.text(doc.splitTextToSize(r.name, 54)[0], M + 2, y + 4.4)
      doc.setFillColor(230, 238, 250); doc.rect(M + 2, y + 6, 52, 1.2, 'F')
      doc.setFillColor(...BLUE); doc.rect(M + 2, y + 6, 52 * r.total / maxT, 1.2, 'F')
      doc.setFont('helvetica', 'normal')
      const cell = (v, x, c = INK) => { doc.setTextColor(...c); doc.text(String(v), M + x, y + 5.5, { align: 'right' }) }
      cell(r.total, 76); cell(r.Kriittinen, 92, r.Kriittinen ? RED : MUTED); cell(r.Huomio, 108, AMBER); cell(r.Info, 120, GREEN)
      cell(r.korjattu, 138, GREEN); cell(r.avoin + r.kuitattu, 152, r.avoin + r.kuitattu ? AMBER : MUTED)
      cell(r.avgFix == null ? '–' : `${fmtDays(r.avgFix)} pv`, CW - 2)
      y += 9
    })
    y += 8
  }

  // --- Yleisimmät aiheet ----------------------------------------------------
  const topics = {}
  sorted.forEach(o => { const k = o.luokka || 'Ei luokiteltu'; topics[k] = (topics[k] || 0) + 1 })
  const tlist = Object.entries(topics).sort((a, b) => b[1] - a[1])
  if (tlist.length && !(tlist.length === 1 && tlist[0][0] === 'Ei luokiteltu')) {
    h2('Yleisimmät aiheet', 'Havaintojen jakautuminen aihepiireittäin.')
    const maxN = tlist[0][1]
    tlist.forEach(([k, n]) => {
      ensure(8)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK); doc.text(k, M, y + 4)
      doc.setFillColor(238, 241, 246); doc.roundedRect(M + 58, y, CW - 82, 5.5, 1, 1, 'F')
      doc.setFillColor(...(k === 'Ei luokiteltu' ? [203, 211, 223] : BLUE)); doc.roundedRect(M + 58, y, Math.max(1.5, (CW - 82) * n / maxN), 5.5, 1, 1, 'F')
      doc.setFont('helvetica', 'bold'); doc.text(`${n}  (${Math.round(n / sorted.length * 100)} %)`, M + CW, y + 4, { align: 'right' })
      y += 8
    })
    y += 6
  }

  // --- Avoimeksi jääneet ----------------------------------------------------
  h2('Avoinna olevat puutteet', openList.length ? `${openList.length} kpl raportin laatimishetkellä.` : 'Kaikki havainnot on korjattu.')
  if (openList.length) {
    openList.forEach(o => {
      const lines = doc.splitTextToSize(o.havainto || '(ei kuvausta)', CW - 40)
      ensure(lines.length * 4.6 + 7)
      const c = o.sev === 'Kriittinen' ? RED : o.sev === 'Huomio' ? AMBER : GREEN
      doc.setFillColor(...c); doc.circle(M + 1.5, y + 2.6, 1.3, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...INK); doc.text(lines, M + 5, y + 3.6)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED)
      doc.text(`${fmt(o.created_at)}${o.status === 'kuitattu' ? ' · kuitattu' : ''}`, M + CW, y + 3.6, { align: 'right' })
      y += lines.length * 4.6
      doc.text([o.yritys, o.luokka, o.due_date && `määräaika ${fmt(o.due_date)}`].filter(Boolean).join(' · ') || ' ', M + 5, y + 3)
      y += 7
    })
  }

  // --- Liite: havaintoluettelo ---------------------------------------------
  doc.addPage(); pageTop()
  h2('Liite: havaintoluettelo', `Kaikki ${sorted.length} havaintoa aikajärjestyksessä.`)
  const lc = [{ t: 'Pvm', x: 2 }, { t: 'Havainto', x: 20 }, { t: 'Urakoitsija', x: 98 }, { t: 'Vakavuus', x: 136 }, { t: 'Tila', x: 156 }]
  tableHead(lc)
  for (let i = 0; i < sorted.length; i++) {
    const o = sorted[i]
    const h = doc.splitTextToSize(o.havainto || '(ei kuvausta)', 75)
    const yr = doc.splitTextToSize(o.yritys || '–', 36)
    const rowH = Math.max(h.length, yr.length) * 4.2 + 3
    if (y + rowH > 280) { doc.addPage(); pageTop(); tableHead(lc) }
    if (i % 2) { doc.setFillColor(250, 251, 253); doc.rect(M, y, CW, rowH, 'F') }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK)
    doc.text(fmt(o.created_at), M + 2, y + 4.4)
    doc.text(h, M + 20, y + 4.4)
    doc.text(yr, M + 98, y + 4.4)
    doc.setTextColor(...(o.sev === 'Kriittinen' ? RED : o.sev === 'Huomio' ? AMBER : GREEN)); doc.text(o.sev || '', M + 136, y + 4.4)
    doc.setTextColor(...(o.status === 'korjattu' ? GREEN : o.status === 'kuitattu' ? AMBER : o.status === 'tiedoksi' ? MUTED : RED))
    doc.text(statusFi(o.status) + (o.status === 'korjattu' && o.fixed_at ? ` ${fmt(o.fixed_at)}` : ''), M + 156, y + 4.4)
    y += rowH
  }

  // --- Liite: kuvat (valinnainen) -------------------------------------------
  if (photoLoader) {
    const withPhotos = sorted.filter(o => (o.photos || []).length || o.fix_photo)
    if (withPhotos.length) {
      doc.addPage(); pageTop()
      h2('Liite: kuvat', 'Ennen- ja jälkeen-kuvat havainnoittain.')
      for (let i = 0; i < withPhotos.length; i++) {
        const o = withPhotos[i]
        onProgress?.(`Kuvat ${i + 1} / ${withPhotos.length}`)
        const imgs = []
        for (const p of (o.photos || []).slice(0, 2)) { const s = await photoLoader(p.path); if (s) imgs.push([s, 'Ennen']) }
        if (o.fix_photo) { const s = await photoLoader(o.fix_photo); if (s) imgs.push([s, 'Jälkeen']) }
        if (!imgs.length) continue
        ensure(56)
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...INK)
        doc.text(doc.splitTextToSize(`${fmt(o.created_at)} · ${o.havainto || ''}${o.yritys ? ' · ' + o.yritys : ''}`, CW)[0], M, y + 3); y += 6
        const cw3 = (CW - 8) / 3
        for (let k = 0; k < imgs.length; k++) {
          const [src, label] = imgs[k]
          const dims = await new Promise(r => { const im = new Image(); im.onload = () => r([im.naturalWidth, im.naturalHeight]); im.onerror = () => r([4, 3]); im.src = src })
          const sc = Math.min(cw3 / dims[0], 44 / dims[1])
          const x = M + k * (cw3 + 4)
          try { doc.addImage(src, 'JPEG', x, y, dims[0] * sc, dims[1] * sc) } catch { /* ohita */ }
          doc.setFillColor(...NAVY); doc.rect(x, y, doc.getTextWidth(label) + 5, 5, 'F')
          doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(255, 255, 255); doc.text(label, x + 2.2, y + 3.5)
        }
        y += 48
      }
    }
  }

  // Alatunnisteet
  const tp = doc.getNumberOfPages()
  for (let p = 2; p <= tp; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(160, 170, 185)
    doc.text(`Korpnex Oy · Työmaan turvallisuusyhteenveto · ${site || ''}`, M, 290)
    doc.text(`${p} / ${tp}`, W - M, 290, { align: 'right' })
  }

  const safe = (site || 'tyomaa').replace(/[^\wäöåÄÖÅ-]+/g, '_')
  return { blob: doc.output('blob'), filename: `Loppuraportti_${safe}_${today.replace(/\./g, '-')}.pdf` }
}

// Excel avaa puolipisteellä erotetun CSV:n suoraan (BOM = ääkköset oikein).
export function buildObservationsCSV({ site, obs }) {
  const head = ['Päivämäärä', 'Työmaa', 'Havainto', 'Urakoitsija', 'Luokka', 'Vakavuus', 'Tila', 'Määräaika', 'Kuitattu', 'Kuittaaja', 'Kuittauksen kommentti', 'Korjattu', 'Korjausaika (pv)', 'Tarkastaja', 'Lisätieto']
  const q = v => {
    const s = v == null ? '' : String(v)
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = obs.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(o => [
    fmt(o.created_at), o.site || site, o.havainto, o.yritys, o.luokka, o.sev, statusFi(o.status), fmt(o.due_date),
    fmt(o.ack_at), o.ack_by_name, o.ack_comment, fmt(o.fixed_at),
    o.fixed_at ? fmtDays((new Date(o.fixed_at) - new Date(o.created_at)) / 864e5) : '', o.inspector, o.note,
  ])
  const csv = '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n')
  const safe = (site || 'tyomaa').replace(/[^\wäöåÄÖÅ-]+/g, '_')
  return { blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename: `Havainnot_${safe}.csv` }
}
