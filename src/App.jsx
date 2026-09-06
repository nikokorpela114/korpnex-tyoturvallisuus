import React, { useState, useEffect, useRef } from 'react'
import { sb } from './supabaseClient.js'
import {
  TR_CATEGORIES, MVR_CATEGORIES, TR_LEGAL_NOTE, MVR_LEGAL_NOTE,
  emptyCounts, categoryPct, overallIndex, indexColor, SEV_LABELS, compressImage, buildReportPDF,
} from './shared.js'
import Dashboard from './Dashboard.jsx'

let idCounter = 0
// Jokaisella työmaalla on oma keskeneräinen luonnoksensa tässä kartassa,
// { [työmaan nimi]: { reportId, obs, trCounts, mvrCounts, trDbId, mvrDbId } }
// — näin eri työmaiden havainnot eivät voi koskaan sekoittua toisiinsa
// samalla laitteella, vaikka tarkastaja vaihtaisi työmaata kesken kaiken.
const DRAFTS_KEY = 'korpnex_tt_drafts_v2'
const LAST_SITE_KEY = 'korpnex_tt_last_site'
const INSPECTOR_KEY = 'korpnex_tt_inspector' // sama tarkastaja riippumatta työmaasta

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
}

function loadDraftsMap() {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

export default function App() {
  // ?valvomo avaa erillisen kooste-/raportointinäkymän kaikista työmaista.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('valvomo')) {
    return <Dashboard />
  }

  const [tab, setTab] = useState('havainnot') // 'havainnot' | 'tr' | 'mvr'
  const [site, setSite] = useState('')
  const [inspector, setInspector] = useState('')
  const [worksites, setWorksites] = useState([])
  const [addingSite, setAddingSite] = useState(false)
  const [newSiteName, setNewSiteName] = useState('')
  const [obs, setObs] = useState([])
  const [trCounts, setTrCounts] = useState(() => emptyCounts(TR_CATEGORIES))
  const [mvrCounts, setMvrCounts] = useState(() => emptyCounts(MVR_CATEGORIES))
  const [trDbId, setTrDbId] = useState(null)
  const [mvrDbId, setMvrDbId] = useState(null)
  const [syncMsg, setSyncMsg] = useState('')
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [pdfMode, setPdfMode] = useState(false)
  const [pdfBlob, setPdfBlob] = useState(null)
  const [pdfName, setPdfName] = useState('')
  const [pdfDownloaded, setPdfDownloaded] = useState(false)

  const reportIdRef = useRef(uuid())
  const restoredRef = useRef(false)
  const syncTimer = useRef(null)
  const trTimer = useRef(null)
  const mvrTimer = useRef(null)
  const obsRef = useRef(obs)
  const metaRef = useRef({ site, inspector })
  // Refs pidetään ajan tasalla joka renderillä, jotta debounced-tallennukset
  // (setTimeout-kutsut) ja online/interval-kuuntelijat lukevat AINA tuoreimman
  // arvon eivätkä jää kiinni siihen state-arvoon joka oli voimassa silloin kun
  // closure luotiin (React-classic "stale closure" -ongelma).
  const trCountsRef = useRef(trCounts)
  const mvrCountsRef = useRef(mvrCounts)
  const trDbIdRef = useRef(trDbId)
  const mvrDbIdRef = useRef(mvrDbId)
  useEffect(() => { obsRef.current = obs }, [obs])
  useEffect(() => { metaRef.current = { site, inspector } }, [site, inspector])
  useEffect(() => { trCountsRef.current = trCounts }, [trCounts])
  useEffect(() => { mvrCountsRef.current = mvrCounts }, [mvrCounts])
  useEffect(() => { trDbIdRef.current = trDbId }, [trDbId])
  useEffect(() => { mvrDbIdRef.current = mvrDbId }, [mvrDbId])

  function showSync(msg) {
    setSyncMsg(msg)
    clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => setSyncMsg(''), 3000)
  }

  // Työmaalista Supabasesta (pudotusvalikkoa varten) -- arkistoidut työmaat
  // (poistettu/hallinnoitu Valvomosta) eivät näy kentän valikossa.
  useEffect(() => {
    sb.from('worksites').select('*').eq('archived', false).order('name').then(({ data, error }) => {
      if (!error && data) setWorksites(data)
    })
  }, [])

  function applyDraft(siteName, d) {
    setSite(siteName)
    reportIdRef.current = d?.reportId || uuid()
    const restoredObs = d?.obs?.length ? d.obs : []
    setObs(restoredObs)
    if (restoredObs.length) idCounter = Math.max(idCounter, ...restoredObs.map(o => o.id || 0))
    setTrCounts(d?.trCounts || emptyCounts(TR_CATEGORIES))
    setMvrCounts(d?.mvrCounts || emptyCounts(MVR_CATEGORIES))
    setTrDbId(d?.trDbId || null)
    setMvrDbId(d?.mvrDbId || null)
    if (d) showSync('↺ Luonnos palautettu')
  }

  // Vaihtaa aktiivisen työmaan: lataa sen oman (mahdollisesti tyhjän)
  // luonnoksen. Nykyisen työmaan tila on jo tallessa jatkuvasti alla olevan
  // tallennus-effectin ansiosta, joten mitään ei voi hukata vaihdossa.
  function selectSite(name) {
    applyDraft(name, loadDraftsMap()[name])
  }

  // --- Luonnon palautus (selviää suljetusta välilehdestä / offline-ajasta) ---
  useEffect(() => {
    try {
      const lastSite = localStorage.getItem(LAST_SITE_KEY) || ''
      const savedInspector = localStorage.getItem(INSPECTOR_KEY) || ''
      if (savedInspector) setInspector(savedInspector)
      if (lastSite) applyDraft(lastSite, loadDraftsMap()[lastSite])
    } catch {}
    restoredRef.current = true
  }, [])

  // Tallentaa AINA nykyisen työmaan omaan kohtaansa kartassa — muiden
  // työmaiden luonnokset pysyvät koskemattomina.
  useEffect(() => {
    if (!restoredRef.current || !site) return
    try {
      const map = loadDraftsMap()
      map[site] = {
        reportId: reportIdRef.current,
        obs: obs.map(({ _timer, ...rest }) => rest),
        trCounts, mvrCounts, trDbId, mvrDbId,
      }
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(map))
      localStorage.setItem(LAST_SITE_KEY, site)
    } catch {}
  }, [obs, site, trCounts, mvrCounts, trDbId, mvrDbId])

  useEffect(() => {
    if (!restoredRef.current) return
    try { localStorage.setItem(INSPECTOR_KEY, inspector) } catch {}
  }, [inspector])

  async function addWorksite() {
    const name = newSiteName.trim()
    if (!name) return
    const existing = worksites.find(w => w.name.toLowerCase() === name.toLowerCase())
    if (existing) { selectSite(existing.name); setAddingSite(false); setNewSiteName(''); return }
    const { data, error } = await sb.from('worksites').insert([{ name }]).select()
    if (!error && data?.[0]) {
      setWorksites(prev => [...prev, data[0]].sort((a, b) => a.name.localeCompare(b.name)))
      selectSite(data[0].name)
    } else {
      console.error('addWorksite failed:', error)
      showSync('⚠ Työmaan lisäys epäonnistui (tarkista yhteys)')
    }
    setAddingSite(false); setNewSiteName('')
  }

  useEffect(() => {
    const goOnline = () => { setIsOnline(true); showSync('🌐 Yhteys palautui, synkronoidaan...'); retrySync() }
    const goOffline = () => { setIsOnline(false); showSync('⚠ Ei verkkoyhteyttä') }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    const t = setInterval(() => { if (navigator.onLine) retrySync() }, 30000)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function retrySync() {
    obsRef.current.forEach(o => { if (!o.db_id) saveObs(o, metaRef.current.site, metaRef.current.inspector) })
    saveMeasurement('tr')
    saveMeasurement('mvr')
  }

  // --- Havainnot: Supabase-synkronointi (kuvat pysyvät vain paikallisesti / PDF:ssä) ---
  async function saveObs(o, currentSite, currentInspector) {
    const data = {
      havainto: o.havainto, yritys: o.yritys, sev: o.sev, note: o.note,
      site: currentSite, inspector: currentInspector,
      local_id: o.id, report_id: reportIdRef.current,
    }
    try {
      if (o.db_id) {
        const { error } = await sb.from('safety_observations').update(data).eq('id', o.db_id)
        if (error) throw error
        showSync('✓ Tallennettu')
        return o.db_id
      } else {
        const { data: res, error } = await sb.from('safety_observations')
          .insert([{ ...data, created_at: o.createdAt || new Date().toISOString() }]).select()
        if (error) throw error
        if (res?.[0]) {
          setObs(prev => prev.map(x => x.id === o.id ? { ...x, db_id: res[0].id } : x))
          showSync('✓ Tallennettu')
          return res[0].id
        }
      }
    } catch (e) {
      console.error('saveObs failed:', e)
      const looksLikeNetwork = !navigator.onLine || e?.message?.toLowerCase().includes('fetch')
      showSync(looksLikeNetwork ? '⚠ Ei yhteyttä — tallessa vain paikallisesti' : '⚠ Tallennusvirhe (katso konsoli)')
      return null
    }
    return null
  }

  function addObs() {
    const id = ++idCounter
    setObs(prev => [...prev, {
      id, havainto: '', yritys: '', sev: 'Huomio', note: '', photos: [],
      db_id: null, createdAt: new Date().toISOString(),
    }])
  }

  function updateObs(id, key, val) {
    setObs(prev => prev.map(o => {
      if (o.id !== id) return o
      const updated = { ...o, [key]: val }
      clearTimeout(updated._timer)
      updated._timer = setTimeout(() => {
        const latest = obsRef.current.find(x => x.id === id)
        if (latest) saveObs(latest, metaRef.current.site, metaRef.current.inspector)
      }, 1000)
      return updated
    }))
  }

  function removeObs(id) {
    if (!window.confirm('Poistetaanko tämä havainto?')) return
    setObs(prev => {
      const o = prev.find(x => x.id === id)
      if (o?.db_id) {
        sb.from('safety_observations').delete().eq('id', o.db_id).then(({ error }) => {
          if (error) console.log('Havainto poistui vain paikallisesti, pilvikopio jäi talteen.')
        })
      }
      return prev.filter(x => x.id !== id)
    })
  }

  async function addPhotos(id, files) {
    for (const file of Array.from(files)) {
      const src = await compressImage(file)
      if (!src) continue
      setObs(prev => prev.map(o => o.id !== id ? o : { ...o, photos: [...o.photos, { src }] }))
    }
  }
  function removePhoto(id, pi) {
    setObs(prev => prev.map(o => {
      if (o.id !== id) return o
      const photos = [...o.photos]; photos.splice(pi, 1)
      return { ...o, photos }
    }))
  }

  // --- TR/MVR-mittaus: laskurit + Supabase-synkronointi ---
  function bump(type, catKey, field, delta) {
    const setFn = type === 'tr' ? setTrCounts : setMvrCounts
    const timer = type === 'tr' ? trTimer : mvrTimer
    setFn(prev => {
      const cur = prev[catKey] || { oikein: 0, vaarin: 0 }
      const next = { ...cur, [field]: Math.max(0, cur[field] + delta) }
      return { ...prev, [catKey]: next }
    })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => saveMeasurement(type), 1000)
  }

  function resetMeasurement(type) {
    const label = type === 'tr' ? 'TR-mittauksen' : 'MVR-mittauksen'
    if (!window.confirm(`Nollataanko ${label} laskurit?`)) return
    if (type === 'tr') setTrCounts(emptyCounts(TR_CATEGORIES))
    else setMvrCounts(emptyCounts(MVR_CATEGORIES))
    setTimeout(() => saveMeasurement(type), 100)
  }

  async function saveMeasurement(type) {
    const categories = type === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES
    // Luetaan refistä (ei suoraan state-muuttujasta) — tätä kutsutaan sekä
    // debounce-timerista että online/interval-kuuntelijoista, joiden closuret
    // eivät muuten näkisi uusinta arvoa (ks. refien kommentti yllä).
    const counts = type === 'tr' ? trCountsRef.current : mvrCountsRef.current
    const dbId = type === 'tr' ? trDbIdRef.current : mvrDbIdRef.current
    const setDbId = type === 'tr' ? setTrDbId : setMvrDbId
    const { pct, total } = overallIndex(counts, categories)
    // Tyhjää mittausta ei kannata tallentaa UUTENA rivinä, mutta jos rivi on
    // jo olemassa pilvessä (dbId) ja mittaus nollataan, päivitys pitää silti
    // tehdä — muuten pilvikopio jäisi virheellisesti vanhoihin lukemiin.
    if (!total && !dbId) return
    const data = {
      type, site: metaRef.current.site, inspector: metaRef.current.inspector,
      counts, index_pct: pct, report_id: reportIdRef.current,
    }
    try {
      if (dbId) {
        const { error } = await sb.from('safety_measurements').update(data).eq('id', dbId)
        if (error) throw error
        showSync('✓ Tallennettu')
      } else {
        const { data: res, error } = await sb.from('safety_measurements')
          .insert([{ ...data, created_at: new Date().toISOString() }]).select()
        if (error) throw error
        if (res?.[0]) { setDbId(res[0].id); showSync('✓ Tallennettu') }
      }
    } catch (e) {
      console.error('saveMeasurement failed:', e)
      const looksLikeNetwork = !navigator.onLine || e?.message?.toLowerCase().includes('fetch')
      showSync(looksLikeNetwork ? '⚠ Ei yhteyttä — tallessa vain paikallisesti' : '⚠ Tallennusvirhe (katso konsoli)')
    }
  }

  function newReport() {
    const hasContent = obs.length > 0 || overallIndex(trCounts, TR_CATEGORIES).total > 0 || overallIndex(mvrCounts, MVR_CATEGORIES).total > 0
    if (hasContent && !window.confirm(`Aloitetaanko uusi raportti työmaalle "${site}"? Nykyinen sisältö poistetaan tältä laitteelta (jo pilveen tallentunut säilyy Supabasessa ennallaan).`)) return
    setObs([]); setTrCounts(emptyCounts(TR_CATEGORIES)); setMvrCounts(emptyCounts(MVR_CATEGORIES))
    setTrDbId(null); setMvrDbId(null)
    reportIdRef.current = uuid()
    // Tallennus-effect kirjoittaa tyhjän tilan tämän työmaan kohtaan
    // kartassa automaattisesti heti kun obs/trCounts/mvrCounts päivittyvät.
  }

  // --- PDF-vienti ---
  async function exportPDF() {
    if (!site) { alert('Valitse ensin työmaa yläreunasta.'); return }
    const trTotal = overallIndex(trCounts, TR_CATEGORIES).total
    const mvrTotal = overallIndex(mvrCounts, MVR_CATEGORIES).total
    if (obs.length === 0 && !trTotal && !mvrTotal) {
      alert('Ei sisältöä — lisää vähintään yksi havainto tai tee TR-/MVR-mittaus ennen PDF:n luontia.')
      return
    }
    const { blob, filename } = await buildReportPDF({ site, inspector, trCounts, mvrCounts, obs })
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

  const sevColor = { Kriittinen: '#d63030', Huomio: '#d07800', Info: '#1a8a50' }
  const sevBg = { Kriittinen: 'rgba(214,48,48,0.1)', Huomio: 'rgba(245,168,0,0.12)', Info: 'rgba(26,138,80,0.1)' }

  const trResult = overallIndex(trCounts, TR_CATEGORIES)
  const mvrResult = overallIndex(mvrCounts, MVR_CATEGORIES)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 480, margin: '0 auto' }}>
      {/* Topbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 10px', background: '#17275c', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/korpnex-icon.png" alt="Korpnex" style={{ width: 32, height: 32, borderRadius: 8, objectFit: 'cover', display: 'block' }} />
          <span style={{ fontSize: 17, fontWeight: 800, color: 'white', letterSpacing: 0.5 }}>KORPNEX</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontWeight: 500, marginLeft: 2 }}>· Työturvallisuus</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isOnline && (
            <span style={{ fontSize: 11, color: '#17275c', fontWeight: 700, background: '#c7cbd6', padding: '3px 8px', borderRadius: 20 }}>⚠ Offline</span>
          )}
          {syncMsg && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>{syncMsg}</span>}
        </div>
      </div>

      {/* Meta */}
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', borderBottom: '1px solid #d3d6e0' }}>
        <div>
          <div style={labelStyle}>Työmaa</div>
          {!addingSite ? (
            <select
              style={selectStyle}
              value={site}
              onChange={e => e.target.value === '__new__' ? (setAddingSite(true), setNewSiteName('')) : selectSite(e.target.value)}
            >
              <option value="" disabled>Valitse työmaa…</option>
              {worksites.map(w => <option key={w.id} value={w.name}>{w.name}</option>)}
              <option value="__new__">＋ Lisää uusi työmaa…</option>
            </select>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <input autoFocus style={{ ...inputStyle, flex: 1 }} placeholder="Uuden työmaan nimi"
                value={newSiteName} onChange={e => setNewSiteName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addWorksite()} />
              <button onClick={addWorksite} style={{ padding: '0 14px', background: '#17275c', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 700, fontSize: 13 }}>Lisää</button>
              <button onClick={() => setAddingSite(false)} style={{ padding: '0 12px', background: '#eef0f5', border: '1px solid #d3d6e0', borderRadius: 8, color: '#6a7086', fontSize: 15 }}>✕</button>
            </div>
          )}
        </div>
        <input style={inputStyle} placeholder="Tarkastaja" value={inspector} onChange={e => setInspector(e.target.value)} />
        {site && (
          <button onClick={newReport} style={{ alignSelf: 'flex-end', background: 'none', border: 'none', fontSize: 11, color: '#6a7086', padding: '2px 0' }}>
            🔄 Uusi raportti tälle työmaalle
          </button>
        )}
      </div>

      {!site ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, background: '#eef0f5' }}>
          <p style={{ fontSize: 14, color: '#6a7086', textAlign: 'center', lineHeight: 1.6 }}>
            📍 Valitse tai lisää työmaa yläreunasta<br />aloittaaksesi tarkastuksen.
          </p>
        </div>
      ) : (
      <>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, padding: '10px 16px 0', background: '#fff' }}>
        {[
          ['havainnot', `Havainnot${obs.length ? ` (${obs.length})` : ''}`],
          ['tr', `TR-mittaus${trResult.total ? ` (${trResult.pct}%)` : ''}`],
          ['mvr', `MVR-mittaus${mvrResult.total ? ` (${mvrResult.pct}%)` : ''}`],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            flex: 1, padding: '10px 4px', borderRadius: '10px 10px 0 0', fontSize: 12, fontWeight: 700,
            border: 'none', borderBottom: tab === key ? '3px solid #223a8c' : '3px solid transparent',
            background: tab === key ? '#eef0f5' : '#fff', color: tab === key ? '#17275c' : '#6a7086',
          }}>{label}</button>
        ))}
      </div>

      {/* Scroll area */}
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 90, background: '#eef0f5' }}>

        {tab === 'havainnot' && (
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {obs.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 24px', color: '#6a7086' }}>
                <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.3 }}>📋</div>
                <p style={{ fontSize: 14, lineHeight: 1.6 }}>Ei havaintoja.<br />Paina + lisätäksesi ensimmäisen.</p>
              </div>
            )}
            {obs.map((o, idx) => (
              <div key={o.id} style={{ background: '#fff', border: '1px solid #d3d6e0', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: '#eef0f5', borderBottom: '1px solid #d3d6e0' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#6a7086', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    Havainto {idx + 1}
                    {!o.db_id && <span title="Ei vielä synkronoitu pilveen — tallessa paikallisesti" style={{ marginLeft: 6, color: '#d07800' }}>●</span>}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span>
                    <button onClick={() => removeObs(o.id)} style={{ background: 'none', border: 'none', color: '#6a7086', fontSize: 18 }}>🗑</button>
                  </div>
                </div>
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <div style={labelStyle}>Havainto</div>
                    <input style={inputStyle} placeholder="esim. Suojalasit puuttuvat" value={o.havainto} onChange={e => updateObs(o.id, 'havainto', e.target.value)} />
                  </div>
                  <div>
                    <div style={labelStyle}>Yritys</div>
                    <input style={inputStyle} placeholder="Mikä yritys / aliurakoitsija" value={o.yritys} onChange={e => updateObs(o.id, 'yritys', e.target.value)} />
                  </div>
                  <div>
                    <div style={labelStyle}>Vakavuus</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {SEV_LABELS.map(s => (
                        <button key={s} onClick={() => updateObs(o.id, 'sev', s)} style={{
                          flex: 1, padding: '8px 4px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                          border: `1px solid ${o.sev === s ? sevColor[s] : '#d3d6e0'}`,
                          background: o.sev === s ? sevBg[s] : '#eef0f5',
                          color: o.sev === s ? sevColor[s] : '#6a7086',
                        }}>{s}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={labelStyle}>Lisätieto</div>
                    <textarea style={{ ...selectStyle, resize: 'none', minHeight: 56, lineHeight: 1.5 }}
                      placeholder="Tarkempi kuvaus / lisätieto..." value={o.note} onChange={e => updateObs(o.id, 'note', e.target.value)} />
                  </div>
                  <div>
                    <div style={labelStyle}>Kuvat</div>
                    <div style={{ border: '1px dashed #b3b8c8', borderRadius: 8, overflow: 'hidden' }}>
                      {o.photos.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8 }}>
                          {o.photos.map((p, pi) => (
                            <div key={pi} style={{ position: 'relative', width: 76, height: 76, borderRadius: 8, overflow: 'hidden' }}>
                              <img src={p.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
                              <button onClick={() => removePhoto(o.id, pi)} style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%', width: 20, height: 20, color: '#fff', fontSize: 13 }}>×</button>
                            </div>
                          ))}
                        </div>
                      )}
                      <label>
                        <button onClick={e => e.currentTarget.parentElement.querySelector('input').click()} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 11, color: '#6a7086', fontSize: 13, background: 'none', border: 'none', width: '100%' }}>
                          📷 Ota kuva / valitse galleriasta
                        </button>
                        <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => addPhotos(o.id, e.target.files)} />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <button onClick={addObs} style={{ width: '100%', padding: 13, border: '1.5px dashed #b3b8c8', borderRadius: 12, background: 'none', color: '#6a7086', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              ＋ Lisää havainto
            </button>
          </div>
        )}

        {(tab === 'tr' || tab === 'mvr') && (
          <MeasurementTab
            type={tab}
            categories={tab === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES}
            counts={tab === 'tr' ? trCounts : mvrCounts}
            legalNote={tab === 'tr' ? TR_LEGAL_NOTE : MVR_LEGAL_NOTE}
            onBump={bump}
            onReset={resetMeasurement}
          />
        )}
      </div>

      {/* Bottom bar */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 480, margin: '0 auto', background: '#f4f5f8', borderTop: '1px solid #d3d6e0', zIndex: 20 }}>
        <div style={{ padding: '10px 16px env(safe-area-inset-bottom, 14px)', display: 'flex', gap: 10 }}>
          <button onClick={exportPDF} style={{ flex: 1, padding: 13, background: '#17275c', border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            📄 Vie PDF-raportti
          </button>
        </div>
      </div>

      {/* PDF overlay */}
      {pdfMode && (
        <div style={{ position: 'fixed', inset: 0, background: '#f4f5f8', zIndex: 100, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 12px', background: '#17275c' }}>
            <button onClick={() => setPdfMode(false)} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: '50%', fontSize: 18 }}>✕</button>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>PDF valmis</span>
            <button onClick={sharePDF} style={{ background: '#c7cbd6', border: 'none', color: '#17275c', fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8 }}>
              {shareSupported ? '⬆ Jaa' : '⬇ Lataa PDF'}
            </button>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32 }}>
            <div style={{ fontSize: 64 }}>{pdfDownloaded ? '✅' : '📄'}</div>
            {shareSupported ? (
              <p style={{ fontSize: 14, color: '#6a7086', textAlign: 'center', lineHeight: 1.6 }}>
                Paina <strong style={{ color: '#14183a' }}>Jaa ⬆</strong> avataksesi jakovalikon.
              </p>
            ) : pdfDownloaded ? (
              <p style={{ fontSize: 14, color: '#1a8a50', textAlign: 'center', lineHeight: 1.6, fontWeight: 600 }}>
                PDF ladattu koneen Lataukset-kansioon.<br />
                <span style={{ color: '#6a7086', fontWeight: 400 }}>({pdfName})</span>
              </p>
            ) : (
              <p style={{ fontSize: 14, color: '#6a7086', textAlign: 'center', lineHeight: 1.6 }}>
                Paina <strong style={{ color: '#14183a' }}>Lataa PDF</strong> tallentaaksesi tiedoston koneelle.
              </p>
            )}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  )
}

// Yhden TR- tai MVR-mittauksen näkymä: jokaiselle havaintoluokalle kaksi
// isoa "tukkimiehen kirjanpito" -tyylistä laskuripainiketta (Oikein/Väärin),
// ja ylhäällä koko mittauksen kokonaisindeksi joka päivittyy heti.
function MeasurementTab({ type, categories, counts, legalNote, onBump, onReset }) {
  const { oikein, vaarin, total, pct } = overallIndex(counts, categories)
  const color = indexColor(pct)
  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ background: '#fff', border: '1px solid #d3d6e0', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6a7086', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {type === 'tr' ? 'TR-indeksi' : 'MVR-indeksi'}
          </div>
          <div style={{ fontSize: 12, color: '#6a7086', marginTop: 2 }}>
            {total ? `${oikein} oikein, ${vaarin} väärin (${total} havaintoa)` : 'Ei vielä havaintoja'}
          </div>
        </div>
        <div style={{ fontSize: 30, fontWeight: 800, color }}>{pct == null ? '–' : `${pct}%`}</div>
      </div>

      {categories.map(c => {
        const cnt = counts[c.key] || { oikein: 0, vaarin: 0 }
        const cpct = categoryPct(cnt)
        return (
          <div key={c.key} style={{ background: '#fff', border: '1px solid #d3d6e0', borderRadius: 12, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#14183a' }}>{c.label}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: indexColor(cpct) }}>{cpct == null ? '–' : `${cpct}%`}</div>
            </div>
            <div style={{ fontSize: 11.5, color: '#6a7086', marginBottom: 10, lineHeight: 1.4 }}>{c.desc}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => onBump(type, c.key, 'oikein', 1)} style={{ flex: 1, padding: '10px 4px', borderRadius: 8, border: '1px solid #1a8a50', background: 'rgba(26,138,80,0.1)', color: '#1a8a50', fontWeight: 700, fontSize: 13 }}>
                ✓ Oikein ({cnt.oikein})
              </button>
              <button onClick={() => onBump(type, c.key, 'vaarin', 1)} style={{ flex: 1, padding: '10px 4px', borderRadius: 8, border: '1px solid #d63030', background: 'rgba(214,48,48,0.1)', color: '#d63030', fontWeight: 700, fontSize: 13 }}>
                ✗ Väärin ({cnt.vaarin})
              </button>
              {(cnt.oikein > 0 || cnt.vaarin > 0) && (
                <button onClick={() => {
                  if (cnt.vaarin > 0) onBump(type, c.key, 'vaarin', -1)
                  else if (cnt.oikein > 0) onBump(type, c.key, 'oikein', -1)
                }} title="Kumoa viimeisin" style={{ padding: '10px 10px', borderRadius: 8, border: '1px solid #d3d6e0', background: '#eef0f5', color: '#6a7086', fontSize: 13 }}>
                  ↺
                </button>
              )}
            </div>
          </div>
        )
      })}

      <button onClick={() => onReset(type)} style={{ alignSelf: 'flex-end', background: 'none', border: 'none', fontSize: 11, color: '#6a7086', padding: '4px 0' }}>
        🗑 Nollaa mittaus
      </button>

      <div style={{ fontSize: 11, color: '#9aa2c0', lineHeight: 1.5, padding: '4px 2px 16px' }}>{legalNote}</div>
    </div>
  )
}

const inputStyle = {
  background: '#fff', border: '1px solid #d3d6e0', borderRadius: 8,
  color: '#14183a', fontSize: 14, padding: '9px 12px', width: '100%', outline: 'none',
}
const selectStyle = {
  background: '#fff', border: '1px solid #d3d6e0', borderRadius: 8,
  color: '#14183a', fontSize: 14, padding: '9px 12px', width: '100%', outline: 'none',
  WebkitAppearance: 'none', appearance: 'none',
}
const labelStyle = {
  fontSize: 11, fontWeight: 700, color: '#6a7086',
  letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 5,
}
