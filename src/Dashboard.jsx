import React, { useState, useEffect, useCallback, useRef } from 'react'
import { sb } from './supabaseClient.js'
import {
  TR_CATEGORIES, MVR_CATEGORIES, TR_LEGAL_NOTE, MVR_LEGAL_NOTE,
  emptyCounts, categoryPct, overallIndex, indexColor, SEV_LABELS, OBS_CATEGORIES, buildReportPDF, summarizeObservations,
  addNote, updateNote, removeNote,
} from './shared.js'
import ClientsPanel, { CLIENTS_CSS } from './ClientsPanel.jsx'
import { ObsCard, AckAction, ReviewAction, Lightbox, StatusTag, overdue, OBS_REVIEW_CSS } from './ObsReview.jsx'
import { usePhotoUrls, photoAsDataUrl } from './photos.js'
import ContractorsPanel, { CONTRACTORS_CSS } from './Contractors.jsx'
import { buildFinalReportPDF, buildObservationsCSV } from './finalReport.js'

// Valvomo (?valvomo) — Korpnexin hallintapaneeli, tarkoitettu käytettäväksi
// tietokoneella. Täältä hallitaan työmaita (lisäys / nimeäminen / arkistointi),
// muokataan ja arkistoidaan havaintoja, sekä tarkastellaan ja korjataan
// TR-/MVR-mittausten koko historiaa. Kenttäsovellus (puhelin, ei ?valvomo)
// pysyy nopeana kirjaustyökaluna kentällä — kaikki isompi säätäminen ja
// raportointi tehdään täällä.
//
// "Arkistointi" on aina pehmeä poisto: data ei häviä tietokannasta, se vain
// piilotetaan listoilta (archived=true). Näin vanhat PDF-raportit ja koko
// historia säilyvät, vaikka työmaan tai havainnon arkistoisi vahingossa.
//
// Sama näkymä toimii kahdessa roolissa (profile.role):
//   konsultti → täysi Valvomo + Odottaa tarkastusta + Asiakkaat
//   asiakas   → asiakasportaali: omat työmaat luku-tilassa, havaintojen
//               kuittaus korjatuksi. Tietokannan RLS rajaa näkyvyyden, tämä
//               tiedosto vain piilottaa muokkaustoiminnot.
// Kuvat tulevat Storagesta (ks. photos.js).
export default function Dashboard({ profile, logout }) {
  const isC = profile?.role === 'konsultti'
  const [view, setView] = useState('tyomaat') // tyomaat | tarkastus | asiakkaat (konsultti)
  const [clients, setClients] = useState([])
  const [reviewList, setReviewList] = useState([])
  const [lightbox, setLightbox] = useState(null)
  const [obsFilter, setObsFilter] = useState('avoimet')
  const [sitesLoaded, setSitesLoaded] = useState(false)
  const [finalOpen, setFinalOpen] = useState(false)
  const [finalPhotos, setFinalPhotos] = useState(true)
  const [finalBusy, setFinalBusy] = useState('')
  const [endOpen, setEndOpen] = useState(false)
  const [endDate, setEndDate] = useState('')
  const [worksites, setWorksites] = useState([])
  const [archivedSites, setArchivedSites] = useState([])
  const [showArchivedSites, setShowArchivedSites] = useState(false)
  const [selected, setSelected] = useState(null) // koko worksite-rivi {id, name, archived}
  const [tab, setTab] = useState('yhteenveto') // yhteenveto | havainnot | tr | mvr

  const [addingSite, setAddingSite] = useState(false)
  const [newSiteName, setNewSiteName] = useState('')
  const [editingSiteId, setEditingSiteId] = useState(null)
  const [editSiteName, setEditSiteName] = useState('')

  const [loading, setLoading] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const [obs, setObs] = useState([])
  const [showArchivedObs, setShowArchivedObs] = useState(false)
  const [trRows, setTrRows] = useState([])
  const [mvrRows, setMvrRows] = useState([])
  const [subcontractors, setSubcontractors] = useState([])
  const [newSubName, setNewSubName] = useState('')
  const [showArchivedSub, setShowArchivedSub] = useState(false)
  const [archivedSub, setArchivedSub] = useState([])
  const [editMeasure, setEditMeasure] = useState(null) // { type, id, counts } | null

  const [pdfMode, setPdfMode] = useState(false)
  const [pdfBlob, setPdfBlob] = useState(null)
  const [pdfName, setPdfName] = useState('')
  const [pdfDownloaded, setPdfDownloaded] = useState(false)

  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)
  function showToast(msg) {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }

  const loadWorksites = useCallback(async () => {
    const [activeRes, archRes] = await Promise.all([
      sb.from('worksites').select('*').eq('archived', false).order('name'),
      sb.from('worksites').select('*').eq('archived', true).order('name'),
    ])
    if (!activeRes.error) {
      const list = activeRes.data || []
      setWorksites(list)
      setSelected(prev => {
        if (prev) {
          const stillThere = list.find(w => w.id === prev.id)
          if (stillThere) return stillThere
        }
        return list[0] || null
      })
    } else {
      console.error('loadWorksites failed:', activeRes.error)
    }
    if (!archRes.error) setArchivedSites(archRes.data || [])
    setSitesLoaded(true)
  }, [])

  const loadClients = useCallback(async () => {
    const { data } = await sb.from('clients').select('*').order('name')
    setClients(data || [])
  }, [])
  useEffect(() => { loadClients() }, [loadClients])

  // Konsultti: kaikkien työmaiden asiakkaan kuittaamat havainnot
  const loadReview = useCallback(async () => {
    if (!isC) return
    const { data } = await sb.from('safety_observations').select('*')
      .eq('status', 'kuitattu').eq('archived', false).order('ack_at', { ascending: true })
    setReviewList(data || [])
  }, [isC])
  useEffect(() => { loadReview() }, [loadReview])

  useEffect(() => { loadWorksites() }, [loadWorksites])

  const loadSite = useCallback(async (siteName) => {
    if (!siteName) { setObs([]); setTrRows([]); setMvrRows([]); setSubcontractors([]); setArchivedSub([]); return }
    setLoading(true)
    setErrMsg('')
    try {
      const [obsRes, trRes, mvrRes, subRes, subArchRes] = await Promise.all([
        sb.from('safety_observations').select('*').eq('site', siteName).order('created_at', { ascending: false }),
        sb.from('safety_measurements').select('*').eq('site', siteName).eq('type', 'tr').eq('archived', false).order('created_at', { ascending: false }),
        sb.from('safety_measurements').select('*').eq('site', siteName).eq('type', 'mvr').eq('archived', false).order('created_at', { ascending: false }),
        sb.from('subcontractors').select('*').eq('site', siteName).eq('archived', false).order('name'),
        sb.from('subcontractors').select('*').eq('site', siteName).eq('archived', true).order('name'),
      ])
      if (obsRes.error || trRes.error || mvrRes.error) throw (obsRes.error || trRes.error || mvrRes.error)
      setObs((obsRes.data || []).map(o => ({ ...o, _origStatus: o.status })))
      setTrRows(trRes.data || [])
      setMvrRows(mvrRes.data || [])
      setSubcontractors(subRes.data || [])
      setArchivedSub(subArchRes.data || [])
      setEditMeasure(null)
    } catch (e) {
      console.error('Valvomo load failed:', e)
      setErrMsg('⚠ Tietojen haku epäonnistui — tarkista yhteys ja päivitä.')
    }
    setLoading(false)
  }, [])

  useEffect(() => { if (selected) loadSite(selected.name) }, [selected, loadSite])

  function refresh() {
    loadWorksites()
    loadReview()
    if (selected) loadSite(selected.name)
  }

  async function setWorksiteClient(clientId) {
    if (!selected) return
    const { error } = await sb.from('worksites').update({ client_id: clientId || null }).eq('id', selected.id)
    if (error) { showToast('⚠ Tallennus epäonnistui'); return }
    showToast(clientId ? '✓ Työmaa liitetty asiakkaalle' : 'Työmaa irrotettu asiakkaasta')
    loadWorksites()
  }

  function obsUpdated(o) {
    setObs(prev => prev.map(x => x.id === o.id ? { ...x, ...o, _origStatus: o.status, _dirty: false } : x))
    setReviewList(prev => prev.filter(x => x.id !== o.id || o.status === 'kuitattu'))
  }

  // --- Työmaiden hallinta ---
  async function addWorksite() {
    const name = newSiteName.trim()
    if (!name) return
    const existingActive = worksites.find(w => w.name.toLowerCase() === name.toLowerCase())
    if (existingActive) { setSelected(existingActive); setAddingSite(false); setNewSiteName(''); return }
    const existingArchived = archivedSites.find(w => w.name.toLowerCase() === name.toLowerCase())
    if (existingArchived) {
      if (window.confirm(`"${existingArchived.name}" on arkistoitu. Palautetaanko se?`)) await unarchiveWorksite(existingArchived)
      setAddingSite(false); setNewSiteName(''); return
    }
    const { data, error } = await sb.from('worksites').insert([{ name }]).select()
    if (!error && data?.[0]) {
      await loadWorksites()
      setSelected(data[0])
      showToast('✓ Työmaa lisätty')
    } else {
      console.error('addWorksite failed:', error)
      showToast('⚠ Lisäys epäonnistui')
    }
    setAddingSite(false); setNewSiteName('')
  }

  async function renameWorksite(w) {
    const name = editSiteName.trim()
    if (!name || name === w.name) { setEditingSiteId(null); return }
    const { error } = await sb.from('worksites').update({ name }).eq('id', w.id)
    if (!error) {
      showToast('✓ Nimi vaihdettu')
      await loadWorksites()
    } else {
      console.error('renameWorksite failed:', error)
      showToast('⚠ Nimen vaihto epäonnistui')
    }
    setEditingSiteId(null)
  }

  async function archiveWorksite(w) {
    if (!window.confirm(`Arkistoidaanko työmaa "${w.name}"? Se katoaa listoilta, mutta kaikki data säilyy — voit palauttaa sen myöhemmin.`)) return
    const { error } = await sb.from('worksites').update({ archived: true }).eq('id', w.id)
    if (!error) { showToast('🗄 Työmaa arkistoitu'); await loadWorksites() }
    else { console.error('archiveWorksite failed:', error); showToast('⚠ Arkistointi epäonnistui') }
  }

  async function unarchiveWorksite(w) {
    const { error } = await sb.from('worksites').update({ archived: false }).eq('id', w.id)
    if (!error) { showToast('↺ Työmaa palautettu'); await loadWorksites() }
    else { console.error('unarchiveWorksite failed:', error); showToast('⚠ Palautus epäonnistui') }
  }

  // --- Havaintojen hallinta ---
  function updateLocalObs(id, key, val) {
    setObs(prev => prev.map(o => o.id === id ? { ...o, [key]: val, _dirty: true } : o))
  }

  async function saveObs(o) {
    const patch = { havainto: o.havainto, yritys: (o.yritys || '').trim(), sev: o.sev, luokka: o.luokka || null, note: o.note, status: o.status, due_date: o.due_date || null }
    const before = obs.find(x => x.id === o.id)
    if (o.status === 'korjattu' && !o.fixed_at) {
      patch.fixed_at = new Date().toISOString(); patch.fixed_by_name = profile?.name || null
    }
    if (o.status === 'avoin' && before?._origStatus && before._origStatus !== 'avoin') {
      Object.assign(patch, { fixed_at: null, fixed_by_name: null, fix_photo: null, ack_at: null, ack_by: null, ack_by_name: null, ack_comment: null, ack_photo: null })
    }
    const { error } = await sb.from('safety_observations').update(patch).eq('id', o.id)
    if (!error) {
      setObs(prev => prev.map(x => x.id === o.id ? { ...x, ...patch, _dirty: false, _origStatus: patch.status } : x))
      loadReview()
      showToast('✓ Havainto tallennettu')
    } else {
      console.error('saveObs failed:', error)
      showToast('⚠ Tallennus epäonnistui')
    }
  }

  async function toggleArchiveObs(o) {
    const next = !o.archived
    if (next && !window.confirm('Arkistoidaanko tämä havainto?')) return
    const { error } = await sb.from('safety_observations').update({ archived: next }).eq('id', o.id)
    if (!error) {
      setObs(prev => prev.map(x => x.id === o.id ? { ...x, archived: next } : x))
      showToast(next ? '🗄 Havainto arkistoitu' : '↺ Havainto palautettu')
    } else {
      console.error('toggleArchiveObs failed:', error)
      showToast('⚠ Toiminto epäonnistui')
    }
  }

  // --- Aliurakoitsijoiden hallinta (työmaakohtainen lista) ---
  async function addSubcontractor() {
    const name = newSubName.trim()
    if (!name || !selected) return
    const existing = subcontractors.find(s => s.name.toLowerCase() === name.toLowerCase())
    if (existing) { setNewSubName(''); return }
    const { data, error } = await sb.from('subcontractors')
      .insert([{ site: selected.name, name }]).select()
    if (!error && data?.[0]) {
      setSubcontractors(prev => [...prev, data[0]].sort((a, b) => a.name.localeCompare(b.name)))
      showToast('✓ Aliurakoitsija lisätty')
    } else {
      console.error('addSubcontractor failed:', error)
      showToast('⚠ Lisäys epäonnistui')
    }
    setNewSubName('')
  }

  async function toggleArchiveSub(s) {
    const next = !s.archived
    const { error } = await sb.from('subcontractors').update({ archived: next }).eq('id', s.id)
    if (!error) {
      if (next) {
        setSubcontractors(prev => prev.filter(x => x.id !== s.id))
        setArchivedSub(prev => [...prev, { ...s, archived: true }].sort((a, b) => a.name.localeCompare(b.name)))
      } else {
        setArchivedSub(prev => prev.filter(x => x.id !== s.id))
        setSubcontractors(prev => [...prev, { ...s, archived: false }].sort((a, b) => a.name.localeCompare(b.name)))
      }
      showToast(next ? '🗄 Aliurakoitsija arkistoitu' : '↺ Aliurakoitsija palautettu')
    } else {
      console.error('toggleArchiveSub failed:', error)
      showToast('⚠ Toiminto epäonnistui')
    }
  }

  // Pysyvä poisto — sallittu vain jo arkistoiduille, jotta vahingossa
  // arkistointi ei koskaan johda peruuttamattomaan tietojen katoamiseen
  // ilman erillistä, tarkoituksellista lisävaihetta.
  async function deleteSubcontractor(s) {
    if (!window.confirm(`Poistetaanko "${s.name}" pysyvästi? Tätä ei voi perua.`)) return
    const { error } = await sb.from('subcontractors').delete().eq('id', s.id)
    if (!error) {
      setArchivedSub(prev => prev.filter(x => x.id !== s.id))
      showToast('🗑 Poistettu pysyvästi')
    } else {
      console.error('deleteSubcontractor failed:', error)
      showToast('⚠ Poisto epäonnistui')
    }
  }

  // --- Mittausten hallinta (koko historia, ei vain viimeisin) ---
  function startEditMeasure(type, row) {
    setEditMeasure({ type, id: row.id, counts: row.counts || emptyCounts(type === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES) })
  }

  async function addNewMeasurement(type) {
    if (!selected) return
    const categories = type === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES
    const counts = emptyCounts(categories)
    // Edellisin mittaus on jo ladattuna (rows on järjestetty uusin ensin) —
    // siirretään sen avoimet (ei korjatut) puutteet uuden mittauksen pohjaksi.
    const prevRow = (type === 'tr' ? trRows : mvrRows)[0]
    if (prevRow?.counts) {
      categories.forEach(c => {
        const prevNotes = (prevRow.counts[c.key]?.notes || []).filter(n => !n.korjattu && (n.desc || '').trim())
        counts[c.key] = { ...counts[c.key], notes: prevNotes.map(n => ({ ...n, carried: true })) }
      })
    }
    const { data, error } = await sb.from('safety_measurements')
      .insert([{ type, site: selected.name, inspector: '', counts, index_pct: null, created_at: new Date().toISOString() }])
      .select()
    if (!error && data?.[0]) {
      if (type === 'tr') setTrRows(prev => [data[0], ...prev])
      else setMvrRows(prev => [data[0], ...prev])
      setEditMeasure({ type, id: data[0].id, counts })
      showToast('✓ Uusi mittaus luotu')
    } else {
      console.error('addNewMeasurement failed:', error)
      showToast('⚠ Luonti epäonnistui')
    }
  }

  function bumpEdit(catKey, field, delta) {
    setEditMeasure(prev => {
      if (!prev) return prev
      const cur = prev.counts[catKey] || { oikein: 0, vaarin: 0 }
      const next = { ...cur, [field]: Math.max(0, cur[field] + delta) }
      return { ...prev, counts: { ...prev.counts, [catKey]: next } }
    })
  }

  // Puutteiden hallinta muokattavana olevalle mittaukselle (editMeasure).
  // Tallennus tapahtuu vasta "Tallenna muutokset" -painikkeesta, kuten
  // laskureidenkin kohdalla.
  function addNoteEdit(catKey) {
    setEditMeasure(prev => prev ? { ...prev, counts: addNote(prev.counts, catKey) } : prev)
  }
  function updateNoteEdit(catKey, id, patch) {
    setEditMeasure(prev => prev ? { ...prev, counts: updateNote(prev.counts, catKey, id, patch) } : prev)
  }
  function removeNoteEdit(catKey, id) {
    setEditMeasure(prev => prev ? { ...prev, counts: removeNote(prev.counts, catKey, id) } : prev)
  }

  async function saveEditMeasure() {
    if (!editMeasure) return
    const categories = editMeasure.type === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES
    const { pct } = overallIndex(editMeasure.counts, categories)
    const { error } = await sb.from('safety_measurements')
      .update({ counts: editMeasure.counts, index_pct: pct })
      .eq('id', editMeasure.id)
    if (!error) {
      const setRows = editMeasure.type === 'tr' ? setTrRows : setMvrRows
      setRows(prev => prev.map(r => r.id === editMeasure.id ? { ...r, counts: editMeasure.counts, index_pct: pct } : r))
      showToast('✓ Mittaus tallennettu')
      setEditMeasure(null)
    } else {
      console.error('saveEditMeasure failed:', error)
      showToast('⚠ Tallennus epäonnistui')
    }
  }

  async function archiveMeasurement(type, row) {
    if (!window.confirm('Arkistoidaanko tämä mittaus? Se ei enää näy yhteenvedossa tai PDF-raportissa.')) return
    const { error } = await sb.from('safety_measurements').update({ archived: true }).eq('id', row.id)
    if (!error) {
      const setRows = type === 'tr' ? setTrRows : setMvrRows
      setRows(prev => prev.filter(r => r.id !== row.id))
      if (editMeasure?.id === row.id) setEditMeasure(null)
      showToast('🗄 Mittaus arkistoitu')
    } else {
      console.error('archiveMeasurement failed:', error)
      showToast('⚠ Arkistointi epäonnistui')
    }
  }

  const activeObs = obs.filter(o => !o.archived)
  const trLatest = trRows[0] || null
  const mvrLatest = mvrRows[0] || null
  const distinctInspectors = [...new Set(activeObs.map(o => o.inspector).filter(Boolean))].join(', ')

  async function exportPDF() {
    const trTotal = trLatest ? overallIndex(trLatest.counts, TR_CATEGORIES).total : 0
    const mvrTotal = mvrLatest ? overallIndex(mvrLatest.counts, MVR_CATEGORIES).total : 0
    if (activeObs.length === 0 && !trTotal && !mvrTotal) {
      alert('Tällä työmaalla ei ole vielä sisältöä raporttiin.')
      return
    }
    showToast('⏳ Kootaan raporttia kuvineen…')
    const pdfObs = []
    for (const o of activeObs) {
      const photos = []
      for (const p of (o.photos || []).slice(0, 2)) {
        const src = await photoAsDataUrl(p.path); if (src) photos.push({ src, label: 'Ennen', maxH: 75 })
      }
      if (o.fix_photo) { const src = await photoAsDataUrl(o.fix_photo); if (src) photos.push({ src, label: 'Jälkeen', maxH: 75 }) }
      else if (o.ack_photo) { const src = await photoAsDataUrl(o.ack_photo); if (src) photos.push({ src, label: 'Asiakkaan kuva', maxH: 75 }) }
      pdfObs.push({ ...o, createdAt: o.created_at, photos })
    }
    const { blob, filename } = await buildReportPDF({
      site: selected.name,
      inspector: distinctInspectors,
      trCounts: trLatest?.counts || emptyCounts(TR_CATEGORIES),
      mvrCounts: mvrLatest?.counts || emptyCounts(MVR_CATEGORIES),
      obs: pdfObs,
    })
    downloadFile(blob, filename); showToast('⬇ PDF ladattu')
  }

  // --- Työmaan päättäminen ja säilytysajat ---
  async function setEnded(dateStr) {
    if (!selected) return
    const { error } = await sb.from('worksites').update({ ended_at: dateStr || null }).eq('id', selected.id)
    if (error) { showToast('⚠ Tallennus epäonnistui'); return }
    showToast(dateStr ? '🏁 Työmaa merkitty päättyneeksi' : '↺ Työmaa avattu uudelleen')
    setEndOpen(false)
    loadWorksites()
  }

  async function deleteWorksiteData(w) {
    if (!window.confirm(`Poistetaanko työmaan "${w.name}" KAIKKI tiedot pysyvästi (havainnot, kuvat, mittaukset)?\n\nTätä ei voi perua.`)) return
    if (window.prompt(`Vahvista kirjoittamalla työmaan nimi:\n${w.name}`) !== w.name) { showToast('Poisto peruttu'); return }
    const { data: rows } = await sb.from('safety_observations').select('photos, ack_photo, fix_photo').eq('worksite_id', w.id)
    const paths = (rows || []).flatMap(o => [...(o.photos || []).map(p => p.path), o.ack_photo, o.fix_photo]).filter(Boolean)
    for (let i = 0; i < paths.length; i += 100) await sb.storage.from('tt-photos').remove(paths.slice(i, i + 100))
    await sb.from('safety_observations').delete().eq('worksite_id', w.id)
    await sb.from('safety_measurements').delete().eq('worksite_id', w.id)
    await sb.from('subcontractors').delete().eq('worksite_id', w.id)
    const { error } = await sb.from('worksites').delete().eq('id', w.id)
    showToast(error ? '⚠ Työmaan poisto epäonnistui' : '🗑 Työmaan tiedot poistettu')
    if (selected?.id === w.id) setSelected(null)
    loadWorksites()
  }

  async function makeFinalReport() {
    if (!selected) return
    setFinalBusy('Kootaan raporttia…')
    try {
      const { blob, filename } = await buildFinalReportPDF({
        site: selected.name, clientName: selectedClient?.name || myClient?.name || '',
        obs: activeObs, trRows, mvrRows,
        photoLoader: finalPhotos ? photoAsDataUrl : null,
        onProgress: m => setFinalBusy(m),
      })
      setFinalOpen(false)
      downloadFile(blob, filename); showToast('⬇ Loppuraportti ladattu')
    } catch (e) {
      console.error(e); showToast('⚠ Raportin luonti epäonnistui')
    }
    setFinalBusy('')
  }

  function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  function downloadCSV() {
    const { blob, filename } = buildObservationsCSV({ site: selected?.name, obs: activeObs })
    downloadFile(blob, filename)
  }

  const shareSupported = typeof navigator !== 'undefined' && !!navigator.share && !!navigator.canShare
  async function sharePDF() {
    if (!pdfBlob) return
    const file = new File([pdfBlob], pdfName, { type: 'application/pdf' })
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: pdfName }) } catch {}
    } else {
      const url = URL.createObjectURL(pdfBlob)
      const a = document.createElement('a'); a.href = url; a.download = pdfName
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 3000)
      setPdfDownloaded(true)
    }
  }

  const trResult = trLatest ? overallIndex(trLatest.counts, TR_CATEGORIES) : { total: 0, pct: null }
  const mvrResult = mvrLatest ? overallIndex(mvrLatest.counts, MVR_CATEGORIES) : { total: 0, pct: null }

  const myClient = !isC ? clients.find(c => c.id === profile?.client_id) : null
  const selectedClient = clients.find(c => c.id === selected?.client_id)
  const openCount = activeObs.filter(o => o.status === 'avoin').length
  const ackCount = activeObs.filter(o => o.status === 'kuitattu').length
  const fixedCount = activeObs.filter(o => o.status === 'korjattu').length
  const lateCount = activeObs.filter(overdue).length
  const filteredObs = activeObs.filter(o =>
    obsFilter === 'kaikki' ? true
      : obsFilter === 'avoimet' ? o.status === 'avoin'
      : obsFilter === 'odottaa' ? o.status === 'kuitattu'
      : o.status === 'korjattu')
  const photoPaths = (view === 'tarkastus' ? reviewList : obs).flatMap(o => [...(o.photos || []).map(p => p.path), o.ack_photo, o.fix_photo])
  const urls = usePhotoUrls(photoPaths)

  // Muistutukset (konsultti): ehdoissa luvatut käyttö- ja säilytysajat
  const reminders = []
  if (isC) {
    const now = new Date()
    const addM = (d, m) => { const x = new Date(d + 'T12:00:00'); x.setMonth(x.getMonth() + m); return x }
    const allSites = [...worksites, ...archivedSites]
    allSites.filter(w => w.ended_at && addM(w.ended_at, 36) < now).forEach(w =>
      reminders.push({ key: 'del' + w.id, kind: 'del', w, text: `Työmaan "${w.name}" säilytysaika (3 v) päättyi ${addM(w.ended_at, 36).toLocaleDateString('fi-FI')}. Tiedot pitää poistaa.` }))
    clients.filter(c => !c.archived).forEach(c => {
      const cs = allSites.filter(w => w.client_id === c.id)
      if (!cs.length || cs.some(w => !w.ended_at)) return
      const last = cs.map(w => w.ended_at).sort().pop()
      if (addM(last, 3) < now) reminders.push({ key: 'cl' + c.id, kind: 'client', text: `Asiakkaan ${c.name} kaikki työmaat ovat päättyneet ja 3 kk käyttöaika umpeutui ${addM(last, 3).toLocaleDateString('fi-FI')}. Sulje tunnukset tai arkistoi asiakas.` })
    })
  }

  return (
    <div className="kx-dashboard">
      <style>{DASHBOARD_CSS + OBS_REVIEW_CSS + CLIENTS_CSS + CONTRACTORS_CSS}</style>

      {/* Topbar */}
      <div className="kx-topbar">
        <div className="kx-brand">
          <img className="kx-brand-mark" src="/korpnex-icon.png" alt="Korpnex" />
          <span className="kx-brand-name">KORPNEX</span>
          <span className="kx-brand-pill">Työturvallisuus</span>
          <span className="kx-brand-sub">{isC ? 'Valvomo' : (myClient?.name || 'Asiakasportaali')}</span>
        </div>
        <div className="kx-topbar-actions">
          {isC && (
            <div className="kx-viewswitch">
              <button className={view === 'tyomaat' ? 'active' : ''} onClick={() => setView('tyomaat')}>Työmaat</button>
              <button className={view === 'tarkastus' ? 'active' : ''} onClick={() => { setView('tarkastus'); loadReview() }}>
                Odottaa tarkastusta{reviewList.length > 0 && <span className="kx-count-pill">{reviewList.length}</span>}
              </button>
              <button className={view === 'asiakkaat' ? 'active' : ''} onClick={() => setView('asiakkaat')}>Asiakkaat</button>
            </div>
          )}
          {isC && <a className="kx-btn-ghost kx-btn-sm kx-btn-onbrand kx-hide-mobile" href="/">📱 Kenttäsovellus</a>}
          <span className="kx-user-chip">{profile?.name || profile?.email}</span>
          <button className="kx-btn-ghost kx-btn-sm kx-btn-onbrand" onClick={logout} title={profile?.email}>Kirjaudu ulos</button>
        </div>
      </div>

      {isC && view === 'asiakkaat' && (
        <div className="kx-shell kx-shell-single">
          <main className="kx-main">
            <ClientsPanel showToast={showToast} onSitesChanged={() => { loadWorksites(); loadClients() }} />
          </main>
        </div>
      )}

      {isC && view === 'tarkastus' && (
        <div className="kx-shell kx-shell-single">
          <main className="kx-main">
            <div className="kx-main-head">
              <div>
                <div className="kx-main-title">Odottaa tarkastusta</div>
                <div className="kx-main-sub">Asiakkaiden korjatuiksi kuittaamat puutteet kaikilta työmailta. Tarkista paikan päällä tai kuvasta.</div>
              </div>
              <button className="kx-btn-ghost" onClick={loadReview}>🔄 Päivitä</button>
            </div>
            {reviewList.length === 0 && <div className="kx-empty-note">✅ Ei tarkastettavaa.</div>}
            <div className="kx-obs-grid">
              {reviewList.map(o => (
                <ObsCard key={o.id} o={o} urls={urls} showSite onOpenPhoto={setLightbox}>
                  <ReviewAction o={o} reviewerName={profile?.name} onDone={u => { obsUpdated(u); showToast(u.status === 'korjattu' ? '✓ Merkitty korjatuksi' : '↩ Palautettu avoimeksi') }} />
                </ObsCard>
              ))}
            </div>
          </main>
        </div>
      )}

      {isC && view === 'tyomaat' && reminders.length > 0 && (
        <div className="kx-reminders">
          {reminders.map(r => (
            <div key={r.key} className="kx-reminder">
              <span>⏰ {r.text}</span>
              {r.kind === 'del'
                ? <button className="kx-delete-btn" onClick={() => deleteWorksiteData(r.w)}>Poista tiedot</button>
                : <button className="kx-btn-ghost kx-btn-sm" onClick={() => setView('asiakkaat')}>Asiakkaat →</button>}
            </div>
          ))}
        </div>
      )}

      {view === 'tyomaat' && (
      <div className="kx-shell">
        {/* Sidebar: työmaat */}
        <aside className="kx-sidebar">
          <div className="kx-sidebar-head">{isC ? 'Työmaat' : 'Työmaasi'}</div>
          <div className="kx-site-list">
            {worksites.length === 0 && <div className="kx-empty-note">{isC ? 'Ei vielä työmaita.' : 'Työmaita ei ole vielä liitetty tunnukseesi.'}</div>}
            {worksites.map(w => (
              <div key={w.id} className={`kx-site-row ${selected?.id === w.id ? 'active' : ''}`}>
                {isC && editingSiteId === w.id ? (
                  <div className="kx-site-edit">
                    <input autoFocus className="kx-input kx-input-sm" value={editSiteName}
                      onChange={e => setEditSiteName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') renameWorksite(w); if (e.key === 'Escape') setEditingSiteId(null) }} />
                    <button className="kx-icon-btn" title="Tallenna" onClick={() => renameWorksite(w)}>✓</button>
                    <button className="kx-icon-btn" title="Peruuta" onClick={() => setEditingSiteId(null)}>✕</button>
                  </div>
                ) : (
                  <>
                    <button className="kx-site-name" onClick={() => setSelected(w)}>
                      {w.name}
                      {isC && <span className="kx-site-client">{clients.find(c => c.id === w.client_id)?.name || 'ei asiakasta'}</span>}
                      {w.ended_at && <span className="kx-site-ended">🏁 päättynyt {new Date(w.ended_at).toLocaleDateString('fi-FI')}</span>}
                    </button>
                    {isC && (
                      <div className="kx-site-actions">
                        <button className="kx-icon-btn" title="Nimeä uudelleen" onClick={() => { setEditingSiteId(w.id); setEditSiteName(w.name) }}>✏️</button>
                        <button className="kx-icon-btn kx-icon-btn-danger" title="Arkistoi työmaa" onClick={() => archiveWorksite(w)}>🗄</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {isC && (!addingSite ? (
            <button className="kx-add-site-btn" onClick={() => { setAddingSite(true); setNewSiteName('') }}>＋ Uusi työmaa</button>
          ) : (
            <div className="kx-site-edit kx-add-row">
              <input autoFocus className="kx-input kx-input-sm" placeholder="Työmaan nimi" value={newSiteName}
                onChange={e => setNewSiteName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addWorksite(); if (e.key === 'Escape') setAddingSite(false) }} />
              <button className="kx-icon-btn" title="Lisää" onClick={addWorksite}>✓</button>
              <button className="kx-icon-btn" title="Peruuta" onClick={() => setAddingSite(false)}>✕</button>
            </div>
          ))}

          {isC && (
            <>
              <button className="kx-archived-toggle" onClick={() => setShowArchivedSites(s => !s)}>
                {showArchivedSites ? '▾' : '▸'} Arkistoidut työmaat {archivedSites.length ? `(${archivedSites.length})` : ''}
              </button>
              {showArchivedSites && (
                <div className="kx-archived-list">
                  {archivedSites.length === 0 && <div className="kx-empty-note">Ei arkistoituja työmaita.</div>}
                  {archivedSites.map(w => (
                    <div key={w.id} className="kx-site-row">
                      <span className="kx-site-name-static">{w.name}</span>
                      <button className="kx-icon-btn" title="Palauta" onClick={() => unarchiveWorksite(w)}>↺</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </aside>

        {/* Pääsisältö: valitun työmaan tiedot */}
        <main className="kx-main">
          {!selected ? (
            <div className="kx-empty-main">
              {isC ? '📍 Lisää tai valitse työmaa vasemmalta aloittaaksesi.'
                : sitesLoaded ? <>👋 Tervetuloa!<br /><br />Korpnex liittää työmaasi tunnukseesi ensimmäisen tarkastuksen yhteydessä. Sen jälkeen näet täältä havainnot, mittaukset ja avoimet puutteet heti tarkastuksen jälkeen.</> : 'Ladataan…'}
            </div>
          ) : (
            <>
              <div className="kx-main-head">
                <div>
                  <div className="kx-main-title">{selected.name}</div>
                  <div className="kx-main-sub">
                    {loading ? 'Ladataan…' : `${activeObs.length} havaintoa · ${openCount} avoinna${ackCount ? ` · ${ackCount} odottaa tarkastusta` : ''}`}
                  </div>
                  {isC && (
                    <div className="kx-client-select">
                      Asiakas:
                      <select className="kx-input kx-input-sm" value={selected.client_id || ''} onChange={e => setWorksiteClient(e.target.value)}>
                        <option value="">— ei asiakasta (näkyy vain Korpnexille) —</option>
                        {clients.filter(c => !c.archived || c.id === selected.client_id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      {!selectedClient && <span className="kx-hint">Liitä asiakas, niin sen käyttäjät näkevät työmaan.</span>}
                    </div>
                  )}
                </div>
                <div className="kx-main-head-actions">
                  {isC && (selected.ended_at
                    ? <button className="kx-btn-ghost" title="Avaa työmaa uudelleen" onClick={() => window.confirm('Avataanko työmaa uudelleen?') && setEnded(null)}>🏁 Päättynyt {new Date(selected.ended_at).toLocaleDateString('fi-FI')}</button>
                    : <button className="kx-btn-ghost" onClick={() => { setEndDate(new Date().toISOString().slice(0, 10)); setEndOpen(true) }}>🏁 Päätä työmaa</button>)}
                  <button className="kx-btn-ghost" onClick={refresh}>🔄 Päivitä</button>
                  <button className="kx-btn-ghost" onClick={() => setFinalOpen(true)}>📑 Loppuraportti</button>
                  <button className="kx-btn-primary" onClick={exportPDF}>📄 PDF</button>
                </div>
              </div>

              {errMsg && <div className="kx-error">{errMsg}</div>}

              <div className="kx-tabs">
                {[
                  ['yhteenveto', 'Yhteenveto'],
                  ['havainnot', 'Havainnot', openCount + ackCount || null],
                  ['tr', 'TR-mittaus', trResult.total ? `${trResult.pct} %` : null],
                  ['mvr', 'MVR-mittaus', mvrResult.total ? `${mvrResult.pct} %` : null],
                  ['urakoitsijat', 'Urakoitsijat', null],
                  ...(isC ? [['aliurakoitsijat', 'Urakoitsijalista', subcontractors.length || null]] : []),
                ].map(([key, label, count]) => (
                  <button key={key} className={`kx-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
                    {label}{count != null && <em className="kx-tab-count">{count}</em>}
                  </button>
                ))}
              </div>

              <div className="kx-tab-content">
                {tab === 'yhteenveto' && (
                  <div className="kx-overview-grid">
                    <div className="kx-card kx-kpis">
                      <button className="kx-kpi" onClick={() => { setTab('havainnot'); setObsFilter('avoimet') }}>
                        <span className="kx-kpi-num" style={{ color: openCount ? '#dc2626' : '#059669' }}>{openCount}</span>
                        <span className="kx-kpi-label">Avoimet puutteet</span>
                      </button>
                      <button className="kx-kpi" onClick={() => { setTab('havainnot'); setObsFilter('odottaa') }}>
                        <span className="kx-kpi-num" style={{ color: '#d97706' }}>{ackCount}</span>
                        <span className="kx-kpi-label">Odottaa tarkastusta</span>
                      </button>
                      <button className="kx-kpi" onClick={() => { setTab('havainnot'); setObsFilter('korjatut') }}>
                        <span className="kx-kpi-num" style={{ color: '#059669' }}>{fixedCount}</span>
                        <span className="kx-kpi-label">Korjattu</span>
                      </button>
                      <div className="kx-kpi">
                        <span className="kx-kpi-num" style={{ color: lateCount ? '#dc2626' : '#94a3b8' }}>{lateCount}</span>
                        <span className="kx-kpi-label">Myöhässä</span>
                      </div>
                      <div className="kx-kpi">
                        <span className="kx-kpi-num" style={{ color: '#0a1428' }}>{avgFixDays(activeObs) ?? '–'}</span>
                        <span className="kx-kpi-label">Korjausaika, pv (ka.)</span>
                      </div>
                    </div>
                    <MeasurementSummary title="TR-mittaus" categories={TR_CATEGORIES} row={trLatest} />
                    <MeasurementSummary title="MVR-mittaus" categories={MVR_CATEGORIES} row={mvrLatest} />
                    <TrendCard trRows={trRows} mvrRows={mvrRows} />
                    <WorksiteSummary obs={activeObs} />
                    <div className="kx-card kx-recent-obs">
                      <div className="kx-card-title">Viimeisimmät havainnot</div>
                      {activeObs.length === 0 && <div className="kx-empty-note">Ei havaintoja.</div>}
                      {activeObs.slice(0, 6).map(o => (
                        <div key={o.id} className="kx-recent-obs-row">
                          <span className={`kx-sev-dot sev-${o.sev}`} />
                          <span className="kx-recent-obs-text">{o.havainto || '(ei kuvausta)'}</span>
                          <StatusTag status={o.status} />
                          {o.created_at && <span className="kx-recent-obs-date">{new Date(o.created_at).toLocaleDateString('fi-FI')}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {tab === 'havainnot' && isC && (
                  <ObservationsPanel
                    obs={obs} showArchived={showArchivedObs} setShowArchived={setShowArchivedObs}
                    onChange={updateLocalObs} onSave={saveObs} onToggleArchive={toggleArchiveObs}
                    subcontractors={subcontractors} urls={urls} onOpenPhoto={setLightbox}
                    reviewerName={profile?.name}
                    onReviewed={u => { obsUpdated(u); loadReview(); showToast(u.status === 'korjattu' ? '✓ Merkitty korjatuksi' : '↩ Palautettu avoimeksi') }}
                    onCancel={() => loadSite(selected.name)}
                  />
                )}

                {tab === 'havainnot' && !isC && (
                  <div>
                    <div className="kx-filter-row">
                      {[['avoimet', `Avoimet (${openCount})`], ['odottaa', `Odottaa tarkastusta (${ackCount})`], ['korjatut', `Korjatut (${fixedCount})`], ['kaikki', `Kaikki (${activeObs.length})`]].map(([k, l]) => (
                        <button key={k} className={`kx-filter ${obsFilter === k ? 'active' : ''}`} onClick={() => setObsFilter(k)}>{l}</button>
                      ))}
                    </div>
                    {filteredObs.length === 0 && <div className="kx-empty-note">{obsFilter === 'avoimet' ? '✅ Ei avoimia puutteita.' : 'Ei havaintoja.'}</div>}
                    <div className="kx-obs-grid">
                      {filteredObs.map(o => (
                        <ObsCard key={o.id} o={o} urls={urls} onOpenPhoto={setLightbox}>
                          <AckAction o={o} onDone={() => { showToast('✓ Kuitattu — Korpnex tarkistaa korjauksen'); loadSite(selected.name) }} />
                        </ObsCard>
                      ))}
                    </div>
                  </div>
                )}

                {(tab === 'tr' || tab === 'mvr') && isC && (
                  <MeasurementPanel
                    type={tab}
                    categories={tab === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES}
                    legalNote={tab === 'tr' ? TR_LEGAL_NOTE : MVR_LEGAL_NOTE}
                    rows={tab === 'tr' ? trRows : mvrRows}
                    editMeasure={editMeasure}
                    subcontractors={subcontractors}
                    onStartEdit={startEditMeasure}
                    onCancelEdit={() => setEditMeasure(null)}
                    onBumpEdit={bumpEdit}
                    onSaveEdit={saveEditMeasure}
                    onArchive={archiveMeasurement}
                    onAddNew={addNewMeasurement}
                    onAddNote={addNoteEdit}
                    onUpdateNote={updateNoteEdit}
                    onRemoveNote={removeNoteEdit}
                  />
                )}

                {(tab === 'tr' || tab === 'mvr') && !isC && (
                  <MeasurementHistory
                    type={tab}
                    categories={tab === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES}
                    legalNote={tab === 'tr' ? TR_LEGAL_NOTE : MVR_LEGAL_NOTE}
                    rows={tab === 'tr' ? trRows : mvrRows}
                  />
                )}

                {tab === 'urakoitsijat' && (
                  <ContractorsPanel obs={activeObs} isC={isC} worksiteId={selected.id} urls={urls} onOpenPhoto={setLightbox}
                    showToast={showToast} onChanged={() => loadSite(selected.name)} />
                )}

                {tab === 'aliurakoitsijat' && isC && (
                  <SubcontractorsPanel
                    active={subcontractors} archived={archivedSub}
                    showArchived={showArchivedSub} setShowArchived={setShowArchivedSub}
                    newName={newSubName} setNewName={setNewSubName}
                    onAdd={addSubcontractor} onToggleArchive={toggleArchiveSub} onDelete={deleteSubcontractor}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>
      )}

      <Lightbox url={lightbox} onClose={() => setLightbox(null)} />

      {endOpen && selected && (
        <div className="kx-pdf-overlay" onClick={() => setEndOpen(false)}>
          <div className="kx-modal" onClick={e => e.stopPropagation()}>
            <div className="kx-modal-title">Päätä työmaa</div>
            <div className="kx-main-sub" style={{ marginTop: 0 }}>{selected.name}{selectedClient ? ` · ${selectedClient.name}` : ''}</div>
            <ul className="kx-modal-list">
              <li>Asiakas näkee työmaan edelleen. Portaali on ehtojen mukaan käytössä <b>3 kk</b> viimeisestä tarkastuksesta.</li>
              <li>Tiedot säilytetään <b>3 vuotta</b> päättymispäivästä. Valvomo muistuttaa, kun ne pitää poistaa.</li>
              <li>Kannattaa ladata loppuraportti nyt ja toimittaa se asiakkaalle.</li>
            </ul>
            <label className="kx-field">
              <span className="kx-label">Päättymispäivä</span>
              <input type="date" className="kx-input" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </label>
            <div className="kx-modal-actions">
              <button className="kx-btn-ghost" onClick={() => { setEndOpen(false); setFinalOpen(true) }}>📑 Loppuraportti</button>
              <button className="kx-btn-primary" disabled={!endDate} onClick={() => setEnded(endDate)}>🏁 Merkitse päättyneeksi</button>
            </div>
          </div>
        </div>
      )}

      {finalOpen && selected && (
        <div className="kx-pdf-overlay" onClick={() => !finalBusy && setFinalOpen(false)}>
          <div className="kx-modal" onClick={e => e.stopPropagation()}>
            <div className="kx-modal-title">Työmaan loppuraportti</div>
            <div className="kx-main-sub" style={{ marginTop: 0 }}>{selected.name} · {activeObs.length} havaintoa · {trRows.length + mvrRows.length} mittausta</div>
            <ul className="kx-modal-list">
              <li>Avainluvut ja turvallisuusindeksin kehitys koko työmaan ajalta</li>
              <li>Urakoitsijavertailu ja yleisimmät aiheet</li>
              <li>Avoinna olevat puutteet</li>
              <li>Liitteenä koko havaintoluettelo</li>
            </ul>
            <label className="kx-checkbox-row" style={{ margin: 0 }}>
              <input type="checkbox" checked={finalPhotos} onChange={e => setFinalPhotos(e.target.checked)} />
              Liitä ennen- ja jälkeen-kuvat (raportti kasvaa)
            </label>
            <div className="kx-modal-actions">
              <button className="kx-btn-ghost" disabled={!!finalBusy} onClick={downloadCSV}>⬇ Excel (CSV)</button>
              <button className="kx-btn-primary" disabled={!!finalBusy} onClick={makeFinalReport}>{finalBusy || '📑 Luo PDF'}</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="kx-toast">{toast}</div>}

      {/* PDF overlay */}
      {pdfMode && (
        <div className="kx-pdf-overlay">
          <div className="kx-pdf-overlay-head">
            <button className="kx-pdf-close" onClick={() => setPdfMode(false)}>✕</button>
            <span className="kx-pdf-title">PDF valmis</span>
            <button className="kx-pdf-share" onClick={sharePDF}>{shareSupported ? '⬆ Jaa' : '⬇ Lataa PDF'}</button>
          </div>
          <div className="kx-pdf-body">
            <div className="kx-pdf-icon">{pdfDownloaded ? '✅' : '📄'}</div>
            {shareSupported ? (
              <p className="kx-pdf-text">Paina <strong>Jaa ⬆</strong> avataksesi jakovalikon — esim. sähköpostiin.</p>
            ) : pdfDownloaded ? (
              <p className="kx-pdf-text success">PDF ladattu koneen Lataukset-kansioon.<br /><span>({pdfName})</span></p>
            ) : (
              <p className="kx-pdf-text">Paina <strong>Lataa PDF</strong> tallentaaksesi tiedoston koneelle.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


// Keskimääräinen korjausaika päivinä (merkintä → varmistettu korjaus).
function avgFixDays(obs) {
  const d = obs.filter(o => o.status === 'korjattu' && o.fixed_at && o.created_at)
    .map(o => (new Date(o.fixed_at) - new Date(o.created_at)) / 864e5)
  if (!d.length) return null
  return (d.reduce((a, b) => a + b, 0) / d.length).toFixed(1).replace('.', ',')
}

// TR-/MVR-indeksin kehitys ajan yli (yksinkertainen SVG-viivakaavio).
function TrendCard({ trRows, mvrRows }) {
  const series = [
    { key: 'TR', color: '#0878E8', pts: trRows.filter(r => r.index_pct != null).map(r => ({ t: new Date(r.created_at).getTime(), v: Number(r.index_pct) })).reverse() },
    { key: 'MVR', color: '#20a0c8', pts: mvrRows.filter(r => r.index_pct != null).map(r => ({ t: new Date(r.created_at).getTime(), v: Number(r.index_pct) })).reverse() },
  ].filter(s => s.pts.length)
  const all = series.flatMap(s => s.pts)
  const boxRef = useRef(null)
  const [boxW, setBoxW] = useState(800)
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setBoxW(Math.max(260, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const W = boxW, H = boxW < 500 ? 170 : 220, P = { l: 30, r: 10, t: 12, b: 26 }
  let body
  if (all.length < 2) {
    body = <div className="kx-empty-note">Kaavio näkyy, kun mittauksia on vähintään kaksi.</div>
  } else {
    const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t)) || t0 + 1
    const vMin = Math.max(0, Math.floor((Math.min(...all.map(p => p.v)) - 5) / 10) * 10)
    const x = t => P.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - P.l - P.r)
    const y = v => P.t + (1 - (v - vMin) / (100 - vMin)) * (H - P.t - P.b)
    const ticks = []; for (let v = vMin; v <= 100; v += vMin >= 60 ? 10 : 20) ticks.push(v)
    body = (
      <svg viewBox={`0 0 ${W} ${H}`} className="kx-trend-svg">
        {ticks.map(v => (
          <g key={v}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="#f1f4f9" />
            <text x={P.l - 6} y={y(v) + 3.5} fontSize="10" textAnchor="end" fill="#94a3b8">{v}</text>
          </g>
        ))}
        {vMin < 90 && <line x1={P.l} x2={W - P.r} y1={y(90)} y2={y(90)} stroke="#059669" strokeDasharray="4 4" opacity=".5" />}
        <text x={P.l} y={H - 8} fontSize="10" fill="#94a3b8">{new Date(t0).toLocaleDateString('fi-FI')}</text>
        <text x={W - P.r} y={H - 8} fontSize="10" fill="#94a3b8" textAnchor="end">{new Date(t1).toLocaleDateString('fi-FI')}</text>
        {series.map(s => (
          <g key={s.key}>
            <polyline fill="none" stroke={s.color} strokeWidth="2.5" points={s.pts.map(p => `${x(p.t)},${y(p.v)}`).join(' ')} />
            {s.pts.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r="3.5" fill="#fff" stroke={s.color} strokeWidth="2"><title>{`${s.key} ${new Date(p.t).toLocaleDateString('fi-FI')}: ${p.v}%`}</title></circle>)}
          </g>
        ))}
      </svg>
    )
  }
  return (
    <div className="kx-card kx-trend" ref={boxRef}>
      <div className="kx-measure-summary-head">
        <div className="kx-card-title" style={{ marginBottom: 0 }}>Turvallisuusindeksin kehitys</div>
        <div className="kx-trend-legend">
          {series.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.key}</span>)}
          <span><i style={{ background: '#059669', opacity: .5 }} />tavoite 90 %</span>
        </div>
      </div>
      {body}
    </div>
  )
}

// Asiakkaan TR-/MVR-historia luku-tilassa: jokainen mittaus omana korttinaan
// luokittaisine tuloksineen ja kirjattuine puutteineen.
function MeasurementHistory({ type, categories, legalNote, rows }) {
  const [open, setOpen] = useState(rows[0]?.id ?? null)
  return (
    <div className="kx-measure-panel">
      {rows.length === 0 && <div className="kx-empty-note">Ei vielä {type === 'tr' ? 'TR' : 'MVR'}-mittauksia tällä työmaalla.</div>}
      <div className="kx-measure-list">
        {rows.map(row => {
          const { pct, total } = overallIndex(row.counts, categories)
          const isOpen = open === row.id
          const notes = categories.flatMap(c => (row.counts?.[c.key]?.notes || []).filter(n => (n.desc || '').trim()).map(n => ({ ...n, cat: c.label })))
          return (
            <div key={row.id} className="kx-card kx-measure-row">
              <button className="kx-measure-row-head kx-plain-btn" onClick={() => setOpen(isOpen ? null : row.id)}>
                <div style={{ textAlign: 'left' }}>
                  <div className="kx-measure-row-date">{new Date(row.created_at).toLocaleDateString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' })}</div>
                  <div className="kx-measure-row-sub">{total} havaintoa{row.inspector ? ` · ${row.inspector}` : ''}{notes.length ? ` · ${notes.filter(n => !n.korjattu).length} avointa puutetta` : ''}</div>
                </div>
                <span className="kx-measure-pct" style={{ color: indexColor(pct) }}>{pct == null ? '–' : `${pct}%`} {isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div className="kx-measure-edit">
                  {categories.map(c => {
                    const cnt = row.counts?.[c.key] || { oikein: 0, vaarin: 0 }
                    const cp = categoryPct(cnt)
                    return (
                      <div key={c.key} className="kx-measure-summary-cat-row">
                        <span className="kx-measure-summary-cat-label">{c.label}</span>
                        <span className="kx-measure-summary-cat-vals"><span className="ok">{cnt.oikein}</span> / <span className="no">{cnt.vaarin}</span>{'  '}<strong style={{ color: indexColor(cp) }}>{cp == null ? '–' : `${cp}%`}</strong></span>
                      </div>
                    )
                  })}
                  {notes.length > 0 && (
                    <div className="kx-note-list">
                      <div className="kx-label">Kirjatut puutteet</div>
                      {notes.map(n => (
                        <div key={n.id} className="kx-note-item">
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{n.desc}</div>
                          <div className="kx-hint">{n.cat}{n.vastuuhenkilo ? ` · vastuu: ${n.vastuuhenkilo}` : ''} · {n.korjattu ? <b style={{ color: '#059669' }}>Korjattu {n.korjattuPvm ? new Date(n.korjattuPvm).toLocaleDateString('fi-FI') : ''}</b> : <b style={{ color: '#dc2626' }}>Avoin</b>}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="kx-legal-note">{legalNote}</div>
    </div>
  )
}

// Yhden mittauksen (tuorein TR tai MVR) tiivistelmä yhteenveto-välilehdelle:
// kokonaisindeksi + luokittainen erittely, täysin luku-tilassa.
function MeasurementSummary({ title, categories, row }) {
  const counts = row?.counts || emptyCounts(categories)
  const { total, pct } = overallIndex(counts, categories)
  const color = indexColor(pct)
  return (
    <div className="kx-card">
      <div className="kx-measure-summary-head">
        <div>
          <div className="kx-measure-summary-title">{title}</div>
          <div className="kx-measure-summary-sub">
            {total ? `Viimeisin mittaus ${row.created_at ? new Date(row.created_at).toLocaleDateString('fi-FI') : ''}` : 'Ei vielä mittausta'}
          </div>
        </div>
        <div className="kx-measure-summary-pct" style={{ color }}>{pct == null ? '–' : `${pct}%`}</div>
      </div>
      {total > 0 && (
        <div className="kx-measure-summary-cats">
          {categories.map(c => {
            const cnt = counts[c.key] || { oikein: 0, vaarin: 0 }
            const cpct = categoryPct(cnt)
            return (
              <div key={c.key} className="kx-measure-summary-cat-row">
                <span className="kx-measure-summary-cat-label">{c.label}</span>
                <span className="kx-measure-summary-cat-vals">
                  <span className="ok">{cnt.oikein}</span> / <span className="no">{cnt.vaarin}</span>
                  {'  '}<strong style={{ color: indexColor(cpct) }}>{cpct == null ? '–' : `${cpct}%`}</strong>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Koko työmaan (kaikkien viikkojen/tarkastuskertojen) kokonaisyhteenveto:
// kuinka paljon puutteita yhteensä, kuinka moni vielä avoinna, ja erityisesti
// kuinka ne jakautuvat urakoitsijoittain — juuri tätä tarvitaan kun työmaa on
// kestänyt monta viikkoa ja havaintoja on kertynyt useasta tarkastuskerrasta.
// Sama laskenta ja järjestys kuin PDF-raportin "Yhteenveto"-osiossa
// (ks. shared.js:n summarizeObservations), joten näkymä ja raportti täsmäävät.
function WorksiteSummary({ obs }) {
  const summary = summarizeObservations(obs)
  const sevColor = { Kriittinen: '#dc2626', Huomio: '#d97706', Info: '#059669' }
  return (
    <div className="kx-card kx-worksite-summary">
      <div className="kx-card-title">Työmaan kokonaisyhteenveto (koko historia)</div>
      {summary.total === 0 ? (
        <div className="kx-empty-note">Ei havaintoja vielä.</div>
      ) : (
        <>
          <div className="kx-summary-badges">
            <span className="kx-badge kx-badge-main">Yhteensä {summary.total}</span>
            <span className="kx-badge" style={{ color: sevColor.Kriittinen }}>Kriittinen {summary.bySev.Kriittinen}</span>
            <span className="kx-badge" style={{ color: sevColor.Huomio }}>Huomio {summary.bySev.Huomio}</span>
            <span className="kx-badge" style={{ color: sevColor.Info }}>Info {summary.bySev.Info}</span>
            <span className="kx-badge" style={{ color: '#d97706' }}>Avoinna {summary.byStatus.avoin}</span>
            <span className="kx-badge" style={{ color: '#059669' }}>Korjattu {summary.byStatus.korjattu}</span>
          </div>
          <div className="kx-table-wrap">
            <table className="kx-yritys-table">
              <thead>
                <tr>
                  <th>Yritys / urakoitsija</th>
                  <th>Yht.</th>
                  <th>Kriittinen</th>
                  <th>Huomio</th>
                  <th>Info</th>
                  <th>Avoinna</th>
                </tr>
              </thead>
              <tbody>
                {summary.byYritys.map(row => (
                  <tr key={row.yritys}>
                    <td>{row.yritys}</td>
                    <td>{row.total}</td>
                    <td style={{ color: sevColor.Kriittinen }}>{row.Kriittinen || ''}</td>
                    <td style={{ color: sevColor.Huomio }}>{row.Huomio || ''}</td>
                    <td style={{ color: sevColor.Info }}>{row.Info || ''}</td>
                    <td style={{ color: row.avoin ? '#d97706' : '#94a3b8' }}>{row.avoin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// Havaintojen hallintanäkymä: kaikki työmaan havainnot muokattavina kortteina
// (teksti, yritys, vakavuus, tila, lisätieto), + arkistointi/palautus.
// Ei automaattitallennusta — muutokset kootaan korttiin ja tallennetaan
// eksplisiittisesti "Tallenna muutokset" -napista, jotta hallintakäyttö
// pysyy ennustettavana eikä lähetä kymmeniä pyyntöjä joka näppäimestä.
function ObservationsPanel({ obs, showArchived, setShowArchived, onChange, onSave, onToggleArchive, subcontractors, urls = {}, onOpenPhoto, onReviewed, reviewerName, onCancel }) {
  const [editing, setEditing] = useState({})
  const [filter, setFilter] = useState('kaikki')
  const sevColor = { Kriittinen: '#dc2626', Huomio: '#d97706', Info: '#059669' }
  const sevBg = { Kriittinen: 'rgba(220,38,38,0.1)', Huomio: 'rgba(245,168,0,0.12)', Info: 'rgba(5,150,105,0.1)' }
  const base = obs.filter(o => showArchived ? o.archived : !o.archived)
  const cnt = k => base.filter(o => o.status === k).length
  const list = base.filter(o => filter === 'kaikki' || o.status === filter)
  // Mitkä havaintojen Yritys-kentät ovat "kirjoita itse" -tilassa.
  const [yritysCustom, setYritysCustom] = useState({})
  return (
    <div className="kx-obs-panel">
      <div className="kx-filter-row" style={{ alignItems: 'center' }}>
        {[['kaikki', `Kaikki (${base.length})`], ['avoin', `Avoimet (${cnt('avoin')})`], ['kuitattu', `Odottaa tarkastusta (${cnt('kuitattu')})`], ['korjattu', `Korjatut (${cnt('korjattu')})`]].map(([k, l]) => (
          <button key={k} className={`kx-filter ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
        ))}
        <label className="kx-checkbox-row" style={{ margin: '0 0 0 auto' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          Arkistoidut
        </label>
      </div>
      {list.length === 0 && (
        <div className="kx-empty-note">{showArchived ? 'Ei arkistoituja havaintoja.' : 'Ei havaintoja tällä työmaalla.'}</div>
      )}
      <div className="kx-obs-grid">
        {list.map(o => !editing[o.id] && !o._dirty ? (
          <ObsCard key={o.id} o={o} urls={urls} onOpenPhoto={onOpenPhoto}>
            {o.status === 'kuitattu' && !o.archived && <ReviewAction o={o} reviewerName={reviewerName} onDone={onReviewed} />}
            <div className="kx-obs-card-foot">
              <button className="kx-btn-ghost kx-btn-sm" onClick={() => onToggleArchive(o)}>{o.archived ? '↺ Palauta' : 'Arkistoi'}</button>
              <button className="kx-btn-ghost kx-btn-sm" onClick={() => setEditing(p => ({ ...p, [o.id]: true }))}>✏️ Muokkaa</button>
            </div>
          </ObsCard>
        ) : (
          <div key={o.id} className="kx-card kx-obs-card" style={{ borderColor: '#9cc7f5', boxShadow: '0 0 0 3px rgba(8,120,232,.08)' }}>
            <div className="kx-obs-card-head">
              <span className="kx-obs-index">Muokataan havaintoa</span>
              <div className="kx-obs-tags">
                <span className="kx-tag" style={{ background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span>
                <StatusTag status={o.status} />
              </div>
            </div>
            <div className="kx-field">
              <div className="kx-label">Havainto</div>
              <input className="kx-input" value={o.havainto || ''} onChange={e => onChange(o.id, 'havainto', e.target.value)} />
            </div>
            <div className="kx-field-row">
              <div className="kx-field">
                <div className="kx-label">Yritys</div>
                {(subcontractors.length === 0 || yritysCustom[o.id] || (o.yritys && !subcontractors.some(s => s.name === o.yritys))) ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="kx-input" style={{ flex: 1 }} value={o.yritys || ''} onChange={e => onChange(o.id, 'yritys', e.target.value)} />
                    {subcontractors.length > 0 && (
                      <button className="kx-btn-ghost kx-btn-sm" onClick={() => { setYritysCustom(p => ({ ...p, [o.id]: false })); onChange(o.id, 'yritys', '') }}>↩</button>
                    )}
                  </div>
                ) : (
                  <select className="kx-input" value={o.yritys || ''}
                    onChange={e => {
                      const v = e.target.value
                      if (v === '__other__') { setYritysCustom(p => ({ ...p, [o.id]: true })); onChange(o.id, 'yritys', '') }
                      else onChange(o.id, 'yritys', v)
                    }}>
                    <option value="" disabled>Valitse…</option>
                    {subcontractors.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                    <option value="__other__">✎ Muu (kirjoita itse)</option>
                  </select>
                )}
              </div>
              <div className="kx-field">
                <div className="kx-label">Tarkastaja</div>
                <input className="kx-input" value={o.inspector || ''} disabled />
              </div>
            </div>
            <div className="kx-field">
              <div className="kx-label">Vakavuus</div>
              <div className="kx-btn-choice-row">
                {SEV_LABELS.map(s => (
                  <button key={s} className={`kx-choice-btn ${o.sev === s ? 'active' : ''}`} style={o.sev === s ? { color: sevColor[s] } : undefined} onClick={() => onChange(o.id, 'sev', s)}>{s}</button>
                ))}
              </div>
            </div>
            <div className="kx-field">
              <div className="kx-label">Luokka</div>
              <select className="kx-input" value={o.luokka || ''} onChange={e => onChange(o.id, 'luokka', e.target.value)}>
                <option value="">— ei luokiteltu —</option>
                {OBS_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="kx-field">
              <div className="kx-label">Tila</div>
              <div className="kx-btn-choice-row">
                {['avoin', ...(o.status === 'kuitattu' ? ['kuitattu'] : []), 'korjattu'].map(s => (
                  <button key={s} className={`kx-choice-btn ${o.status === s ? 'active' : ''}`} style={o.status === s ? { color: s === 'korjattu' ? '#059669' : s === 'kuitattu' ? '#b45309' : '#dc2626' } : undefined} onClick={() => onChange(o.id, 'status', s)}>{s === 'korjattu' ? '✓ Korjattu' : s === 'kuitattu' ? 'Kuitattu (asiakas)' : 'Avoin'}</button>
                ))}
              </div>
            </div>
            <div className="kx-field">
              <div className="kx-label">Korjattava viimeistään</div>
              <input type="date" className="kx-input" value={o.due_date || ''} onChange={e => onChange(o.id, 'due_date', e.target.value)} />
            </div>
            <div className="kx-field">
              <div className="kx-label">Lisätieto</div>
              <textarea className="kx-input kx-textarea" value={o.note || ''} onChange={e => onChange(o.id, 'note', e.target.value)} />
            </div>
            {((o.photos || []).length > 0 || o.ack_photo || o.fix_photo) && (
              <div className="kx-photo-row">
                {(o.photos || []).map(p => (
                  <button key={p.path} className="kx-photo" onClick={() => urls[p.path] && onOpenPhoto?.(urls[p.path])}>
                    {urls[p.path] && <img src={urls[p.path]} alt="" />}<span className="kx-photo-label">Ennen</span>
                  </button>
                ))}
                {o.ack_photo && <button className="kx-photo" onClick={() => urls[o.ack_photo] && onOpenPhoto?.(urls[o.ack_photo])}>{urls[o.ack_photo] && <img src={urls[o.ack_photo]} alt="" />}<span className="kx-photo-label">Asiakas</span></button>}
                {o.fix_photo && <button className="kx-photo" onClick={() => urls[o.fix_photo] && onOpenPhoto?.(urls[o.fix_photo])}>{urls[o.fix_photo] && <img src={urls[o.fix_photo]} alt="" />}<span className="kx-photo-label">Jälkeen</span></button>}
              </div>
            )}
            {(o.ack_at || o.status === 'korjattu' || o.reopen_comment) && (
              <div className="kx-timeline">
                {o.reopen_comment && o.status === 'avoin' && <div className="kx-tl-red" style={{ color: '#dc2626' }}>Palautettu: {o.reopen_comment}</div>}
                {o.ack_at && <div className="kx-tl-amber">{o.ack_by_name} kuittasi {new Date(o.ack_at).toLocaleDateString('fi-FI')}{o.ack_comment ? ` — "${o.ack_comment}"` : ''}</div>}
                {o.status === 'korjattu' && o.fixed_at && <div className="kx-tl-green">Varmistettu {new Date(o.fixed_at).toLocaleDateString('fi-FI')}{o.fixed_by_name ? ` · ${o.fixed_by_name}` : ''}</div>}
              </div>
            )}
            {o.created_at && (
              <div className="kx-obs-meta">🕒 {new Date(o.created_at).toLocaleString('fi-FI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
            )}
            <div className="kx-obs-card-foot">
              <button className="kx-btn-ghost kx-btn-sm" onClick={() => { setEditing(p => ({ ...p, [o.id]: false })); if (o._dirty) onCancel?.(o) }}>{o._dirty ? 'Peruuta' : 'Sulje'}</button>
              <button className="kx-btn-primary kx-btn-sm" disabled={!o._dirty} onClick={async () => { await onSave(o); setEditing(p => ({ ...p, [o.id]: false })) }}>
                {o._dirty ? 'Tallenna muutokset' : 'Tallennettu ✓'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// TR-/MVR-mittausten hallintanäkymä: koko historia listattuna (ei vain
// viimeisin), jokaista voi arkistoida, ja "Muokkaa" avaa saman
// laskuri-käyttöliittymän kuin kenttäsovelluksessa lukujen korjaamiseksi.
// "＋ Uusi mittaus" luo tälle työmaalle kokonaan uuden tyhjän mittausrivin.
function MeasurementPanel({ type, categories, legalNote, rows, editMeasure, subcontractors, onStartEdit, onCancelEdit, onBumpEdit, onSaveEdit, onArchive, onAddNew, onAddNote, onUpdateNote, onRemoveNote }) {
  // Mikä kategorian puutelista on auki muokkausnäkymässä — pelkkä
  // näyttötila, nollautuu kun muokkaus suljetaan (uusi editMeasure.id).
  const [openNotes, setOpenNotes] = useState({})
  const toggleNotes = key => setOpenNotes(prev => ({ ...prev, [key]: !prev[key] }))
  // Mitkä puutteiden Vastuuhenkilö-kentät ovat "kirjoita itse" -tilassa.
  const [customVastuu, setCustomVastuu] = useState({})
  const editingThis = editMeasure && editMeasure.type === type
  return (
    <div className="kx-measure-panel">
      <div className="kx-measure-panel-head">
        <div className="kx-label kx-label-flat">Mittaushistoria ({rows.length})</div>
        <button className="kx-btn-ghost kx-btn-sm" onClick={() => onAddNew(type)}>＋ Uusi mittaus</button>
      </div>

      {rows.length === 0 && !editingThis && (
        <div className="kx-empty-note">Ei vielä {type === 'tr' ? 'TR' : 'MVR'}-mittauksia tällä työmaalla.</div>
      )}

      <div className="kx-measure-list">
        {rows.map(row => {
          const { pct, total } = overallIndex(row.counts, categories)
          const isEditingRow = editMeasure?.id === row.id
          return (
            <div key={row.id} className="kx-card kx-measure-row">
              <div className="kx-measure-row-head">
                <div>
                  <div className="kx-measure-row-date">
                    {row.created_at ? new Date(row.created_at).toLocaleString('fi-FI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'}
                  </div>
                  <div className="kx-measure-row-sub">{total ? `${total} havaintoa` : 'Ei havaintoja vielä'}</div>
                </div>
                <div className="kx-measure-row-actions">
                  <span className="kx-measure-pct" style={{ color: indexColor(pct) }}>{pct == null ? '–' : `${pct}%`}</span>
                  {!isEditingRow ? (
                    <>
                      <button className="kx-btn-ghost kx-btn-sm" onClick={() => onStartEdit(type, row)}>✏️ Muokkaa</button>
                      <button className="kx-btn-ghost kx-btn-sm" onClick={() => onArchive(type, row)}>🗄</button>
                    </>
                  ) : (
                    <button className="kx-btn-ghost kx-btn-sm" onClick={onCancelEdit}>✕ Sulje</button>
                  )}
                </div>
              </div>

              {isEditingRow && (
                <div className="kx-measure-edit">
                  {categories.map(c => {
                    const cnt = editMeasure.counts[c.key] || { oikein: 0, vaarin: 0, notes: [] }
                    const cpct = categoryPct(cnt)
                    const notes = cnt.notes || []
                    const notesOpen = !!openNotes[c.key]
                    return (
                      <div key={c.key} className="kx-measure-cat">
                        <div className="kx-measure-cat-head">
                          <span className="kx-measure-cat-label">{c.label}</span>
                          <span className="kx-measure-cat-pct" style={{ color: indexColor(cpct) }}>{cpct == null ? '–' : `${cpct}%`}</span>
                        </div>
                        <div className="kx-count-row">
                          <button className="kx-count-btn ok" onClick={() => onBumpEdit(c.key, 'oikein', 1)}>✓ Oikein ({cnt.oikein})</button>
                          <button className="kx-count-btn no" onClick={() => onBumpEdit(c.key, 'vaarin', 1)}>✗ Väärin ({cnt.vaarin})</button>
                          {(cnt.oikein > 0 || cnt.vaarin > 0) && (
                            <button className="kx-count-btn undo" onClick={() => { if (cnt.vaarin > 0) onBumpEdit(c.key, 'vaarin', -1); else onBumpEdit(c.key, 'oikein', -1) }}>↺</button>
                          )}
                        </div>

                        <button className="kx-note-toggle" onClick={() => toggleNotes(c.key)} style={{ color: notes.length ? '#dc2626' : '#64748b' }}>
                          {notesOpen ? '▾' : '▸'} 🗒 Puutteet {notes.length ? `(${notes.length})` : ''}
                        </button>

                        {notesOpen && (
                          <div className="kx-note-list">
                            {notes.map(n => (
                              <div key={n.id} className="kx-note-item" style={n.carried && !n.korjattu ? { borderColor: '#f0c36d' } : undefined}>
                                <div className="kx-note-row" style={{ justifyContent: 'space-between' }}>
                                  <span className="kx-label kx-label-flat">
                                    Kuvaus puutteesta
                                    {n.carried && !n.korjattu && (
                                      <span style={{ marginLeft: 6, color: '#a67c00', textTransform: 'none', fontWeight: 700, fontSize: 10.5 }}>↩ edelliseltä kierrokselta</span>
                                    )}
                                  </span>
                                  <button className="kx-note-del" onClick={() => onRemoveNote(c.key, n.id)}>🗑</button>
                                </div>
                                <textarea className="kx-note-field" rows={2}
                                  placeholder="esim. Suojakaide puuttuu tasolta 2" value={n.desc}
                                  onChange={e => onUpdateNote(c.key, n.id, { desc: e.target.value })} />
                                <span className="kx-label kx-label-flat">Vastuuhenkilö</span>
                                {(subcontractors.length === 0 || customVastuu[n.id] || (n.vastuuhenkilo && !subcontractors.some(s => s.name === n.vastuuhenkilo))) ? (
                                  <div className="kx-note-row">
                                    <input className="kx-note-field" placeholder="Kuka korjaa" value={n.vastuuhenkilo}
                                      onChange={e => onUpdateNote(c.key, n.id, { vastuuhenkilo: e.target.value })} />
                                    {subcontractors.length > 0 && (
                                      <button className="kx-note-del" onClick={() => { setCustomVastuu(p => ({ ...p, [n.id]: false })); onUpdateNote(c.key, n.id, { vastuuhenkilo: '' }) }}>↩</button>
                                    )}
                                  </div>
                                ) : (
                                  <select className="kx-note-field" value={n.vastuuhenkilo}
                                    onChange={e => {
                                      const v = e.target.value
                                      if (v === '__other__') { setCustomVastuu(p => ({ ...p, [n.id]: true })); onUpdateNote(c.key, n.id, { vastuuhenkilo: '' }) }
                                      else onUpdateNote(c.key, n.id, { vastuuhenkilo: v })
                                    }}>
                                    <option value="" disabled>Valitse…</option>
                                    {subcontractors.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                                    <option value="__other__">✎ Muu (kirjoita itse)</option>
                                  </select>
                                )}
                                <div className="kx-note-row">
                                  <label className="kx-note-checklabel">
                                    <input type="checkbox" checked={n.korjattu}
                                      onChange={e => onUpdateNote(c.key, n.id, { korjattu: e.target.checked })} />
                                    Korjattu
                                  </label>
                                  {n.korjattu && (
                                    <input type="date" className="kx-note-field" style={{ flex: 1 }} value={n.korjattuPvm}
                                      onChange={e => onUpdateNote(c.key, n.id, { korjattuPvm: e.target.value })} />
                                  )}
                                </div>
                              </div>
                            ))}
                            <button className="kx-note-add" onClick={() => onAddNote(c.key)}>＋ Lisää puute</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  <button className="kx-btn-primary" onClick={onSaveEdit}>Tallenna muutokset</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="kx-legal-note">{legalNote}</div>
    </div>
  )
}

// Työmaan aliurakoitsijoiden hallinta: lisäys, lista, arkistointi/palautus.
// Tätä listaa käytetään Havaintojen Yritys- ja puutteiden Vastuuhenkilö-
// kenttien valintalistana koko Valvomossa ja kenttäsovelluksessa.
function SubcontractorsPanel({ active, archived, showArchived, setShowArchived, newName, setNewName, onAdd, onToggleArchive, onDelete }) {
  const list = showArchived ? archived : active
  return (
    <div className="kx-obs-panel">
      <div className="kx-measure-panel-head">
        <div className="kx-label kx-label-flat">Aliurakoitsijat ({active.length})</div>
      </div>
      <div className="kx-note-row" style={{ marginBottom: 14 }}>
        <input className="kx-input" style={{ flex: 1 }} placeholder="Uuden aliurakoitsijan/yrityksen nimi"
          value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onAdd()} />
        <button className="kx-btn-primary" onClick={onAdd}>＋ Lisää</button>
      </div>
      <label className="kx-checkbox-row">
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
        Näytä arkistoidut
      </label>
      {list.length === 0 && (
        <div className="kx-empty-note">{showArchived ? 'Ei arkistoituja aliurakoitsijoita.' : 'Ei vielä aliurakoitsijoita tällä työmaalla.'}</div>
      )}
      <div className="kx-measure-list">
        {list.map(s => (
          <div key={s.id} className="kx-card kx-measure-row">
            <div className="kx-measure-row-head">
              <div className="kx-measure-row-date">{s.name}</div>
              <div className="kx-measure-row-actions">
                <button className="kx-btn-ghost kx-btn-sm" onClick={() => onToggleArchive(s)}>
                  {s.archived ? '↺ Palauta' : '🗄 Arkistoi'}
                </button>
                {s.archived && (
                  <button className="kx-delete-btn" onClick={() => onDelete(s)}>🗑 Poista pysyvästi</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const DASHBOARD_CSS = `
.kx-dashboard { min-height: 100%; background: #f4f6fa; color: #0f172a; font-family: 'Inter', -apple-system, 'Segoe UI', sans-serif; }
.kx-dashboard * { box-sizing: border-box; }

/* Yläpalkki */
.kx-topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 24px; background: linear-gradient(180deg, #0a1428 0%, #0c1830 100%); border-bottom: 1px solid rgba(255,255,255,.06); position: sticky; top: 0; z-index: 30; }
.kx-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.kx-brand-mark { width: 36px; height: 36px; border-radius: 9px; object-fit: cover; display: block; flex-shrink: 0; }
.kx-brand-name { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 16px; font-weight: 800; color: #fff; letter-spacing: 3px; }
.kx-brand-sub { font-size: 13px; color: rgba(255,255,255,.62); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kx-brand-pill { font-size: 10.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #7cc8ff; background: rgba(32,184,255,.12); border: 1px solid rgba(32,184,255,.28); padding: 3px 8px; border-radius: 6px; white-space: nowrap; }
.kx-topbar-actions { display: flex; align-items: center; gap: 10px; }
.kx-viewswitch { display: flex; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); border-radius: 11px; padding: 3px; gap: 2px; }
.kx-viewswitch button { background: none; border: none; color: rgba(255,255,255,.7); font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; transition: background .15s, color .15s; }
.kx-viewswitch button:hover:not(.active) { color: #fff; background: rgba(255,255,255,.06); }
.kx-viewswitch button.active { background: #fff; color: #0a1428; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.kx-count-pill { background: #f59e0b; color: #1f1300; border-radius: 10px; font-size: 11px; font-weight: 800; padding: 1px 7px; line-height: 16px; }
.kx-user-chip { font-size: 12.5px; color: rgba(255,255,255,.6); white-space: nowrap; }
.kx-btn-onbrand { background: rgba(255,255,255,.08) !important; color: #fff !important; border: 1px solid rgba(255,255,255,.12) !important; text-decoration: none; }
.kx-btn-onbrand:hover { background: rgba(255,255,255,.16) !important; }

/* Rakenne */
.kx-shell { display: flex; align-items: flex-start; gap: 24px; max-width: 1240px; margin: 0 auto; padding: 24px; }
.kx-shell-single { display: block; }
.kx-main { flex: 1; min-width: 0; }

/* Sivupalkki */
.kx-sidebar { flex: 0 0 264px; background: #fff; border: 1px solid #e3e8ef; border-radius: 16px; padding: 14px; position: sticky; top: 84px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.kx-sidebar-head { font-size: 11px; font-weight: 700; color: #94a3b8; letter-spacing: .8px; text-transform: uppercase; margin: 2px 6px 10px; }
.kx-site-list { display: flex; flex-direction: column; gap: 2px; max-height: 52vh; overflow-y: auto; margin-bottom: 10px; }
.kx-site-row { position: relative; display: flex; align-items: center; justify-content: space-between; border-radius: 10px; padding: 2px; transition: background .15s; }
.kx-site-row:hover { background: #f8fafc; }
.kx-site-row.active { background: #eef5ff; }
.kx-site-row.active::before { content: ''; position: absolute; left: -14px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: #0878E8; }
.kx-site-name { flex: 1; min-width: 0; text-align: left; background: none; border: none; padding: 9px 10px; font-size: 14px; font-weight: 600; color: #0f172a; border-radius: 10px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.kx-site-row.active .kx-site-name { color: #0a1428; font-weight: 700; }
.kx-site-client { font-size: 11.5px; font-weight: 500; color: #94a3b8; }
.kx-site-row.active .kx-site-client { color: #4a8fe0; }
.kx-site-name-static { flex: 1; padding: 8px 10px; font-size: 13px; color: #64748b; }
.kx-site-actions { display: flex; gap: 2px; align-items: center; opacity: 0; transition: opacity .15s; }
.kx-site-row:hover .kx-site-actions, .kx-site-row.active .kx-site-actions { opacity: 1; }
.kx-icon-btn { background: none; border: none; font-size: 13px; padding: 6px 7px; border-radius: 8px; cursor: pointer; color: #64748b; line-height: 1; }
.kx-icon-btn:hover { background: #e8edf4; color: #0f172a; }
.kx-icon-btn-danger:hover { background: #fff1e6; }
.kx-site-edit { display: flex; align-items: center; gap: 4px; width: 100%; }
.kx-add-row { margin-top: 4px; }
.kx-add-site-btn { width: 100%; padding: 10px; border: 1.5px dashed #cbd3df; border-radius: 10px; background: none; color: #64748b; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s; }
.kx-add-site-btn:hover { border-color: #0878E8; color: #0878E8; background: #f5f9ff; }
.kx-archived-toggle { width: 100%; text-align: left; background: none; border: none; font-size: 12px; color: #94a3b8; padding: 12px 6px 2px; cursor: pointer; border-top: 1px solid #eef1f6; margin-top: 12px; }
.kx-archived-list { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; max-height: 24vh; overflow-y: auto; }

/* Pääotsikko */
.kx-empty-main { background: #fff; border: 1px solid #e3e8ef; border-radius: 16px; padding: 56px 32px; text-align: center; color: #64748b; font-size: 15px; line-height: 1.6; }
.kx-main-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; gap: 16px; flex-wrap: wrap; }
.kx-main-title { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 26px; font-weight: 800; color: #0a1428; letter-spacing: -.4px; line-height: 1.15; }
.kx-main-sub { font-size: 13.5px; color: #64748b; margin-top: 4px; }
.kx-main-head-actions { display: flex; gap: 8px; }
.kx-client-select { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 12.5px; color: #64748b; font-weight: 600; flex-wrap: wrap; }
.kx-client-select select { width: auto; max-width: 300px; }

/* Napit */
.kx-btn-primary { background: #0878E8; border: 1px solid #0878E8; border-radius: 10px; color: #fff; font-size: 13.5px; font-weight: 600; padding: 9px 16px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; box-shadow: 0 1px 2px rgba(8,120,232,.25), inset 0 1px 0 rgba(255,255,255,.15); transition: background .15s, transform .05s; text-decoration: none; }
.kx-btn-primary:hover { background: #0667c9; }
.kx-btn-primary:active { transform: translateY(1px); }
.kx-btn-primary:disabled { opacity: .5; cursor: default; background: #94a3b8; border-color: #94a3b8; box-shadow: none; }
.kx-btn-ghost { background: #fff; border: 1px solid #dbe1ea; border-radius: 10px; color: #334155; font-size: 13.5px; font-weight: 600; padding: 9px 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; transition: all .15s; text-decoration: none; }
.kx-btn-ghost:hover { background: #f8fafc; border-color: #cbd3df; }
.kx-btn-sm { padding: 6px 11px; font-size: 12.5px; border-radius: 8px; }
.kx-delete-btn { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; color: #dc2626; font-size: 12px; font-weight: 600; padding: 6px 10px; cursor: pointer; }
.kx-error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; }

/* Välilehdet */
.kx-tabs { display: flex; gap: 22px; margin-bottom: 20px; border-bottom: 1px solid #e3e8ef; overflow-x: auto; scrollbar-width: none; }
.kx-tab { padding: 10px 0 12px; font-size: 14px; font-weight: 600; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; background: none; color: #64748b; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; transition: color .15s; }
.kx-tab:hover:not(.active) { color: #0f172a; }
.kx-tab.active { border-bottom-color: #0878E8; color: #0a1428; }
.kx-tab-count { font-style: normal; font-size: 11.5px; font-weight: 700; background: #eef1f6; color: #64748b; padding: 1px 8px; border-radius: 10px; }
.kx-tab.active .kx-tab-count { background: #0878E8; color: #fff; }

/* Kortit */
.kx-card { background: #fff; border: 1px solid #e3e8ef; border-radius: 16px; padding: 18px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.kx-card-title { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 14.5px; font-weight: 700; color: #0a1428; margin-bottom: 12px; }
.kx-overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; }
.kx-recent-obs, .kx-worksite-summary, .kx-trend { grid-column: 1 / -1; }

/* Tunnusluvut */
.kx-kpis { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; background: none; border: none; padding: 0; box-shadow: none; }
.kx-kpi { position: relative; background: #fff; border: 1px solid #e3e8ef; border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column-reverse; gap: 6px; text-align: left; font-family: inherit; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
button.kx-kpi { cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .15s; }
button.kx-kpi:hover { border-color: #cbd3df; box-shadow: 0 6px 18px rgba(15,23,42,.07); transform: translateY(-1px); }
.kx-kpi-num { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 30px; font-weight: 800; line-height: 1; letter-spacing: -.5px; }
.kx-kpi-label { font-size: 12.5px; color: #64748b; font-weight: 600; }

.kx-summary-badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.kx-badge { font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 20px; background: #f1f4f9; color: #334155; }
.kx-badge-main { background: #0a1428; color: #fff; }
.kx-table-wrap { overflow-x: auto; }
.kx-yritys-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.kx-yritys-table th { text-align: right; font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; padding: 8px 10px; border-bottom: 1px solid #e3e8ef; white-space: nowrap; }
.kx-yritys-table th:first-child { text-align: left; }
.kx-yritys-table td { text-align: right; padding: 10px; border-bottom: 1px solid #f1f4f9; color: #0f172a; font-weight: 600; white-space: nowrap; }
.kx-yritys-table td:first-child { text-align: left; white-space: normal; }
.kx-yritys-table tbody tr:hover td { background: #f8fafc; }
.kx-yritys-table tbody tr:last-child td { border-bottom: none; }
.kx-recent-obs-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f1f4f9; font-size: 13.5px; }
.kx-recent-obs-row:last-child { border-bottom: none; }
.kx-sev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.kx-sev-dot.sev-Kriittinen { background: #dc2626; box-shadow: 0 0 0 3px rgba(220,38,38,.12); }
.kx-sev-dot.sev-Huomio { background: #d97706; box-shadow: 0 0 0 3px rgba(217,119,6,.12); }
.kx-sev-dot.sev-Info { background: #059669; box-shadow: 0 0 0 3px rgba(5,150,105,.12); }
.kx-recent-obs-text { flex: 1; color: #0f172a; font-weight: 500; }
.kx-recent-obs-date { color: #94a3b8; font-size: 12px; flex-shrink: 0; }

.kx-measure-summary-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.kx-measure-summary-title { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 14.5px; font-weight: 700; color: #0a1428; }
.kx-measure-summary-sub { font-size: 12px; color: #64748b; margin-top: 3px; }
.kx-measure-summary-pct { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 32px; font-weight: 800; letter-spacing: -.5px; }
.kx-measure-summary-cats { border-top: 1px solid #f1f4f9; margin-top: 14px; padding-top: 10px; display: flex; flex-direction: column; gap: 2px; }
.kx-measure-summary-cat-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; padding: 5px 0; }
.kx-measure-summary-cat-label { color: #334155; }
.kx-measure-summary-cat-vals { color: #94a3b8; font-variant-numeric: tabular-nums; }
.kx-measure-summary-cat-vals .ok { color: #059669; }
.kx-measure-summary-cat-vals .no { color: #dc2626; }

/* Lomakkeet */
.kx-checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #334155; margin-bottom: 16px; cursor: pointer; }
.kx-obs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.kx-obs-card { display: flex; flex-direction: column; gap: 12px; }
.kx-obs-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.kx-obs-index { font-size: 11.5px; font-weight: 600; color: #94a3b8; letter-spacing: .3px; }
.kx-obs-tags { display: flex; gap: 6px; flex-shrink: 0; }
.kx-tag { font-size: 11px; font-weight: 700; padding: 4px 9px; border-radius: 20px; white-space: nowrap; }
.kx-field { display: flex; flex-direction: column; gap: 5px; }
.kx-field-row { display: flex; gap: 10px; }
.kx-field-row .kx-field { flex: 1; }
.kx-label { font-size: 11px; font-weight: 700; color: #64748b; letter-spacing: .5px; text-transform: uppercase; }
.kx-label-flat { margin-bottom: 0; }
.kx-input { background: #fff; border: 1px solid #dbe1ea; border-radius: 10px; color: #0f172a; font-size: 14px; padding: 9px 12px; width: 100%; outline: none; font-family: inherit; transition: border-color .15s, box-shadow .15s; }
.kx-input:focus { border-color: #0878E8; box-shadow: 0 0 0 3px rgba(8,120,232,.14); }
.kx-input:disabled { background: #f8fafc; color: #94a3b8; }
.kx-input-sm { padding: 7px 10px; font-size: 13px; border-radius: 8px; }
.kx-textarea { resize: vertical; min-height: 56px; line-height: 1.5; }
.kx-btn-choice-row { display: inline-flex; gap: 2px; flex-wrap: wrap; background: #f1f4f9; padding: 3px; border-radius: 10px; align-self: flex-start; }
.kx-choice-btn { padding: 7px 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600; border: none; background: transparent; color: #64748b; cursor: pointer; transition: all .15s; }
.kx-choice-btn:hover:not(.active) { color: #0f172a; }
.kx-choice-btn.active { background: #fff; font-weight: 700; box-shadow: 0 1px 3px rgba(15,23,42,.12); }
.kx-obs-meta { font-size: 11.5px; color: #94a3b8; }
.kx-obs-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid #f1f4f9; padding-top: 12px; margin-top: 2px; flex-wrap: wrap; }

/* Mittaukset */
.kx-measure-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.kx-measure-list { display: flex; flex-direction: column; gap: 10px; }
.kx-measure-row { padding: 14px 18px; }
.kx-measure-row-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.kx-measure-row-date { font-size: 14px; font-weight: 700; color: #0f172a; }
.kx-measure-row-sub { font-size: 12px; color: #64748b; margin-top: 2px; }
.kx-measure-row-actions { display: flex; align-items: center; gap: 8px; }
.kx-measure-pct { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 20px; font-weight: 800; margin-right: 4px; }
.kx-measure-edit { margin-top: 14px; padding-top: 14px; border-top: 1px solid #f1f4f9; display: flex; flex-direction: column; gap: 10px; }
.kx-measure-cat { background: #f8fafc; border: 1px solid #eef1f6; border-radius: 12px; padding: 12px; }
.kx-measure-cat-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.kx-measure-cat-label { font-size: 13.5px; font-weight: 700; color: #0f172a; }
.kx-measure-cat-pct { font-size: 12.5px; font-weight: 700; }
.kx-count-row { display: flex; gap: 8px; }
.kx-count-btn { flex: 1; padding: 10px 4px; border-radius: 10px; font-weight: 700; font-size: 13px; cursor: pointer; }
.kx-count-btn.ok { border: 1px solid #a7e3cb; background: #ecfdf5; color: #059669; }
.kx-count-btn.no { border: 1px solid #fecaca; background: #fef2f2; color: #dc2626; }
.kx-count-btn.undo { flex: 0 0 auto; padding: 10px 12px; border: 1px solid #dbe1ea; background: #fff; color: #64748b; }
.kx-legal-note { font-size: 11.5px; color: #94a3b8; line-height: 1.55; padding: 14px 2px 4px; }
.kx-note-toggle { margin-top: 10px; background: none; border: none; padding: 4px 0; font-size: 12.5px; font-weight: 700; display: flex; align-items: center; gap: 5px; cursor: pointer; }
.kx-note-list { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; padding-top: 10px; border-top: 1px solid #f1f4f9; }
.kx-note-item { background: #fff; border: 1px solid #eef1f6; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.kx-note-row { display: flex; align-items: center; gap: 8px; }
.kx-note-field { background: #fff; border: 1px solid #dbe1ea; border-radius: 8px; color: #0f172a; font-size: 13px; padding: 8px 10px; width: 100%; outline: none; resize: none; font-family: inherit; }
.kx-note-checklabel { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #0f172a; }
.kx-note-del { background: none; border: none; color: #64748b; font-size: 15px; cursor: pointer; }
.kx-note-add { padding: 9px 4px; border: 1.5px dashed #cbd3df; border-radius: 10px; background: none; color: #64748b; font-size: 12.5px; cursor: pointer; }
.kx-empty-note { text-align: center; padding: 28px 20px; color: #64748b; font-size: 13.5px; background: #fff; border: 1px dashed #dbe1ea; border-radius: 14px; }

.kx-toast { position: fixed; bottom: 24px; right: 24px; background: #0a1428; color: #fff; font-size: 13.5px; font-weight: 600; padding: 12px 18px; border-radius: 12px; box-shadow: 0 10px 30px rgba(10,20,40,.3); z-index: 50; }

.kx-pdf-overlay { position: fixed; inset: 0; background: rgba(10,20,40,.55); backdrop-filter: blur(4px); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 16px; }
.kx-pdf-overlay > * { width: 100%; max-width: 440px; }
.kx-pdf-overlay-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #0a1428; border-radius: 16px 16px 0 0; }
.kx-pdf-close { background: rgba(255,255,255,.12); border: none; color: #fff; width: 32px; height: 32px; border-radius: 50%; font-size: 16px; cursor: pointer; }
.kx-pdf-title { font-size: 15px; font-weight: 700; color: #fff; }
.kx-pdf-share { background: #0878E8; border: none; color: #fff; font-size: 13px; font-weight: 700; padding: 8px 16px; border-radius: 9px; cursor: pointer; }
.kx-pdf-body { background: #fff; border-radius: 0 0 16px 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 36px 28px; }
.kx-pdf-icon { font-size: 56px; }
.kx-pdf-text { font-size: 14px; color: #64748b; text-align: center; line-height: 1.6; }
.kx-pdf-text.success { color: #059669; font-weight: 600; }
.kx-pdf-text.success span { color: #64748b; font-weight: 400; }

.kx-reminders { max-width: 1240px; margin: 20px auto 0; padding: 0 24px; display: flex; flex-direction: column; gap: 8px; }
.kx-reminder { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #fff8e6; border: 1px solid #f5d38a; border-radius: 12px; padding: 10px 14px; font-size: 13.5px; color: #7a5b00; flex-wrap: wrap; }
.kx-site-ended { font-size: 11px; font-weight: 600; color: #94a3b8; }
.kx-modal { background: #fff; border-radius: 18px; padding: 24px; display: flex; flex-direction: column; gap: 14px; max-width: 460px; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
.kx-modal-title { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 20px; font-weight: 800; color: #0a1428; }
.kx-modal-list { margin: 0; padding-left: 18px; font-size: 13.5px; color: #334155; line-height: 1.7; }
.kx-modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.kx-trend-svg { width: 100%; height: auto; display: block; margin-top: 10px; overflow: visible; }
.kx-trend-legend { display: flex; gap: 14px; font-size: 12px; color: #64748b; flex-wrap: wrap; }
.kx-trend-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.kx-plain-btn { width: 100%; background: none; border: none; padding: 0; cursor: pointer; font-family: inherit; }
.kx-recent-obs-row .kx-tag { flex-shrink: 0; }

@media (max-width: 860px) {
  .kx-topbar { flex-wrap: wrap; gap: 10px; padding: 10px 14px; position: static; }
  .kx-topbar-actions { flex-wrap: wrap; width: 100%; justify-content: space-between; }
  .kx-viewswitch { flex: 1; overflow-x: auto; }
  .kx-viewswitch button { padding: 7px 10px; font-size: 12.5px; }
  .kx-hide-mobile, .kx-user-chip { display: none; }
  .kx-shell { flex-direction: column; align-items: stretch; padding: 14px; gap: 14px; }
  .kx-main { width: 100%; }
  .kx-brand-sub { display: none; }
  .kx-sidebar { flex: none; width: 100%; position: static; }
  .kx-site-list { max-height: none; }
  .kx-site-actions { opacity: 1; }
  .kx-site-row.active::before { display: none; }
  .kx-obs-grid { grid-template-columns: 1fr; }
  .kx-main-title { font-size: 22px; }
  .kx-main-head-actions { width: 100%; flex-wrap: wrap; }
  .kx-main-head-actions > * { flex: 1; justify-content: center; }
  .kx-tabs { gap: 18px; }
}
`
