import React, { useState, useEffect, useCallback, useRef } from 'react'
import { sb } from './supabaseClient.js'
import {
  TR_CATEGORIES, MVR_CATEGORIES, TR_LEGAL_NOTE, MVR_LEGAL_NOTE,
  emptyCounts, categoryPct, overallIndex, indexColor, SEV_LABELS, buildReportPDF, summarizeObservations,
} from './shared.js'

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
// HUOM: valokuvat eivät synkronoidu pilveen (vain laitteen omalla luonnoksella
// kenttäsovelluksessa) — Valvomo ja sen PDF-vienti eivät siis koskaan
// sisällä kuvia, vain tekstimuotoiset havainnot ja mittaustulokset.
export default function Dashboard() {
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
  }, [])

  useEffect(() => { loadWorksites() }, [loadWorksites])

  const loadSite = useCallback(async (siteName) => {
    if (!siteName) { setObs([]); setTrRows([]); setMvrRows([]); return }
    setLoading(true)
    setErrMsg('')
    try {
      const [obsRes, trRes, mvrRes] = await Promise.all([
        sb.from('safety_observations').select('*').eq('site', siteName).order('created_at', { ascending: false }),
        sb.from('safety_measurements').select('*').eq('site', siteName).eq('type', 'tr').eq('archived', false).order('created_at', { ascending: false }),
        sb.from('safety_measurements').select('*').eq('site', siteName).eq('type', 'mvr').eq('archived', false).order('created_at', { ascending: false }),
      ])
      if (obsRes.error || trRes.error || mvrRes.error) throw (obsRes.error || trRes.error || mvrRes.error)
      setObs(obsRes.data || [])
      setTrRows(trRes.data || [])
      setMvrRows(mvrRes.data || [])
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
    if (selected) loadSite(selected.name)
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
    const { error } = await sb.from('safety_observations')
      .update({ havainto: o.havainto, yritys: o.yritys, sev: o.sev, note: o.note, status: o.status })
      .eq('id', o.id)
    if (!error) {
      setObs(prev => prev.map(x => x.id === o.id ? { ...x, _dirty: false } : x))
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

  // --- Mittausten hallinta (koko historia, ei vain viimeisin) ---
  function startEditMeasure(type, row) {
    setEditMeasure({ type, id: row.id, counts: row.counts || emptyCounts(type === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES) })
  }

  async function addNewMeasurement(type) {
    if (!selected) return
    const categories = type === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES
    const counts = emptyCounts(categories)
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
    const pdfObs = activeObs.map(o => ({
      havainto: o.havainto, yritys: o.yritys, sev: o.sev, note: o.note, status: o.status,
      createdAt: o.created_at, photos: [],
    }))
    const { blob, filename } = await buildReportPDF({
      site: selected.name,
      inspector: distinctInspectors,
      trCounts: trLatest?.counts || emptyCounts(TR_CATEGORIES),
      mvrCounts: mvrLatest?.counts || emptyCounts(MVR_CATEGORIES),
      obs: pdfObs,
    })
    setPdfBlob(blob); setPdfName(filename); setPdfDownloaded(false); setPdfMode(true)
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

  return (
    <div className="kx-dashboard">
      <style>{DASHBOARD_CSS}</style>

      {/* Topbar */}
      <div className="kx-topbar">
        <div className="kx-brand">
          <img className="kx-brand-mark" src="/korpnex-icon.png" alt="Korpnex" />
          <span className="kx-brand-name">KORPNEX</span>
          <span className="kx-brand-sub">· Valvomo</span>
        </div>
        <div className="kx-topbar-actions">
          <a className="kx-btn-ghost kx-btn-onbrand" href="./" target="_blank" rel="noreferrer">📱 Kenttäsovellus</a>
        </div>
      </div>

      <div className="kx-shell">
        {/* Sidebar: työmaiden hallinta */}
        <aside className="kx-sidebar">
          <div className="kx-sidebar-head">Työmaat</div>
          <div className="kx-site-list">
            {worksites.length === 0 && <div className="kx-empty-note">Ei vielä työmaita.</div>}
            {worksites.map(w => (
              <div key={w.id} className={`kx-site-row ${selected?.id === w.id ? 'active' : ''}`}>
                {editingSiteId === w.id ? (
                  <div className="kx-site-edit">
                    <input autoFocus className="kx-input kx-input-sm" value={editSiteName}
                      onChange={e => setEditSiteName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') renameWorksite(w); if (e.key === 'Escape') setEditingSiteId(null) }} />
                    <button className="kx-icon-btn" title="Tallenna" onClick={() => renameWorksite(w)}>✓</button>
                    <button className="kx-icon-btn" title="Peruuta" onClick={() => setEditingSiteId(null)}>✕</button>
                  </div>
                ) : (
                  <>
                    <button className="kx-site-name" onClick={() => setSelected(w)}>{w.name}</button>
                    <div className="kx-site-actions">
                      <button className="kx-icon-btn" title="Nimeä uudelleen" onClick={() => { setEditingSiteId(w.id); setEditSiteName(w.name) }}>✏️</button>
                      <button className="kx-icon-btn" title="Arkistoi" onClick={() => archiveWorksite(w)}>🗄</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          {!addingSite ? (
            <button className="kx-add-site-btn" onClick={() => { setAddingSite(true); setNewSiteName('') }}>＋ Uusi työmaa</button>
          ) : (
            <div className="kx-site-edit kx-add-row">
              <input autoFocus className="kx-input kx-input-sm" placeholder="Työmaan nimi" value={newSiteName}
                onChange={e => setNewSiteName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addWorksite(); if (e.key === 'Escape') setAddingSite(false) }} />
              <button className="kx-icon-btn" title="Lisää" onClick={addWorksite}>✓</button>
              <button className="kx-icon-btn" title="Peruuta" onClick={() => setAddingSite(false)}>✕</button>
            </div>
          )}

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
        </aside>

        {/* Pääsisältö: valitun työmaan tiedot */}
        <main className="kx-main">
          {!selected ? (
            <div className="kx-empty-main">📍 Lisää tai valitse työmaa vasemmalta aloittaaksesi.</div>
          ) : (
            <>
              <div className="kx-main-head">
                <div>
                  <div className="kx-main-title">{selected.name}</div>
                  <div className="kx-main-sub">{loading ? 'Ladataan…' : `${activeObs.length} havaintoa`}</div>
                </div>
                <div className="kx-main-head-actions">
                  <button className="kx-btn-ghost" onClick={refresh}>🔄 Päivitä</button>
                  <button className="kx-btn-primary" onClick={exportPDF}>📄 Vie PDF-raportti</button>
                </div>
              </div>

              {errMsg && <div className="kx-error">{errMsg}</div>}

              <div className="kx-tabs">
                {[
                  ['yhteenveto', 'Yhteenveto'],
                  ['havainnot', `Havainnot${activeObs.length ? ` (${activeObs.length})` : ''}`],
                  ['tr', `TR-mittaus${trResult.total ? ` (${trResult.pct}%)` : ''}`],
                  ['mvr', `MVR-mittaus${mvrResult.total ? ` (${mvrResult.pct}%)` : ''}`],
                ].map(([key, label]) => (
                  <button key={key} className={`kx-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
                ))}
              </div>

              <div className="kx-tab-content">
                {tab === 'yhteenveto' && (
                  <div className="kx-overview-grid">
                    <MeasurementSummary title="TR-mittaus" categories={TR_CATEGORIES} row={trLatest} />
                    <MeasurementSummary title="MVR-mittaus" categories={MVR_CATEGORIES} row={mvrLatest} />
                    <WorksiteSummary obs={activeObs} />
                    <div className="kx-card kx-recent-obs">
                      <div className="kx-card-title">Viimeisimmät havainnot</div>
                      {activeObs.length === 0 && <div className="kx-empty-note">Ei havaintoja.</div>}
                      {activeObs.slice(0, 6).map(o => (
                        <div key={o.id} className="kx-recent-obs-row">
                          <span className={`kx-sev-dot sev-${o.sev}`} />
                          <span className="kx-recent-obs-text">{o.havainto || '(ei kuvausta)'}</span>
                          {o.created_at && <span className="kx-recent-obs-date">{new Date(o.created_at).toLocaleDateString('fi-FI')}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {tab === 'havainnot' && (
                  <ObservationsPanel
                    obs={obs} showArchived={showArchivedObs} setShowArchived={setShowArchivedObs}
                    onChange={updateLocalObs} onSave={saveObs} onToggleArchive={toggleArchiveObs}
                  />
                )}

                {(tab === 'tr' || tab === 'mvr') && (
                  <MeasurementPanel
                    type={tab}
                    categories={tab === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES}
                    legalNote={tab === 'tr' ? TR_LEGAL_NOTE : MVR_LEGAL_NOTE}
                    rows={tab === 'tr' ? trRows : mvrRows}
                    editMeasure={editMeasure}
                    onStartEdit={startEditMeasure}
                    onCancelEdit={() => setEditMeasure(null)}
                    onBumpEdit={bumpEdit}
                    onSaveEdit={saveEditMeasure}
                    onArchive={archiveMeasurement}
                    onAddNew={addNewMeasurement}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>

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
  const sevColor = { Kriittinen: '#d63030', Huomio: '#d07800', Info: '#1a8a50' }
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
            <span className="kx-badge" style={{ color: '#d07800' }}>Avoinna {summary.byStatus.avoin}</span>
            <span className="kx-badge" style={{ color: '#1a8a50' }}>Korjattu {summary.byStatus.korjattu}</span>
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
                    <td style={{ color: row.avoin ? '#d07800' : '#9aa2c0' }}>{row.avoin}</td>
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
function ObservationsPanel({ obs, showArchived, setShowArchived, onChange, onSave, onToggleArchive }) {
  const sevColor = { Kriittinen: '#d63030', Huomio: '#d07800', Info: '#1a8a50' }
  const sevBg = { Kriittinen: 'rgba(214,48,48,0.1)', Huomio: 'rgba(245,168,0,0.12)', Info: 'rgba(26,138,80,0.1)' }
  const list = obs.filter(o => showArchived ? o.archived : !o.archived)
  return (
    <div className="kx-obs-panel">
      <label className="kx-checkbox-row">
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
        Näytä arkistoidut havainnot
      </label>
      {list.length === 0 && (
        <div className="kx-empty-note">{showArchived ? 'Ei arkistoituja havaintoja.' : 'Ei havaintoja tällä työmaalla.'}</div>
      )}
      <div className="kx-obs-grid">
        {list.map(o => (
          <div key={o.id} className="kx-card kx-obs-card">
            <div className="kx-obs-card-head">
              <span className="kx-obs-index">Havainto</span>
              <div className="kx-obs-tags">
                <span className="kx-tag" style={{ background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span>
                <span className="kx-tag kx-status-tag" style={o.status === 'korjattu' ? { background: 'rgba(26,138,80,0.1)', color: '#1a8a50' } : { background: '#eef0f5', color: '#6a7086' }}>
                  {o.status === 'korjattu' ? '✓ Korjattu' : 'Avoin'}
                </span>
              </div>
            </div>
            <div className="kx-field">
              <div className="kx-label">Havainto</div>
              <input className="kx-input" value={o.havainto || ''} onChange={e => onChange(o.id, 'havainto', e.target.value)} />
            </div>
            <div className="kx-field-row">
              <div className="kx-field">
                <div className="kx-label">Yritys</div>
                <input className="kx-input" value={o.yritys || ''} onChange={e => onChange(o.id, 'yritys', e.target.value)} />
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
                  <button key={s} className="kx-choice-btn" style={{
                    borderColor: o.sev === s ? sevColor[s] : '#d3d6e0',
                    background: o.sev === s ? sevBg[s] : '#f4f5f8',
                    color: o.sev === s ? sevColor[s] : '#6a7086',
                  }} onClick={() => onChange(o.id, 'sev', s)}>{s}</button>
                ))}
              </div>
            </div>
            <div className="kx-field">
              <div className="kx-label">Tila</div>
              <div className="kx-btn-choice-row">
                {['avoin', 'korjattu'].map(s => (
                  <button key={s} className="kx-choice-btn" style={{
                    borderColor: o.status === s ? '#17275c' : '#d3d6e0',
                    background: o.status === s ? '#eef0f5' : '#f4f5f8',
                    color: o.status === s ? '#17275c' : '#6a7086',
                  }} onClick={() => onChange(o.id, 'status', s)}>{s === 'korjattu' ? '✓ Korjattu' : 'Avoin'}</button>
                ))}
              </div>
            </div>
            <div className="kx-field">
              <div className="kx-label">Lisätieto</div>
              <textarea className="kx-input kx-textarea" value={o.note || ''} onChange={e => onChange(o.id, 'note', e.target.value)} />
            </div>
            {o.created_at && (
              <div className="kx-obs-meta">🕒 {new Date(o.created_at).toLocaleString('fi-FI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
            )}
            <div className="kx-obs-card-foot">
              <button className="kx-btn-ghost kx-btn-sm" onClick={() => onToggleArchive(o)}>{o.archived ? '↺ Palauta' : '🗄 Arkistoi'}</button>
              <button className="kx-btn-primary kx-btn-sm" disabled={!o._dirty} onClick={() => onSave(o)}>
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
function MeasurementPanel({ type, categories, legalNote, rows, editMeasure, onStartEdit, onCancelEdit, onBumpEdit, onSaveEdit, onArchive, onAddNew }) {
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
                    const cnt = editMeasure.counts[c.key] || { oikein: 0, vaarin: 0 }
                    const cpct = categoryPct(cnt)
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

const DASHBOARD_CSS = `
.kx-dashboard { min-height: 100%; background: #eef0f5; color: #14183a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
.kx-dashboard * { box-sizing: border-box; }
.kx-topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: #17275c; position: sticky; top: 0; z-index: 20; }
.kx-brand { display: flex; align-items: center; gap: 8px; }
.kx-brand-mark { width: 32px; height: 32px; border-radius: 8px; object-fit: cover; display: block; }
.kx-brand-name { font-size: 17px; font-weight: 800; color: #fff; letter-spacing: 0.5px; }
.kx-brand-sub { font-size: 11px; color: rgba(255,255,255,0.55); font-weight: 500; margin-left: 2px; }
.kx-topbar-actions { display: flex; align-items: center; gap: 8px; }
.kx-btn-onbrand { background: rgba(255,255,255,0.15); color: #fff; border: none; text-decoration: none; }
.kx-btn-onbrand:hover { background: rgba(255,255,255,0.25); }

.kx-shell { display: flex; align-items: flex-start; gap: 20px; max-width: 1180px; margin: 0 auto; padding: 20px; }
.kx-sidebar { flex: 0 0 260px; background: #fff; border: 1px solid #d3d6e0; border-radius: 12px; padding: 14px; position: sticky; top: 76px; }
.kx-sidebar-head { font-size: 11px; font-weight: 700; color: #6a7086; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 8px; }
.kx-site-list { display: flex; flex-direction: column; gap: 3px; max-height: 40vh; overflow-y: auto; margin-bottom: 8px; }
.kx-site-row { display: flex; align-items: center; justify-content: space-between; border-radius: 8px; padding: 2px; }
.kx-site-row.active { background: #eef0f5; }
.kx-site-name { flex: 1; text-align: left; background: none; border: none; padding: 8px 8px; font-size: 13.5px; font-weight: 600; color: #14183a; border-radius: 8px; cursor: pointer; }
.kx-site-name:hover { background: #f4f5f8; }
.kx-site-row.active .kx-site-name { color: #17275c; font-weight: 800; }
.kx-site-name-static { flex: 1; padding: 8px 8px; font-size: 13px; color: #6a7086; }
.kx-site-actions { display: flex; gap: 2px; opacity: 0.7; }
.kx-site-row:hover .kx-site-actions { opacity: 1; }
.kx-icon-btn { background: none; border: none; font-size: 13px; padding: 5px 6px; border-radius: 6px; cursor: pointer; color: #6a7086; }
.kx-icon-btn:hover { background: #eef0f5; }
.kx-site-edit { display: flex; align-items: center; gap: 4px; width: 100%; }
.kx-add-row { margin-top: 4px; }
.kx-add-site-btn { width: 100%; padding: 9px; border: 1.5px dashed #b3b8c8; border-radius: 8px; background: none; color: #6a7086; font-size: 13px; cursor: pointer; }
.kx-add-site-btn:hover { background: #f4f5f8; }
.kx-archived-toggle { width: 100%; text-align: left; background: none; border: none; font-size: 11.5px; color: #6a7086; padding: 10px 2px 2px; cursor: pointer; border-top: 1px solid #eef0f5; margin-top: 10px; }
.kx-archived-list { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; max-height: 24vh; overflow-y: auto; }

.kx-main { flex: 1; min-width: 0; }
.kx-empty-main { background: #fff; border: 1px solid #d3d6e0; border-radius: 12px; padding: 48px 24px; text-align: center; color: #6a7086; font-size: 14px; }
.kx-main-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 12px; flex-wrap: wrap; }
.kx-main-title { font-size: 22px; font-weight: 800; color: #17275c; }
.kx-main-sub { font-size: 12.5px; color: #6a7086; margin-top: 2px; }
.kx-main-head-actions { display: flex; gap: 8px; }
.kx-btn-primary { background: #17275c; border: none; border-radius: 8px; color: #fff; font-size: 13.5px; font-weight: 700; padding: 10px 16px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.kx-btn-primary:hover { background: #223a8c; }
.kx-btn-primary:disabled { opacity: 0.45; cursor: default; background: #9aa2c0; }
.kx-btn-ghost { background: #eef0f5; border: 1px solid #d3d6e0; border-radius: 8px; color: #3a3f5c; font-size: 13px; font-weight: 700; padding: 9px 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.kx-btn-ghost:hover { background: #e2e5ee; }
.kx-btn-sm { padding: 6px 10px; font-size: 12px; }
.kx-error { background: rgba(214,48,48,0.08); color: #d63030; border: 1px solid rgba(214,48,48,0.3); border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 12px; }

.kx-tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #d3d6e0; flex-wrap: wrap; }
.kx-tab { padding: 10px 16px; border-radius: 10px 10px 0 0; font-size: 13px; font-weight: 700; border: none; border-bottom: 3px solid transparent; background: none; color: #6a7086; cursor: pointer; }
.kx-tab.active { border-bottom: 3px solid #223a8c; color: #17275c; background: #fff; }
.kx-tab:hover:not(.active) { color: #17275c; }

.kx-card { background: #fff; border: 1px solid #d3d6e0; border-radius: 12px; padding: 14px; }
.kx-card-title { font-size: 13px; font-weight: 800; color: #17275c; margin-bottom: 10px; }

.kx-overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; align-items: start; }
.kx-recent-obs { grid-column: 1 / -1; }
.kx-worksite-summary { grid-column: 1 / -1; }
.kx-summary-badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.kx-badge { font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 20px; background: #f4f5f8; color: #3a3f5c; }
.kx-badge-main { background: #17275c; color: #fff; }
.kx-table-wrap { overflow-x: auto; }
.kx-yritys-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.kx-yritys-table th { text-align: right; font-size: 10.5px; font-weight: 700; color: #6a7086; text-transform: uppercase; letter-spacing: 0.4px; padding: 6px 8px; border-bottom: 1px solid #d3d6e0; white-space: nowrap; }
.kx-yritys-table th:first-child { text-align: left; }
.kx-yritys-table td { text-align: right; padding: 8px; border-bottom: 1px solid #eef0f5; color: #14183a; font-weight: 600; white-space: nowrap; }
.kx-yritys-table td:first-child { text-align: left; font-weight: 700; white-space: normal; }
.kx-yritys-table tbody tr:last-child td { border-bottom: none; }
.kx-recent-obs-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid #eef0f5; font-size: 13px; }
.kx-recent-obs-row:last-child { border-bottom: none; }
.kx-sev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.kx-sev-dot.sev-Kriittinen { background: #d63030; }
.kx-sev-dot.sev-Huomio { background: #d07800; }
.kx-sev-dot.sev-Info { background: #1a8a50; }
.kx-recent-obs-text { flex: 1; color: #14183a; }
.kx-recent-obs-date { color: #9aa2c0; font-size: 11.5px; flex-shrink: 0; }

.kx-measure-summary-head { display: flex; align-items: center; justify-content: space-between; }
.kx-measure-summary-title { font-size: 13px; font-weight: 800; color: #17275c; }
.kx-measure-summary-sub { font-size: 11.5px; color: #6a7086; margin-top: 2px; }
.kx-measure-summary-pct { font-size: 26px; font-weight: 800; }
.kx-measure-summary-cats { border-top: 1px solid #eef0f5; margin-top: 10px; padding-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.kx-measure-summary-cat-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.kx-measure-summary-cat-label { color: #3a3f5c; }
.kx-measure-summary-cat-vals { color: #9aa2c0; }
.kx-measure-summary-cat-vals .ok { color: #1a8a50; }
.kx-measure-summary-cat-vals .no { color: #d63030; }

.kx-checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #3a3f5c; margin-bottom: 14px; cursor: pointer; }
.kx-obs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.kx-obs-card { display: flex; flex-direction: column; gap: 10px; }
.kx-obs-card-head { display: flex; align-items: center; justify-content: space-between; }
.kx-obs-index { font-size: 10.5px; font-weight: 700; color: #9aa2c0; letter-spacing: 0.5px; text-transform: uppercase; }
.kx-obs-tags { display: flex; gap: 6px; }
.kx-tag { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 20px; }
.kx-field { display: flex; flex-direction: column; gap: 4px; }
.kx-field-row { display: flex; gap: 10px; }
.kx-field-row .kx-field { flex: 1; }
.kx-label { font-size: 10.5px; font-weight: 700; color: #6a7086; letter-spacing: 0.5px; text-transform: uppercase; }
.kx-label-flat { margin-bottom: 0; }
.kx-input { background: #fff; border: 1px solid #d3d6e0; border-radius: 8px; color: #14183a; font-size: 13.5px; padding: 8px 10px; width: 100%; outline: none; font-family: inherit; }
.kx-input:focus { border-color: #223a8c; }
.kx-input:disabled { background: #f4f5f8; color: #9aa2c0; }
.kx-input-sm { padding: 6px 8px; font-size: 13px; }
.kx-textarea { resize: vertical; min-height: 52px; line-height: 1.5; }
.kx-btn-choice-row { display: flex; gap: 6px; flex-wrap: wrap; }
.kx-choice-btn { padding: 7px 12px; border-radius: 8px; font-size: 12px; font-weight: 700; border: 1px solid #d3d6e0; background: #f4f5f8; color: #6a7086; cursor: pointer; }
.kx-obs-meta { font-size: 11px; color: #9aa2c0; }
.kx-obs-card-foot { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #eef0f5; padding-top: 10px; margin-top: 2px; }

.kx-measure-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.kx-measure-list { display: flex; flex-direction: column; gap: 10px; }
.kx-measure-row-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.kx-measure-row-date { font-size: 13.5px; font-weight: 700; color: #14183a; }
.kx-measure-row-sub { font-size: 11.5px; color: #6a7086; margin-top: 2px; }
.kx-measure-row-actions { display: flex; align-items: center; gap: 8px; }
.kx-measure-pct { font-size: 18px; font-weight: 800; margin-right: 4px; }
.kx-measure-edit { margin-top: 14px; padding-top: 14px; border-top: 1px solid #eef0f5; display: flex; flex-direction: column; gap: 10px; }
.kx-measure-cat { background: #f9fafc; border: 1px solid #eef0f5; border-radius: 10px; padding: 10px; }
.kx-measure-cat-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.kx-measure-cat-label { font-size: 13px; font-weight: 700; color: #14183a; }
.kx-measure-cat-pct { font-size: 12px; font-weight: 700; }
.kx-count-row { display: flex; gap: 8px; }
.kx-count-btn { flex: 1; padding: 9px 4px; border-radius: 8px; font-weight: 700; font-size: 12.5px; cursor: pointer; }
.kx-count-btn.ok { border: 1px solid #1a8a50; background: rgba(26,138,80,0.1); color: #1a8a50; }
.kx-count-btn.no { border: 1px solid #d63030; background: rgba(214,48,48,0.1); color: #d63030; }
.kx-count-btn.undo { flex: 0 0 auto; padding: 9px 12px; border: 1px solid #d3d6e0; background: #eef0f5; color: #6a7086; }
.kx-legal-note { font-size: 11px; color: #9aa2c0; line-height: 1.5; padding: 12px 2px 4px; }
.kx-empty-note { text-align: center; padding: 20px; color: #6a7086; font-size: 13px; background: #f9fafc; border-radius: 10px; }

.kx-toast { position: fixed; bottom: 20px; right: 20px; background: #14183a; color: #fff; font-size: 13px; font-weight: 600; padding: 10px 16px; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.2); z-index: 50; }

.kx-pdf-overlay { position: fixed; inset: 0; background: #f4f5f8; z-index: 100; display: flex; flex-direction: column; }
.kx-pdf-overlay-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; background: #17275c; }
.kx-pdf-close { background: rgba(255,255,255,0.2); border: none; color: #fff; width: 32px; height: 32px; border-radius: 50%; font-size: 18px; cursor: pointer; }
.kx-pdf-title { font-size: 15px; font-weight: 700; color: #fff; }
.kx-pdf-share { background: #c7cbd6; border: none; color: #17275c; font-size: 13px; font-weight: 700; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
.kx-pdf-body { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 32px; }
.kx-pdf-icon { font-size: 64px; }
.kx-pdf-text { font-size: 14px; color: #6a7086; text-align: center; line-height: 1.6; max-width: 360px; }
.kx-pdf-text.success { color: #1a8a50; font-weight: 600; }
.kx-pdf-text.success span { color: #6a7086; font-weight: 400; }

@media (max-width: 820px) {
  .kx-shell { flex-direction: column; padding: 14px; gap: 14px; }
  .kx-sidebar { flex: none; width: 100%; position: static; }
  .kx-site-list { max-height: none; }
  .kx-obs-grid { grid-template-columns: 1fr; }
}
`
