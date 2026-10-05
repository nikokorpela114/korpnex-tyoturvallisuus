import React, { useState, useEffect, useRef } from 'react'
import { sb } from './supabaseClient.js'
import {
  TR_CATEGORIES, MVR_CATEGORIES, TR_LEGAL_NOTE, MVR_LEGAL_NOTE,
  emptyCounts, categoryPct, overallIndex, indexColor, SEV_LABELS, OBS_CATEGORIES, compressImage, buildReportPDF,
  addNote, updateNote, removeNote,
} from './shared.js'
import FollowUp, { useFollowUp } from './FollowUp.jsx'
import { uploadPhoto } from './photos.js'
import { putPhoto, getPhoto, delPhoto } from './photoStore.js'

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

// Kenttäsovellus — vain konsultille (ks. main.jsx). Asiakkaat ohjataan
// aina Valvomoon/asiakasportaaliin.
export default function App({ profile, logout }) {
  const [tab, setTab] = useState('havainnot') // 'havainnot' | 'seuranta' | 'tr' | 'mvr'
  const [menuOpen, setMenuOpen] = useState(false)
  const [site, setSite] = useState('')
  const [inspector, setInspector] = useState('')
  const [worksites, setWorksites] = useState([])
  const [subcontractors, setSubcontractors] = useState([])
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
  // Mitkä havaintojen Yritys-kentät ovat "kirjoita itse" -tilassa (ohittaa
  // valintalistan). Vain näyttötila, ei tallenneta.
  const [obsYritysCustom, setObsYritysCustom] = useState({})

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
  const worksitesRef = useRef([])
  const subsRef = useRef([])
  const addingSubRef = useRef(new Set())
  const savingRef = useRef(new Set())   // havainnot joiden tallennus on kesken
  const resaveRef = useRef(new Set())   // ja jotka pitää tallentaa uudelleen sen jälkeen
  const trCountsRef = useRef(trCounts)
  const mvrCountsRef = useRef(mvrCounts)
  const trDbIdRef = useRef(trDbId)
  const mvrDbIdRef = useRef(mvrDbId)
  useEffect(() => { obsRef.current = obs }, [obs])
  useEffect(() => { worksitesRef.current = worksites }, [worksites])
  useEffect(() => { subsRef.current = subcontractors }, [subcontractors])
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

  // Aiempien kierrosten avoimet/kuitatut havainnot (Seuranta-välilehti)
  const followUp = useFollowUp(site, reportIdRef.current)

  // Työmaan aliurakoitsijat (hallitaan Valvomosta) — käytetään Yritys- ja
  // Vastuuhenkilö-kenttien valintalistana, ettei niitä tarvitse kirjoittaa
  // uudelleen joka kerta.
  useEffect(() => {
    if (!site) { setSubcontractors([]); return }
    sb.from('subcontractors').select('*').eq('site', site).eq('archived', false).order('name')
      .then(({ data, error }) => { if (!error) setSubcontractors(data || []) })
  }, [site])

  // Luonnoksessa kuvista on vain tunniste — itse kuva haetaan laitteen
  // IndexedDB:stä (ks. photoStore.js).
  async function hydratePhotos(list) {
    for (const o of list) {
      for (const p of (o.photos || [])) {
        if (!p.id || p.src) continue
        const src = await getPhoto(p.id)
        if (src) setObs(prev => prev.map(x => x.id !== o.id ? x : { ...x, photos: x.photos.map(q => q.id === p.id ? { ...q, src } : q) }))
      }
    }
  }

  function applyDraft(siteName, d) {
    setSite(siteName)
    reportIdRef.current = d?.reportId || uuid()
    const restoredObs = d?.obs?.length ? d.obs : []
    setObs(restoredObs)
    hydratePhotos(restoredObs)
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
      else if (profile?.name) setInspector(profile.name)
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
        obs: obs.map(({ _timer, ...rest }) => ({
          ...rest,
          photos: (rest.photos || []).map(p => p.id ? { id: p.id, path: p.path } : p),
        })),
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
    obsRef.current.forEach(o => {
      if (!o.db_id || (o.photos || []).some(p => !p.path)) saveObs(o, metaRef.current.site, metaRef.current.inspector)
    })
    saveMeasurement('tr')
    saveMeasurement('mvr')
  }

  // --- Havainnot: Supabase-synkronointi ---
  // Kuvat ladataan Storageen (tt-photos/<työmaa-id>/...) ennen rivin
  // tallennusta, jotta asiakas näkee ne portaalissa. Offline-tilassa kuvat
  // odottavat laitteella ja ladataan seuraavalla synkronointikerralla.
  async function saveObs(o, currentSite, currentInspector) {
    if (savingRef.current.has(o.id)) { resaveRef.current.add(o.id); return null }
    savingRef.current.add(o.id)
    try {
      const ws = worksitesRef.current.find(w => w.name === currentSite)
      let photos = o.photos || []
      if (ws && photos.some(p => !p.path && p.src)) {
        const uploaded = []
        for (const p of photos) {
          if (p.path || !p.src) { uploaded.push(p); continue }
          const path = await uploadPhoto(ws.id, p.src)
          uploaded.push({ ...p, path })
        }
        photos = uploaded
        const bySrc = new Map(photos.map(p => [p.src, p.path]))
        setObs(prev => prev.map(x => x.id === o.id
          ? { ...x, photos: x.photos.map(p => p.path ? p : { ...p, path: bySrc.get(p.src) || undefined }) } : x))
      }
      // Urakoitsijan nimi aina samassa muodossa (tilastot), uusi nimi
      // lisätään automaattisesti työmaan aliurakoitsijalistalle.
      const yritys = canonicalYritys(o.yritys)
      const data = {
        havainto: o.havainto, yritys, sev: o.sev, note: o.note, luokka: o.luokka || null,
        due_date: o.due_date || null,
        photos: photos.filter(p => p.path).map(p => ({ path: p.path })),
        site: currentSite, inspector: currentInspector,
        local_id: o.id, report_id: reportIdRef.current,
      }
      if (o.db_id) {
        const { error } = await sb.from('safety_observations').update(data).eq('id', o.db_id)
        if (error) throw error
        showSync('✓ Tallennettu')
        return o.db_id
      }
      const { data: res, error } = await sb.from('safety_observations')
        .insert([{ ...data, created_at: o.createdAt || new Date().toISOString() }]).select()
      if (error) throw error
      if (res?.[0]) {
        setObs(prev => prev.map(x => x.id === o.id ? { ...x, db_id: res[0].id } : x))
        obsRef.current = obsRef.current.map(x => x.id === o.id ? { ...x, db_id: res[0].id } : x)
        showSync('✓ Tallennettu')
        return res[0].id
      }
    } catch (e) {
      console.error('saveObs failed:', e)
      const looksLikeNetwork = !navigator.onLine || e?.message?.toLowerCase().includes('fetch')
      showSync(looksLikeNetwork ? '⚠ Ei yhteyttä — tallessa vain paikallisesti' : '⚠ Tallennusvirhe (katso konsoli)')
      return null
    } finally {
      savingRef.current.delete(o.id)
      if (resaveRef.current.has(o.id)) {
        resaveRef.current.delete(o.id)
        setTimeout(() => {
          const latest = obsRef.current.find(x => x.id === o.id)
          if (latest) saveObs(latest, metaRef.current.site, metaRef.current.inspector)
        }, 50)
      }
    }
    return null
  }

  function canonicalYritys(raw) {
    const name = (raw || '').trim().replace(/\s+/g, ' ')
    if (!name) return ''
    const hit = subsRef.current.find(x => x.name.trim().toLowerCase() === name.toLowerCase())
    return hit ? hit.name : name
  }

  // Käsin kirjoitettu uusi urakoitsija lisätään työmaan listalle, kun kenttä
  // jätetään (ei jokaisesta näppäilystä — muuten listalle tulisi "Tel", "Teli"...).
  function ensureSubcontractor(raw) {
    const name = (raw || '').trim().replace(/\s+/g, ' ')
    const siteName = metaRef.current.site
    if (name.length < 2 || !siteName) return
    const key = name.toLowerCase()
    if (subsRef.current.some(x => x.name.trim().toLowerCase() === key) || addingSubRef.current.has(key)) return
    addingSubRef.current.add(key)
    sb.from('subcontractors').insert([{ site: siteName, name }]).select().then(({ data, error }) => {
      if (!error && data?.[0]) setSubcontractors(prev => [...prev, data[0]].sort((a, b) => a.name.localeCompare(b.name)))
      else addingSubRef.current.delete(key)
    })
  }

  function scheduleSave(id) {
    setObs(prev => prev.map(o => {
      if (o.id !== id) return o
      clearTimeout(o._timer)
      return { ...o, _timer: setTimeout(() => {
        const latest = obsRef.current.find(x => x.id === id)
        if (latest) saveObs(latest, metaRef.current.site, metaRef.current.inspector)
      }, 800) }
    }))
  }

  function addObs() {
    const id = ++idCounter
    setObs(prev => [...prev, {
      id, havainto: '', yritys: '', sev: 'Huomio', luokka: '', note: '', due_date: '', photos: [],
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
      const src = await compressImage(file, 1280, 0.72)
      if (!src) continue
      const pid = uuid()
      await putPhoto(pid, src)
      setObs(prev => prev.map(o => o.id !== id ? o : { ...o, photos: [...o.photos, { id: pid, src }] }))
    }
    scheduleSave(id)
  }
  function removePhoto(id, pi) {
    setObs(prev => prev.map(o => {
      if (o.id !== id) return o
      const photos = [...o.photos]
      const [gone] = photos.splice(pi, 1)
      if (gone?.id) delPhoto(gone.id)
      return { ...o, photos }
    }))
    scheduleSave(id)
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

  // Puutteiden (huomautus/vastuuhenkilö/korjattu) hallinta yhdelle
  // kategorialle kerrallaan. Sama debounced-tallennus kuin bump():ssa —
  // kirjoittaminen ei laukaise verkkopyyntöä joka näppäimestä.
  function noteAction(type, action, ...args) {
    const setFn = type === 'tr' ? setTrCounts : setMvrCounts
    const timer = type === 'tr' ? trTimer : mvrTimer
    setFn(prev => action(prev, ...args))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => saveMeasurement(type), 800)
  }
  const handleAddNote = (type, catKey) => noteAction(type, addNote, catKey)
  const handleUpdateNote = (type, catKey, id, patch) => noteAction(type, (c) => updateNote(c, catKey, id, patch))
  const handleRemoveNote = (type, catKey, id) => noteAction(type, (c) => removeNote(c, catKey, id))

  // Mittauksen puute → havainnoksi, jolloin se kulkee samaa reittiä kuin muut
  // havainnot: asiakas näkee ja voi kuitata sen, ja se näkyy urakoitsijatilastoissa.
  const NOTE_LUOKKA = {
    tyoskentely: 'Suojaimet ja työtavat', telineet: 'Telineet ja tikkaat', koneet: 'Koneet ja laitteet',
    putoamissuojaus: 'Putoamissuojaus', sahko: 'Sähkö ja valaistus', jarjestys: 'Järjestys ja kulkutiet', poly: 'Pöly ja kemikaalit',
    tyoskentely_koneet: 'Suojaimet ja työtavat', kalusto: 'Koneet ja laitteet', suojaukset: 'Putoamissuojaus',
    kulkuvaylat: 'Järjestys ja kulkutiet', jarjestys_varastointi: 'Järjestys ja kulkutiet',
  }
  function noteToObservation(type, catKey, n) {
    if (!(n.desc || '').trim()) return
    const o = {
      id: ++idCounter, havainto: n.desc.trim(), yritys: canonicalYritys(n.vastuuhenkilo), sev: 'Huomio',
      luokka: NOTE_LUOKKA[catKey] || '', note: `${type === 'tr' ? 'TR' : 'MVR'}-mittauksen puute`, due_date: '', photos: [],
      db_id: null, createdAt: new Date().toISOString(),
    }
    setObs(prev => [...prev, o])
    obsRef.current = [...obsRef.current, o]
    handleRemoveNote(type, catKey, n.id)
    setTab('havainnot')
    setTimeout(() => saveObs(o, metaRef.current.site, metaRef.current.inspector), 50)
    showSync('➜ Siirretty havainnoksi — lisää halutessasi kuva')
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

  // Hakee edellisen mittauksen (tr tai mvr) samalta työmaalta ja poimii
  // sieltä puutteet, joita EI ole vielä merkitty korjatuiksi. Nämä siirtyvät
  // automaattisesti uuden kierroksen pohjaksi (merkittynä carried:true),
  // jotta mikään avoin puute ei pääse unohtumaan viikkojen välissä.
  async function fetchOpenNotesFromPrevious(type, siteName) {
    const categories = type === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES
    const base = emptyCounts(categories)
    if (!siteName) return base
    try {
      const { data, error } = await sb.from('safety_measurements')
        .select('counts, created_at')
        .eq('site', siteName).eq('type', type)
        .order('created_at', { ascending: false })
        .limit(1)
      if (error || !data?.[0]) return base
      const prevCounts = data[0].counts || {}
      categories.forEach(c => {
        const prevNotes = (prevCounts[c.key]?.notes || []).filter(n => !n.korjattu && (n.desc || '').trim())
        base[c.key] = { ...base[c.key], notes: prevNotes.map(n => ({ ...n, carried: true })) }
      })
      return base
    } catch {
      return base
    }
  }

  async function newReport() {
    const hasContent = obs.length > 0 || overallIndex(trCounts, TR_CATEGORIES).total > 0 || overallIndex(mvrCounts, MVR_CATEGORIES).total > 0
    const unsent = obs.filter(o => !o.db_id || (o.photos || []).some(p => !p.path)).length
    if (unsent && !window.confirm(`⚠ ${unsent} havaintoa tai kuvaa ei ole vielä lähetetty pilveen (ei verkkoyhteyttä?). Jos aloitat uuden raportin nyt, ne katoavat.\n\nAloitetaanko silti?`)) return
    if (!unsent && hasContent && !window.confirm(`Aloitetaanko uusi raportti työmaalle "${site}"? Luonnos tyhjennetään tältä laitteelta — kaikki on jo tallessa pilvessä ja näkyy Seuranta-välilehdellä.`)) return
    obs.forEach(o => (o.photos || []).forEach(p => { if (p.id) delPhoto(p.id) }))
    const currentSite = site
    setObs([])
    setTrDbId(null); setMvrDbId(null)
    reportIdRef.current = uuid()
    // Tuodaan edellisen kierroksen avoimet puutteet pohjaksi — laskurit
    // (oikein/väärin) alkavat silti aina nollasta, koska kyseessä on uusi
    // fyysinen tarkastuskierros.
    const [trBase, mvrBase] = await Promise.all([
      fetchOpenNotesFromPrevious('tr', currentSite),
      fetchOpenNotesFromPrevious('mvr', currentSite),
    ])
    setTrCounts(trBase)
    setMvrCounts(mvrBase)
    followUp.reload()
    // Tallennus-effect kirjoittaa uuden tilan tämän työmaan kohtaan
    // kartassa automaattisesti heti kun obs/trCounts/mvrCounts päivittyvät.
  }

  // --- Tarkastus valmis → sähköposti asiakkaan käyttäjille ---
  const [sending, setSending] = useState(false)
  const [reportSent, setReportSent] = useState(false)
  useEffect(() => { setReportSent(false) }, [site])
  async function sendToClient() {
    if (!site) return
    const trTotal = overallIndex(trCounts, TR_CATEGORIES).total
    const mvrTotal = overallIndex(mvrCounts, MVR_CATEGORIES).total
    if (!obs.length && !trTotal && !mvrTotal) { alert('Kierroksella ei ole vielä havaintoja tai mittauksia.'); return }
    if (!navigator.onLine) { alert('Ei verkkoyhteyttä — lähetä kun yhteys palaa.'); return }
    retrySync()
    const unsent = obs.filter(o => !o.db_id || (o.photos || []).some(p => !p.path)).length
    if (unsent) { alert(`${unsent} havaintoa tai kuvaa on vielä lähettämättä pilveen. Odota hetki (oranssit pallot katoavat) ja yritä uudelleen.`); return }
    if (!window.confirm(`Lähetetäänkö asiakkaalle ilmoitus tästä tarkastuksesta?\n\n${site}: ${obs.length} havaintoa${trTotal ? `, TR ${overallIndex(trCounts, TR_CATEGORIES).pct} %` : ''}${mvrTotal ? `, MVR ${overallIndex(mvrCounts, MVR_CATEGORIES).pct} %` : ''}`)) return
    setSending(true)
    await new Promise(r => setTimeout(r, 1200)) // mittausten viimeinen tallennus ehtii perille
    const { data, error } = await sb.functions.invoke('tt-admin', { body: { action: 'notify_report', site, report_id: reportIdRef.current } })
    setSending(false)
    let msg = data?.error
    if (error) { try { msg = (await error.context?.json?.())?.error || error.message } catch { msg = error.message } }
    if (msg) { alert('Lähetys ei onnistunut: ' + msg); return }
    setReportSent(true)
    showSync(`✓ Ilmoitus lähetetty ${data?.sent || 0} käyttäjälle`)
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

  const sevColor = { Kriittinen: '#dc2626', Huomio: '#d97706', Info: '#059669' }
  const sevBg = { Kriittinen: 'rgba(220,38,38,0.1)', Huomio: 'rgba(245,168,0,0.12)', Info: 'rgba(5,150,105,0.1)' }

  const trResult = overallIndex(trCounts, TR_CATEGORIES)
  const mvrResult = overallIndex(mvrCounts, MVR_CATEGORIES)
  const currentWs = worksites.find(w => w.name === site)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 480, margin: '0 auto' }}>
      {/* Topbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 10px', background: '#0a1428', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/korpnex-icon.png" alt="Korpnex" style={{ width: 32, height: 32, borderRadius: 10, objectFit: 'cover', display: 'block' }} />
          <span style={{ fontFamily: 'Jakarta, Inter, sans-serif', fontSize: 16, fontWeight: 800, color: 'white', letterSpacing: 3 }}>KORPNEX</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontWeight: 500, marginLeft: 2 }}>· Työturvallisuus</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isOnline && (
            <span style={{ fontSize: 11, color: '#0a1428', fontWeight: 700, background: '#c7cbd6', padding: '3px 8px', borderRadius: 20 }}>⚠ Offline</span>
          )}
          {syncMsg && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>{syncMsg}</span>}
          <button onClick={() => setMenuOpen(m => !m)} aria-label="Valikko" style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', width: 34, height: 34, borderRadius: 10, fontSize: 17 }}>☰</button>
        </div>
        {menuOpen && (
          <div style={{ position: 'absolute', right: 12, top: '100%', marginTop: 4, background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.15)', minWidth: 200, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', fontSize: 12, color: '#64748b', borderBottom: '1px solid #f1f4f9' }}>{profile?.email}</div>
            <a href="/?valvomo" style={menuItem}>🖥 Valvomo & asiakkaat</a>
            <button onClick={logout} style={{ ...menuItem, width: '100%', textAlign: 'left', background: 'none', border: 'none' }}>⎋ Kirjaudu ulos</button>
          </div>
        )}
      </div>

      {/* Meta */}
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', borderBottom: '1px solid #e3e8ef' }}>
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
              <button onClick={addWorksite} style={{ padding: '0 14px', background: '#0a1428', border: 'none', borderRadius: 10, color: '#fff', fontWeight: 700, fontSize: 13 }}>Lisää</button>
              <button onClick={() => setAddingSite(false)} style={{ padding: '0 12px', background: '#f1f4f9', border: '1px solid #e3e8ef', borderRadius: 10, color: '#64748b', fontSize: 15 }}>✕</button>
            </div>
          )}
        </div>
        <input style={inputStyle} placeholder="Tarkastaja" value={inspector} onChange={e => setInspector(e.target.value)} />
        {site && (
          <button onClick={newReport} style={{ alignSelf: 'flex-end', background: 'none', border: 'none', fontSize: 11, color: '#64748b', padding: '2px 0' }}>
            🔄 Uusi raportti tälle työmaalle
          </button>
        )}
      </div>

      {!site ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, background: '#f1f4f9' }}>
          <p style={{ fontSize: 14, color: '#64748b', textAlign: 'center', lineHeight: 1.6 }}>
            📍 Valitse tai lisää työmaa yläreunasta<br />aloittaaksesi tarkastuksen.
          </p>
        </div>
      ) : (
      <>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, padding: '10px 16px 0', background: '#fff' }}>
        {[
          ['havainnot', `Havainnot${obs.length ? ` (${obs.length})` : ''}`],
          ['seuranta', `Seuranta${followUp.list.length ? ` (${followUp.list.length})` : ''}`],
          ['tr', `TR${trResult.total ? ` ${trResult.pct}%` : ''}`],
          ['mvr', `MVR${mvrResult.total ? ` ${mvrResult.pct}%` : ''}`],
        ].map(([key, label]) => (
          <button key={key} onClick={() => { setTab(key); if (key === 'seuranta') followUp.reload() }} style={{
            flex: 1, padding: '10px 2px', borderRadius: '10px 10px 0 0', fontSize: 11.5, fontWeight: 700, position: 'relative',
            ...(key === 'seuranta' && followUp.list.some(o => o.status === 'kuitattu') ? { boxShadow: 'inset 0 3px 0 #f5a800' } : {}),
            border: 'none', borderBottom: tab === key ? '3px solid #0878E8' : '3px solid transparent',
            background: tab === key ? '#f1f4f9' : '#fff', color: tab === key ? '#0a1428' : '#64748b',
          }}>{label}</button>
        ))}
      </div>

      {/* Scroll area */}
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 90, background: '#f1f4f9' }}>

        {tab === 'havainnot' && (
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {obs.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 24px', color: '#64748b' }}>
                <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.3 }}>📋</div>
                <p style={{ fontSize: 14, lineHeight: 1.6 }}>Ei havaintoja.<br />Paina + lisätäksesi ensimmäisen.</p>
              </div>
            )}
            {obs.map((o, idx) => (
              <div key={o.id} style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 14, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: '#f1f4f9', borderBottom: '1px solid #e3e8ef' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    Havainto {idx + 1}
                    {!o.db_id && <span title="Ei vielä synkronoitu pilveen — tallessa paikallisesti" style={{ marginLeft: 6, color: '#d97706' }}>●</span>}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span>
                    <button onClick={() => removeObs(o.id)} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 18 }}>🗑</button>
                  </div>
                </div>
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <div style={labelStyle}>Havainto</div>
                    <input style={inputStyle} placeholder="esim. Suojalasit puuttuvat" value={o.havainto} onChange={e => updateObs(o.id, 'havainto', e.target.value)} />
                  </div>
                  <div>
                    <div style={labelStyle}>Yritys</div>
                    {(subcontractors.length === 0 || obsYritysCustom[o.id] || (o.yritys && !subcontractors.some(s => s.name === o.yritys))) ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input style={{ ...inputStyle, flex: 1 }} placeholder="Mikä yritys / aliurakoitsija" value={o.yritys} onChange={e => updateObs(o.id, 'yritys', e.target.value)} onBlur={e => ensureSubcontractor(e.target.value)} />
                        {subcontractors.length > 0 && (
                          <button onClick={() => { setObsYritysCustom(p => ({ ...p, [o.id]: false })); updateObs(o.id, 'yritys', '') }}
                            title="Takaisin listaan" style={{ padding: '0 12px', borderRadius: 10, border: '1px solid #e3e8ef', background: '#f1f4f9', color: '#64748b', fontSize: 12 }}>↩</button>
                        )}
                      </div>
                    ) : (
                      <select style={selectStyle} value={o.yritys}
                        onChange={e => {
                          const v = e.target.value
                          if (v === '__other__') { setObsYritysCustom(p => ({ ...p, [o.id]: true })); updateObs(o.id, 'yritys', '') }
                          else updateObs(o.id, 'yritys', v)
                        }}>
                        <option value="" disabled>Valitse…</option>
                        {subcontractors.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                        <option value="__other__">✎ Muu (kirjoita itse)</option>
                      </select>
                    )}
                  </div>
                  <div>
                    <div style={labelStyle}>Vakavuus</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {SEV_LABELS.map(s => (
                        <button key={s} onClick={() => updateObs(o.id, 'sev', s)} style={{
                          flex: 1, padding: '8px 4px', borderRadius: 10, fontSize: 12, fontWeight: 700,
                          border: `1px solid ${o.sev === s ? sevColor[s] : '#e3e8ef'}`,
                          background: o.sev === s ? sevBg[s] : '#f1f4f9',
                          color: o.sev === s ? sevColor[s] : '#64748b',
                        }}>{s}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={labelStyle}>Luokka</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {OBS_CATEGORIES.map(c => (
                        <button key={c} onClick={() => updateObs(o.id, 'luokka', o.luokka === c ? '' : c)} style={{
                          padding: '7px 11px', borderRadius: 20, fontSize: 12.5, fontWeight: 600,
                          border: `1px solid ${o.luokka === c ? '#0878E8' : '#e3e8ef'}`,
                          background: o.luokka === c ? '#eaf3fe' : '#fff',
                          color: o.luokka === c ? '#0a5bb5' : '#64748b',
                        }}>{c}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={labelStyle}>Korjattava viimeistään <span style={{ textTransform: 'none', fontWeight: 500 }}>(valinnainen)</span></div>
                    <input type="date" style={inputStyle} value={o.due_date || ''} onChange={e => updateObs(o.id, 'due_date', e.target.value)} />
                  </div>
                  <div>
                    <div style={labelStyle}>Lisätieto</div>
                    <textarea style={{ ...selectStyle, resize: 'none', minHeight: 56, lineHeight: 1.5 }}
                      placeholder="Tarkempi kuvaus / lisätieto..." value={o.note} onChange={e => updateObs(o.id, 'note', e.target.value)} />
                  </div>
                  <div>
                    <div style={labelStyle}>Kuvat</div>
                    <div style={{ border: '1px dashed #cbd3df', borderRadius: 10, overflow: 'hidden' }}>
                      {o.photos.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8 }}>
                          {o.photos.map((p, pi) => (
                            <div key={pi} style={{ position: 'relative', width: 76, height: 76, borderRadius: 10, overflow: 'hidden' }}>
                              <img src={p.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
                              {!p.path && <span title="Kuva odottaa lähetystä pilveen" style={{ position: 'absolute', left: 3, bottom: 3, width: 9, height: 9, borderRadius: '50%', background: '#d97706', border: '1.5px solid #fff' }} />}
                              <button onClick={() => removePhoto(o.id, pi)} style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%', width: 20, height: 20, color: '#fff', fontSize: 13 }}>×</button>
                            </div>
                          ))}
                        </div>
                      )}
                      <label>
                        <button onClick={e => e.currentTarget.parentElement.querySelector('input').click()} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 11, color: '#64748b', fontSize: 13, background: 'none', border: 'none', width: '100%' }}>
                          📷 Ota kuva / valitse galleriasta
                        </button>
                        <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => addPhotos(o.id, e.target.files)} />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <button onClick={addObs} style={{ width: '100%', padding: 13, border: '1.5px dashed #cbd3df', borderRadius: 14, background: 'none', color: '#64748b', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              ＋ Lisää havainto
            </button>
          </div>
        )}

        {tab === 'seuranta' && (
          <FollowUp {...followUp} worksiteId={currentWs?.id} inspectorName={inspector || profile?.name} isOnline={isOnline} />
        )}

        {(tab === 'tr' || tab === 'mvr') && (
          <MeasurementTab
            type={tab}
            categories={tab === 'tr' ? TR_CATEGORIES : MVR_CATEGORIES}
            counts={tab === 'tr' ? trCounts : mvrCounts}
            legalNote={tab === 'tr' ? TR_LEGAL_NOTE : MVR_LEGAL_NOTE}
            subcontractors={subcontractors}
            onBump={bump}
            onReset={resetMeasurement}
            onAddNote={handleAddNote}
            onUpdateNote={handleUpdateNote}
            onRemoveNote={handleRemoveNote}
            onToObservation={noteToObservation}
          />
        )}
      </div>

      {/* Bottom bar */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 480, margin: '0 auto', background: '#f4f6fa', borderTop: '1px solid #e3e8ef', zIndex: 20 }}>
        <div style={{ padding: '10px 16px env(safe-area-inset-bottom, 14px)', display: 'flex', gap: 10 }}>
          <button onClick={exportPDF} style={{ flex: '0 0 auto', padding: '13px 16px', background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, color: '#0a1428', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            📄 PDF
          </button>
          <button onClick={sendToClient} disabled={sending} style={{ flex: 1, padding: 13, background: reportSent ? '#059669' : '#0878E8', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: sending ? 0.7 : 1 }}>
            {sending ? 'Lähetetään…' : reportSent ? '✓ Lähetetty asiakkaalle' : '📨 Valmis – lähetä asiakkaalle'}
          </button>
        </div>
      </div>

      {/* PDF overlay */}
      {pdfMode && (
        <div style={{ position: 'fixed', inset: 0, background: '#f4f6fa', zIndex: 100, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 12px', background: '#0a1428' }}>
            <button onClick={() => setPdfMode(false)} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: '50%', fontSize: 18 }}>✕</button>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>PDF valmis</span>
            <button onClick={sharePDF} style={{ background: '#c7cbd6', border: 'none', color: '#0a1428', fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 10 }}>
              {shareSupported ? '⬆ Jaa' : '⬇ Lataa PDF'}
            </button>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32 }}>
            <div style={{ fontSize: 64 }}>{pdfDownloaded ? '✅' : '📄'}</div>
            {shareSupported ? (
              <p style={{ fontSize: 14, color: '#64748b', textAlign: 'center', lineHeight: 1.6 }}>
                Paina <strong style={{ color: '#0f172a' }}>Jaa ⬆</strong> avataksesi jakovalikon.
              </p>
            ) : pdfDownloaded ? (
              <p style={{ fontSize: 14, color: '#059669', textAlign: 'center', lineHeight: 1.6, fontWeight: 600 }}>
                PDF ladattu koneen Lataukset-kansioon.<br />
                <span style={{ color: '#64748b', fontWeight: 400 }}>({pdfName})</span>
              </p>
            ) : (
              <p style={{ fontSize: 14, color: '#64748b', textAlign: 'center', lineHeight: 1.6 }}>
                Paina <strong style={{ color: '#0f172a' }}>Lataa PDF</strong> tallentaaksesi tiedoston koneelle.
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
function MeasurementTab({ type, categories, counts, legalNote, subcontractors, onBump, onReset, onAddNote, onUpdateNote, onRemoveNote, onToObservation }) {
  const { oikein, vaarin, total, pct } = overallIndex(counts, categories)
  const color = indexColor(pct)
  // Mikä kategorian puutelista on auki — pelkkä näyttötila, ei tallenneta.
  const [openNotes, setOpenNotes] = useState({})
  const toggleNotes = key => setOpenNotes(prev => ({ ...prev, [key]: !prev[key] }))
  // Mitkä puutteiden Vastuuhenkilö-kentät ovat "kirjoita itse" -tilassa.
  const [customVastuu, setCustomVastuu] = useState({})

  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 14, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {type === 'tr' ? 'TR-indeksi' : 'MVR-indeksi'}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
            {total ? `${oikein} oikein, ${vaarin} väärin (${total} havaintoa)` : 'Ei vielä havaintoja'}
          </div>
        </div>
        <div style={{ fontSize: 30, fontWeight: 800, color }}>{pct == null ? '–' : `${pct}%`}</div>
      </div>

      {categories.some(c => (counts[c.key]?.notes || []).some(n => n.carried && !n.korjattu)) && (
        <div style={{ background: '#fff3cd', border: '1px solid #f0c36d', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: '#7a5b00', lineHeight: 1.5 }}>
          ⚠ Edelliseltä kierrokselta on avoimia puutteita tuotu tähän mittaukseen — tarkista kunkin kategorian Puutteet-listasta, onko ne korjattu.
        </div>
      )}

      {categories.map(c => {
        const cnt = counts[c.key] || { oikein: 0, vaarin: 0, notes: [] }
        const cpct = categoryPct(cnt)
        const notes = cnt.notes || []
        const notesOpen = !!openNotes[c.key]
        return (
          <div key={c.key} style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 14, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{c.label}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: indexColor(cpct) }}>{cpct == null ? '–' : `${cpct}%`}</div>
            </div>
            <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 10, lineHeight: 1.4 }}>{c.desc}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => onBump(type, c.key, 'oikein', 1)} style={{ flex: 1, padding: '10px 4px', borderRadius: 10, border: '1px solid #059669', background: 'rgba(5,150,105,0.1)', color: '#059669', fontWeight: 700, fontSize: 13 }}>
                ✓ Oikein ({cnt.oikein})
              </button>
              <button onClick={() => onBump(type, c.key, 'vaarin', 1)} style={{ flex: 1, padding: '10px 4px', borderRadius: 10, border: '1px solid #dc2626', background: 'rgba(220,38,38,0.1)', color: '#dc2626', fontWeight: 700, fontSize: 13 }}>
                ✗ Väärin ({cnt.vaarin})
              </button>
              {(cnt.oikein > 0 || cnt.vaarin > 0) && (
                <button onClick={() => {
                  if (cnt.vaarin > 0) onBump(type, c.key, 'vaarin', -1)
                  else if (cnt.oikein > 0) onBump(type, c.key, 'oikein', -1)
                }} title="Kumoa viimeisin" style={{ padding: '10px 10px', borderRadius: 10, border: '1px solid #e3e8ef', background: '#f1f4f9', color: '#64748b', fontSize: 13 }}>
                  ↺
                </button>
              )}
            </div>

            {/* Puutteet: vapaaehtoinen dokumentointi virallisen lomakkeen
                Huomautukset/Vastuuhenkilö/Korjattu-sarakkeen tapaan. */}
            <button onClick={() => toggleNotes(c.key)} style={{ marginTop: 10, background: 'none', border: 'none', padding: '4px 0', fontSize: 12, fontWeight: 700, color: notes.length ? '#dc2626' : '#64748b', display: 'flex', alignItems: 'center', gap: 5 }}>
              {notesOpen ? '▾' : '▸'} 🗒 Puutteet {notes.length ? `(${notes.length})` : ''}
            </button>

            {notesOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4, paddingTop: 10, borderTop: '1px solid #f1f4f9' }}>
                {notes.map(n => (
                  <div key={n.id} style={{ background: '#f8fafc', border: n.carried && !n.korjattu ? '1px solid #f0c36d' : '1px solid #f1f4f9', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ ...labelStyle, marginBottom: 0 }}>
                        Kuvaus puutteesta
                        {n.carried && !n.korjattu && (
                          <span style={{ marginLeft: 6, color: '#a67c00', textTransform: 'none', fontWeight: 700, fontSize: 10.5 }}>↩ edelliseltä kierrokselta</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button disabled={!(n.desc || '').trim()} onClick={() => onToObservation(type, c.key, n)} title="Siirrä havainnoksi: asiakas näkee ja voi kuitata sen"
                          style={{ background: '#eaf3fe', border: '1px solid #cfe3fb', borderRadius: 8, color: '#0a5bb5', fontSize: 11.5, fontWeight: 700, padding: '4px 8px', opacity: (n.desc || '').trim() ? 1 : 0.4 }}>➜ Havainnoksi</button>
                        <button onClick={() => onRemoveNote(type, c.key, n.id)} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 15 }}>🗑</button>
                      </div>
                    </div>
                    <textarea style={{ ...selectStyle, resize: 'none', minHeight: 44, lineHeight: 1.4 }}
                      placeholder="esim. Suojakaide puuttuu tasolta 2" value={n.desc}
                      onChange={e => onUpdateNote(type, c.key, n.id, { desc: e.target.value })} />
                    <div>
                      <div style={labelStyle}>Vastuuhenkilö</div>
                      {(subcontractors.length === 0 || customVastuu[n.id] || (n.vastuuhenkilo && !subcontractors.some(s => s.name === n.vastuuhenkilo))) ? (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input style={{ ...inputStyle, flex: 1 }} placeholder="Kuka korjaa" value={n.vastuuhenkilo}
                            onChange={e => onUpdateNote(type, c.key, n.id, { vastuuhenkilo: e.target.value })} />
                          {subcontractors.length > 0 && (
                            <button onClick={() => { setCustomVastuu(p => ({ ...p, [n.id]: false })); onUpdateNote(type, c.key, n.id, { vastuuhenkilo: '' }) }}
                              title="Takaisin listaan" style={{ padding: '0 12px', borderRadius: 10, border: '1px solid #e3e8ef', background: '#f1f4f9', color: '#64748b', fontSize: 12 }}>↩</button>
                          )}
                        </div>
                      ) : (
                        <select style={selectStyle} value={n.vastuuhenkilo}
                          onChange={e => {
                            const v = e.target.value
                            if (v === '__other__') { setCustomVastuu(p => ({ ...p, [n.id]: true })); onUpdateNote(type, c.key, n.id, { vastuuhenkilo: '' }) }
                            else onUpdateNote(type, c.key, n.id, { vastuuhenkilo: v })
                          }}>
                          <option value="" disabled>Valitse…</option>
                          {subcontractors.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                          <option value="__other__">✎ Muu (kirjoita itse)</option>
                        </select>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#0f172a' }}>
                        <input type="checkbox" checked={n.korjattu}
                          onChange={e => onUpdateNote(type, c.key, n.id, { korjattu: e.target.checked })} />
                        Korjattu
                      </label>
                      {n.korjattu && (
                        <input type="date" style={{ ...inputStyle, flex: 1 }} value={n.korjattuPvm}
                          onChange={e => onUpdateNote(type, c.key, n.id, { korjattuPvm: e.target.value })} />
                      )}
                    </div>
                  </div>
                ))}
                <button onClick={() => onAddNote(type, c.key)} style={{ padding: '9px 4px', border: '1.5px dashed #cbd3df', borderRadius: 10, background: 'none', color: '#64748b', fontSize: 12.5 }}>
                  ＋ Lisää puute
                </button>
              </div>
            )}
          </div>
        )
      })}

      <button onClick={() => onReset(type)} style={{ alignSelf: 'flex-end', background: 'none', border: 'none', fontSize: 11, color: '#64748b', padding: '4px 0' }}>
        🗑 Nollaa mittaus
      </button>

      <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5, padding: '4px 2px 16px' }}>{legalNote}</div>
    </div>
  )
}

const inputStyle = {
  background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10,
  color: '#0f172a', fontSize: 14, padding: '9px 12px', width: '100%', outline: 'none',
}
const selectStyle = {
  background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10,
  color: '#0f172a', fontSize: 14, padding: '9px 12px', width: '100%', outline: 'none',
  WebkitAppearance: 'none', appearance: 'none',
}
const menuItem = { display: 'block', padding: '11px 14px', fontSize: 14, color: '#0f172a', textDecoration: 'none', cursor: 'pointer' }
const labelStyle = {
  fontSize: 11, fontWeight: 700, color: '#64748b',
  letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 5,
}
