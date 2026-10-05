// src/shared.js — yhteiset vakiot ja apufunktiot.

// TR-mittari: talonrakennustyömaan viikoittainen turvallisuusmittaus.
// Perustuu Valtioneuvoston asetukseen rakennustyön turvallisuudesta
// (205/2009) ja työturvallisuuslakiin (738/2002) — yhteisellä rakennus-
// työmaalla vaadittu viikoittainen kunnostapitotarkastus voidaan tehdä
// TR-mittarilla, kun sitä käytetään säännöllisesti koko työn ajan.
// 7 vakioitua havaintoluokkaa (Rakennusteollisuus RT / Työterveyslaitos).
export const TR_CATEGORIES = [
  { key: 'tyoskentely', label: 'Työskentely', desc: 'Työtavat, henkilökohtaisten suojainten käyttö, työasennot, riskinotto' },
  { key: 'telineet', label: 'Telineet, kulkusillat ja tikkaat', desc: 'Telineiden, kulkusiltojen ja tikkaiden kunto ja turvallinen käyttö' },
  { key: 'koneet', label: 'Koneet ja välineet', desc: 'Koneiden ja käsityövälineiden kunto ja turvallinen käyttö' },
  { key: 'putoamissuojaus', label: 'Putoamissuojaus', desc: 'Kaiteet, suojakaiteet, putoamissuojaimet, aukkojen ja reunojen suojaus' },
  { key: 'sahko', label: 'Sähkö ja valaistus', desc: 'Sähkökeskukset, -johdot, -laitteet ja työkohteen valaistus' },
  { key: 'jarjestys', label: 'Järjestys ja jätehuolto', desc: 'Työmaan yleisjärjestys, kulkutiet, jätehuolto' },
  { key: 'poly', label: 'Pölyisyys', desc: 'Pölyntorjunta ja pölyisyyden hallinta' },
]
export const TR_LEGAL_NOTE =
  'TR-mittaus perustuu Valtioneuvoston asetukseen rakennustyön turvallisuudesta (205/2009) ja työturvallisuuslakiin (738/2002). ' +
  'Säännöllisesti tehtynä TR-mittaus täyttää yhteisen rakennustyömaan viikoittaisen kunnossapitotarkastuksen vaatimuksen.'

// MVR-mittari: maa- ja vesirakennustyömaan viikoittainen turvallisuusmittaus.
// Sama lakiperusta kuin TR-mittarilla, sovellettuna infratyömaan omiin
// riskeihin. 5 vakioitua havaintoluokkaa (Rakennusteollisuus RT).
export const MVR_CATEGORIES = [
  { key: 'tyoskentely_koneet', label: 'Työskentely ja koneenkäyttö', desc: 'Työmenetelmien turvallisuus, suojainten käyttö, koneiden käyttötavat' },
  { key: 'kalusto', label: 'Kalusto', desc: 'Koneiden, laitteiden ja kaluston kunto sekä sähköturvallisuus ja valaistus' },
  { key: 'suojaukset', label: 'Suojaukset ja varoalueet', desc: 'Putoamissuojaus, kaivantojen tuenta, koneiden vaara-alueiden merkintä' },
  { key: 'kulkuvaylat', label: 'Ajo- ja kulkuväylät', desc: 'Työmaaliikenne, kulkuväylien kunto ja merkintä, opasteet' },
  { key: 'jarjestys_varastointi', label: 'Järjestys ja varastointi', desc: 'Yleisjärjestys, jätehuolto, materiaalien ja vaarallisten aineiden varastointi' },
]
export const MVR_LEGAL_NOTE =
  'MVR-mittaus perustuu Valtioneuvoston asetukseen rakennustyön turvallisuudesta (205/2009) ja työturvallisuuslakiin (738/2002), ' +
  'sovellettuna maa- ja vesirakennustyömaan olosuhteisiin. Säännöllisesti tehtynä MVR-mittaus täyttää yhteisen työmaan viikoittaisen ' +
  'kunnossapitotarkastuksen vaatimuksen.'

// Tyhjä laskuri jokaiselle luokka-avaimelle:
// { [key]: { oikein, vaarin, notes: [] } }
// notes-taulukko vastaa virallisen TR-/MVR-lomakkeen
// "Huomautukset / Vastuuhenkilö / Korjattu pvm" -saraketta: jokainen
// väärin-havainto voidaan tarvittaessa dokumentoida erikseen.
export function emptyCounts(categories) {
  const o = {}
  categories.forEach(c => { o[c.key] = { oikein: 0, vaarin: 0, notes: [] } })
  return o
}

function noteId() {
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

// Lisää tyhjän puute-rivin annettuun kategoriaan. Palauttaa UUDEN counts-
// objektin (ei mutatoi alkuperäistä) — sopii suoraan setStateen.
export function addNote(counts, catKey) {
  const cur = counts[catKey] || { oikein: 0, vaarin: 0, notes: [] }
  const notes = [...(cur.notes || []), {
    id: noteId(), desc: '', vastuuhenkilo: '', korjattu: false, korjattuPvm: '',
  }]
  return { ...counts, [catKey]: { ...cur, notes } }
}

// Päivittää yhden puute-rivin kentän (desc / vastuuhenkilo / korjattu /
// korjattuPvm). patch on osittainen objekti, esim. { desc: 'uusi teksti' }.
export function updateNote(counts, catKey, id, patch) {
  const cur = counts[catKey] || { oikein: 0, vaarin: 0, notes: [] }
  const notes = (cur.notes || []).map(n => n.id === id ? { ...n, ...patch } : n)
  return { ...counts, [catKey]: { ...cur, notes } }
}

// Poistaa yhden puute-rivin.
export function removeNote(counts, catKey, id) {
  const cur = counts[catKey] || { oikein: 0, vaarin: 0, notes: [] }
  const notes = (cur.notes || []).filter(n => n.id !== id)
  return { ...counts, [catKey]: { ...cur, notes } }
}

// Yhden luokan tulos prosentteina (null jos ei yhtään havaintoa vielä)
export function categoryPct(counts) {
  const total = (counts?.oikein || 0) + (counts?.vaarin || 0)
  if (!total) return null
  return Math.round(((counts.oikein / total) * 1000)) / 10
}

// Koko mittauksen kokonaisindeksi (oikein / (oikein+väärin) * 100) ja
// havaintojen kokonaismäärä kaikista luokista yhteensä.
export function overallIndex(countsObj, categories) {
  let oikein = 0, vaarin = 0
  categories.forEach(c => {
    oikein += countsObj[c.key]?.oikein || 0
    vaarin += countsObj[c.key]?.vaarin || 0
  })
  const total = oikein + vaarin
  return { oikein, vaarin, total, pct: total ? Math.round((oikein / total) * 1000) / 10 : null }
}

export function indexColor(pct) {
  if (pct == null) return '#9aa2c0'
  if (pct >= 90) return '#1a8a50'
  if (pct >= 75) return '#d07800'
  return '#d63030'
}

export const SEV_LABELS = ['Kriittinen', 'Huomio', 'Info']

// Havainnon luokka — samat aihepiirit kuin TR-mittarissa + suojaimet ja muu.
// Näiden avulla nähdään mikä toistuu (esim. "60 % putoamissuojausta").
export const OBS_CATEGORIES = [
  'Putoamissuojaus', 'Telineet ja tikkaat', 'Suojaimet ja työtavat', 'Koneet ja laitteet',
  'Sähkö ja valaistus', 'Järjestys ja kulkutiet', 'Pöly ja kemikaalit', 'Muu',
]

const DAY = 864e5
// Viikon maanantai (paikallista aikaa) aikaleimana.
export function weekStart(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x.getTime()
}
export function isoWeek(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const w1 = new Date(d.getFullYear(), 0, 4)
  return 1 + Math.round(((d - w1) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7)
}

// Urakoitsijakohtaiset tunnusluvut havainnoista.
export function contractorStats(obs, weeks = 12) {
  const now = Date.now()
  const lastWeek = weekStart(now)
  const map = new Map()
  for (const o of obs) {
    const name = (o.yritys || '').trim() || 'Ei merkitty'
    if (!map.has(name)) map.set(name, { name, total: 0, Kriittinen: 0, Huomio: 0, Info: 0, avoin: 0, kuitattu: 0, korjattu: 0, tiedoksi: 0, myohassa: 0, fixDays: [], luokat: {}, weekly: new Array(weeks).fill(0), obs: [] })
    const r = map.get(name)
    r.total++; r.obs.push(o)
    if (r[o.sev] != null) r[o.sev]++
    const st = ['korjattu', 'kuitattu', 'tiedoksi'].includes(o.status) ? o.status : 'avoin'
    r[st]++
    if (o.due_date && (st === 'avoin' || st === 'kuitattu') && new Date(o.due_date + 'T23:59:59') < new Date()) r.myohassa++
    if (st === 'korjattu' && o.fixed_at && o.created_at) r.fixDays.push((new Date(o.fixed_at) - new Date(o.created_at)) / DAY)
    if (o.luokka) r.luokat[o.luokka] = (r.luokat[o.luokka] || 0) + 1
    const wi = weeks - 1 - Math.round((lastWeek - weekStart(o.created_at)) / (7 * DAY))
    if (wi >= 0 && wi < weeks) r.weekly[wi]++
  }
  return [...map.values()].map(r => ({
    ...r,
    avgFix: r.fixDays.length ? r.fixDays.reduce((a, b) => a + b, 0) / r.fixDays.length : null,
    topLuokat: Object.entries(r.luokat).sort((a, b) => b[1] - a[1]),
  }))
}

export const fmtDays = v => v == null ? '–' : v.toFixed(1).replace('.', ',')

// Kokoaa havainnoista yhteenvedon: kokonaismäärät vakavuuksittain ja tilan
// mukaan, sekä erittely urakoitsijoittain (yritys-kentän mukaan). Käytetään
// sekä Valvomon Yhteenveto-välilehdellä että PDF-raportissa, jotta pitkänkin
// työmaan koko historiasta näkee heti mistä puutteet tulevat, kuinka paljon
// niitä on, ja kuinka moni on vielä korjaamatta.
export function summarizeObservations(obs) {
  const bySev = { Kriittinen: 0, Huomio: 0, Info: 0 }
  const byStatus = { avoin: 0, kuitattu: 0, korjattu: 0, tiedoksi: 0 }
  const yritysMap = new Map()
  for (const o of obs) {
    const sev = bySev[o.sev] != null ? o.sev : null
    if (sev) bySev[sev]++
    const status = ['korjattu', 'kuitattu', 'tiedoksi'].includes(o.status) ? o.status : 'avoin'
    byStatus[status]++
    const yritys = (o.yritys || '').trim() || 'Ei merkitty'
    if (!yritysMap.has(yritys)) {
      yritysMap.set(yritys, { yritys, total: 0, Kriittinen: 0, Huomio: 0, Info: 0, avoin: 0, kuitattu: 0, korjattu: 0, tiedoksi: 0 })
    }
    const row = yritysMap.get(yritys)
    row.total++
    if (sev) row[sev]++
    row[status]++
  }
  const byYritys = [...yritysMap.values()].sort((a, b) => b.total - a.total)
  return { total: obs.length, bySev, byStatus, byYritys }
}

// Rakentaa PDF-raportin (TR-/MVR-mittaus + havainnot) samalla ulkoasulla
// riippumatta siitä kutsutaanko tätä tarkastuksen puhelinnäkymästä (yhden
// työmaan senhetkinen luonnos, kuvat mukana) vai Valvomosta (pilvestä haettu
// työmaan koko data useammalta laitteelta koottuna, ei kuvia). Palauttaa
// { blob, filename }.
export async function buildReportPDF({ site, inspector, trCounts, mvrCounts, obs }) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210, M = 14, CW = W - M * 2
  let y = 18
  const dateStr = new Date().toLocaleDateString('fi-FI')

  doc.setFillColor(10, 20, 40)
  doc.rect(0, 0, W, 28, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(199, 203, 214)
  doc.text('KORPNEX', M, 12)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(255, 255, 255)
  doc.text('Työturvallisuusraportti', M, 19)
  doc.setFontSize(9); doc.setTextColor(190, 196, 220)
  doc.text(dateStr, W - M, 12, { align: 'right' })
  y = 38

  const meta = [['Työmaa / kohde', site || '–'], ['Tarkastaja', inspector || '–']]
  meta.forEach(([k, v]) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100, 105, 125); doc.text(k, M, y)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(20, 24, 58); doc.text(v, M + 40, y)
    y += 6
  })
  y += 3; doc.setDrawColor(200, 203, 215); doc.line(M, y, W - M, y); y += 9

  const ensureSpace = (needed) => { if (y + needed > 278) { doc.addPage(); y = 18 } }

  const drawMeasurement = (title, categories, counts, legalNote) => {
    const { pct, total } = overallIndex(counts, categories)
    if (!total) return
    ensureSpace(16)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(10, 20, 40)
    doc.text(title, M, y); y += 2
    const col = pct >= 90 ? [26, 138, 80] : pct >= 75 ? [208, 120, 0] : [214, 48, 48]
    doc.setFillColor(...col)
    doc.roundedRect(W - M - 34, y - 7, 34, 11, 1.5, 1.5, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(255, 255, 255)
    doc.text(`${pct} %`, W - M - 17, y + 0.5, { align: 'center' })
    y += 8

    doc.setFillColor(238, 240, 245)
    doc.rect(M, y, CW, 7, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(100, 105, 125)
    doc.text('Havaintoluokka', M + 2, y + 4.8)
    doc.text('Oikein', M + CW - 62, y + 4.8, { align: 'right' })
    doc.text('Väärin', M + CW - 34, y + 4.8, { align: 'right' })
    doc.text('%', M + CW - 2, y + 4.8, { align: 'right' })
    y += 7
    categories.forEach((c, i) => {
      ensureSpace(8)
      const cnt = counts[c.key] || { oikein: 0, vaarin: 0, notes: [] }
      const cpct = categoryPct(cnt)
      if (i % 2 === 1) { doc.setFillColor(247, 248, 250); doc.rect(M, y, CW, 7, 'F') }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(30, 34, 60)
      doc.text(c.label, M + 2, y + 4.8)
      doc.setTextColor(26, 138, 80)
      doc.text(String(cnt.oikein), M + CW - 62, y + 4.8, { align: 'right' })
      doc.setTextColor(214, 48, 48)
      doc.text(String(cnt.vaarin), M + CW - 34, y + 4.8, { align: 'right' })
      doc.setTextColor(60, 64, 90)
      doc.text(cpct == null ? '–' : `${cpct} %`, M + CW - 2, y + 4.8, { align: 'right' })
      y += 7

      // Puutteet (huomautus / vastuuhenkilö / korjattu) — vastaa virallisen
      // TR-/MVR-lomakkeen omaa saraketta. Tulostetaan vain jos rivejä on.
      const notes = (cnt.notes || []).filter(n => (n.desc || '').trim())
      if (notes.length) {
        notes.forEach(n => {
          ensureSpace(10)
          doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(120, 40, 40)
          const lines = doc.splitTextToSize(`• ${n.desc}`, CW - 8)
          doc.text(lines, M + 6, y + 3.6)
          y += lines.length * 3.8
          const meta = []
          if (n.vastuuhenkilo) meta.push(`Vastuuhenkilö: ${n.vastuuhenkilo}`)
          meta.push(n.korjattu ? `Korjattu${n.korjattuPvm ? ' ' + n.korjattuPvm : ''}` : 'Ei vielä korjattu')
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(140, 144, 160)
          doc.text(meta.join('   ·   '), M + 6, y + 3.4)
          y += 5.5
        })
        y += 1
      }
    })
    y += 5
    ensureSpace(10)
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(140, 144, 160)
    const lines = doc.splitTextToSize(legalNote, CW)
    doc.text(lines, M, y); y += lines.length * 3.6 + 8
  }

  drawMeasurement('TR-mittaus', TR_CATEGORIES, trCounts, TR_LEGAL_NOTE)
  drawMeasurement('MVR-mittaus', MVR_CATEGORIES, mvrCounts, MVR_LEGAL_NOTE)

  // Yhteenveto urakoitsijoittain -- erityisen hyödyllinen pitkän työmaan
  // koko historian kattavassa raportissa (ks. summarizeObservations).
  if (obs.length > 0) {
    const summary = summarizeObservations(obs)
    ensureSpace(20)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(10, 20, 40)
    doc.text('Yhteenveto', M, y); y += 9

    doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
    doc.setTextColor(40, 40, 40)
    doc.text(`Havaintoja yhteensä: ${summary.total}`, M, y)
    doc.setTextColor(214, 48, 48); doc.text(`Kriittinen: ${summary.bySev.Kriittinen}`, M + 62, y)
    doc.setTextColor(208, 120, 0); doc.text(`Huomio: ${summary.bySev.Huomio}`, M + 108, y)
    doc.setTextColor(26, 138, 80); doc.text(`Info: ${summary.bySev.Info}`, M + 148, y)
    y += 6
    doc.setTextColor(40, 40, 40)
    doc.text(`Avoinna: ${summary.byStatus.avoin}`, M, y)
    doc.setTextColor(208, 120, 0); doc.text(`Kuitattu, odottaa tarkastusta: ${summary.byStatus.kuitattu}`, M + 62, y)
    doc.setTextColor(26, 138, 80); doc.text(`Korjattu: ${summary.byStatus.korjattu}`, M + 148, y)
    y += 9

    if (summary.byYritys.length > 0) {
      doc.setFillColor(238, 240, 245)
      doc.rect(M, y, CW, 7, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(100, 105, 125)
      doc.text('Yritys / urakoitsija', M + 2, y + 4.8)
      doc.text('Yht.', M + CW - 118, y + 4.8, { align: 'right' })
      doc.text('Kriitt.', M + CW - 88, y + 4.8, { align: 'right' })
      doc.text('Huomio', M + CW - 58, y + 4.8, { align: 'right' })
      doc.text('Info', M + CW - 32, y + 4.8, { align: 'right' })
      doc.text('Avoin', M + CW - 2, y + 4.8, { align: 'right' })
      y += 7
      summary.byYritys.forEach((row, i) => {
        ensureSpace(8)
        if (i % 2 === 1) { doc.setFillColor(247, 248, 250); doc.rect(M, y, CW, 7, 'F') }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(30, 34, 60)
        doc.text(row.yritys, M + 2, y + 4.8)
        doc.text(String(row.total), M + CW - 118, y + 4.8, { align: 'right' })
        doc.setTextColor(214, 48, 48); doc.text(String(row.Kriittinen), M + CW - 88, y + 4.8, { align: 'right' })
        doc.setTextColor(208, 120, 0); doc.text(String(row.Huomio), M + CW - 58, y + 4.8, { align: 'right' })
        doc.setTextColor(26, 138, 80); doc.text(String(row.Info), M + CW - 32, y + 4.8, { align: 'right' })
        doc.setTextColor(60, 64, 90); doc.text(String(row.avoin), M + CW - 2, y + 4.8, { align: 'right' })
        y += 7
      })
    }
    y += 8
  }

  if (obs.length > 0) {
    ensureSpace(14 + 16 + (obs[0]?.photos?.length ? 72 : 0))
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(10, 20, 40)
    doc.text('Havainnot', M, y); y += 9

    const sevCol = { Kriittinen: [214, 48, 48], Huomio: [208, 120, 0], Info: [26, 138, 80] }
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i]
      // Otsikko, tekstit ja ensimmäinen kuvarivi samalle sivulle
      ensureSpace(16 + (o.photos?.length ? 72 : 0) + (o.note ? 10 : 0))
      const col = sevCol[o.sev] || [80, 80, 80]
      doc.setFillColor(...col)
      doc.roundedRect(M, y, CW, 8, 1.5, 1.5, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(255, 255, 255)
      doc.text(`${i + 1}. ${o.havainto || '(ei kuvausta)'}`, M + 3, y + 5.5)
      doc.setFontSize(9)
      doc.text(o.sev, W - M - 3, y + 5.5, { align: 'right' })
      y += 11

      if (o.yritys) {
        ensureSpace(6)
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100, 105, 125)
        doc.text('Yritys: ', M + 2, y)
        doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 34, 60)
        doc.text(o.yritys, M + 18, y)
        y += 5.5
      }
      if (o.createdAt) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(150, 154, 170)
        doc.text(new Date(o.createdAt).toLocaleString('fi-FI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), M + 2, y)
        y += 5
      }
      if (o.status) {
        ensureSpace(6)
        const fmt = d => d ? new Date(d).toLocaleDateString('fi-FI') : ''
        const st = o.status === 'tiedoksi'
          ? 'Tiedoksi – ei vaadi korjausta'
          : o.status === 'korjattu'
          ? `Korjattu ${fmt(o.fixed_at)}${o.fixed_by_name ? ' (' + o.fixed_by_name + ')' : ''}`
          : o.status === 'kuitattu'
            ? `Kuitattu korjatuksi ${fmt(o.ack_at)}${o.ack_by_name ? ' (' + o.ack_by_name + ')' : ''}, odottaa tarkastusta`
            : `Avoin${o.due_date ? ' · korjattava ' + fmt(o.due_date) + ' mennessä' : ''}`
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9)
        doc.setTextColor(...(o.status === 'korjattu' ? [26, 138, 80] : o.status === 'kuitattu' ? [208, 120, 0] : [100, 105, 125]))
        doc.text('Tila: ' + st, M + 2, y)
        y += 5.5
        if (o.ack_comment) {
          doc.setFont('helvetica', 'italic'); doc.setTextColor(60, 64, 90)
          const l = doc.splitTextToSize('Kuittaus: ' + o.ack_comment, CW - 4)
          ensureSpace(l.length * 4.5 + 1)
          doc.text(l, M + 2, y); y += l.length * 4.5 + 1
        }
      }
      if (o.note) {
        ensureSpace(8)
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(40, 40, 40)
        const lines = doc.splitTextToSize(o.note, CW - 4)
        doc.text(lines, M + 2, y); y += lines.length * 5 + 2
      }
      // Kuvat rinnakkain, enintään 3 per rivi (Ennen / Asiakkaan kuva / Jälkeen).
      const loaded = []
      for (const photo of (o.photos || [])) {
        const img = new Image(); img.src = photo.src
        await new Promise(r => { img.onload = r; img.onerror = r })
        if (!img.naturalWidth) continue
        const c = document.createElement('canvas')
        c.width = img.naturalWidth; c.height = img.naturalHeight
        c.getContext('2d').drawImage(img, 0, 0)
        loaded.push({ data: c.toDataURL('image/jpeg', 0.85), nw: img.naturalWidth, nh: img.naturalHeight, label: photo.label })
      }
      const perRow = 3
      const gap = 3, cellW = (CW - 4 - gap * 2) / 3, cellH = 52
      for (let k = 0; k < loaded.length; k += perRow) {
        const row = loaded.slice(k, k + perRow)
        const sizes = row.map(ph => { const sc = Math.min(cellW / ph.nw, cellH / ph.nh); return [ph.nw * sc, ph.nh * sc] })
        const rowH = Math.max(...sizes.map(z => z[1]))
        ensureSpace(rowH + 4)
        row.forEach((ph, j) => {
          const x = M + 2 + j * (cellW + gap)
          const [dw, dh] = sizes[j]
          try { doc.addImage(ph.data, 'JPEG', x, y, dw, dh) } catch {}
          if (ph.label) {
            doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(255, 255, 255)
            doc.setFillColor(10, 20, 40); doc.rect(x, y, doc.getTextWidth(ph.label) + 4, 5.5, 'F')
            doc.text(ph.label, x + 2, y + 3.9)
          }
        })
        y += rowH + 4
      }
      y += 3
    }
  }

  const tp = doc.getNumberOfPages()
  for (let p = 1; p <= tp; p++) {
    doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(160, 160, 160)
    doc.text(`Korpnex Oy · Työturvallisuusraportti · ${dateStr}`, M, 292)
    doc.text(`${p} / ${tp}`, W - M, 292, { align: 'right' })
  }

  const blob = doc.output('blob')
  const filename = `Tyoturvallisuus_${(site || 'kohde').replace(/\s+/g, '_')}_${dateStr.replace(/\./g, '-')}.pdf`
  return { blob, filename }
}

// Downscale + re-encode an image file straight away. Raw phone photos can be
// several MB — compressing keeps PDF exports light and fast.
export function compressImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height)
          width = Math.round(width * scale); height = Math.round(height * scale)
        }
        const c = document.createElement('canvas')
        c.width = width; c.height = height
        c.getContext('2d').drawImage(img, 0, 0, width, height)
        resolve(c.toDataURL('image/jpeg', quality))
      }
      img.onerror = () => resolve(e.target.result)
      img.src = e.target.result
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}
