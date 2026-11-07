// src/WorkLog.jsx — Valvomon Työajat-näkymä (vain konsultti, vain omat).
//
// Konsultin omat työpäivät laskutusta varten. Kuukausi kerrallaan:
//   1) Laskutettavaa asiakkaittain → valmiit laskurivit UKKO:hon kopioitavaksi
//      (rakentamispalvelu alv 0 / käännetty, konsultointi alv 25,5 %)
//   2) Oma matkalasku → km-korvaukset + päivärahat (Korpnex maksaa verovapaasti)
//   3) Materiaalien kulutus työmaittain (laskutettavat ja pelkkä seuranta)
//   4) Kaikki kuukauden merkinnät, muokkaus, toisto ja arkistointi
// Jakso valitaan: viikko / kuukausi / vuosi (tuntiyhteenveto WorkSummary.jsx).
// "Päivä käynnissä" (DayFlow.jsx): työpäivä napeilla lähdöstä kotiinpaluuseen,
// ajo ja työaika samassa kulussa, työmaan vaihto kesken päivän.
// Laskutustila: laskuttamatta / laskutettu (lasku wl_invoices) / ei laskuteta.
// Laskenta on src/worklog.js:ssä. Tietokanta: supabase/tyoajat.sql (RLS:
// vain kirjautunut konsultti näkee omat rivinsä, asiakasportaalissa ei koskaan).
// Näytetään omana osionaan WorkApp.jsx:ssä (/?tyoajat). Välilehdet: Kirjaukset,
// Laskutus, Asiakkaat & työmaat, Asetukset. /?tyoajat&uusi avaa kirjauslomakkeen.
// Asiakkaat & työmaat (WorkRegistry.jsx): työmaan valinta täyttää asiakkaan,
// hinnat, km:t ja ALV-käsittelyn. Työaika alku–loppu → tunnit 15 min tarkkuudella,
// ruokatauko napista; lähtö/paluu kotiin → päivärahaehdotus.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sb } from './supabaseClient.js'
import {
  loadSettings, saveSettings, DEFAULT_SETTINGS, KIND_LABELS, PER_DIEM_LABELS, UNITS, MATERIAL_UNITS, TES_NIMIKKEET, findNimike,
  buildMaterialUsage, materialUsageText,
  num, round2, unitPrice, entryTotals, buildInvoice, buildTravelClaim, travelClaimText,
  buildUkkoRows, ukkoText, groupMessageText, datesText,
  monthKey, monthLabel, fmtEur, fmtNum, fmtDate,
  calcHours, suggestPerDiem, isOpenTrip, fmtTime, fmtDuration, clientInfoLines, VAT_MODE_LABELS,
  periodRange, shiftPeriod, periodLabel, periodKey, PERIOD_LABELS,
  isBillable, billingState, BILLING_LABELS, workHours, dayTravel,
} from './worklog.js'
import { downloadWorkbook } from './worklogXlsx.js'
import WorkRegistry, { ClientModal, SiteModal } from './WorkRegistry.jsx'
import { downloadUkkoTravelClaim } from './ukkoMatkalasku.js'
import DriveLog, { TripModal, OpenTripBanner } from './DriveLog.jsx'
import { DayStartModal, DayPanel, DAYFLOW_CSS } from './DayFlow.jsx'
import WorkSummary, { SUMMARY_CSS } from './WorkSummary.jsx'

const TYOLAJIT = ['Silikonin veto', 'Elastinen saumaus', 'Akryylisaumaus', 'Pohjanauha', 'Vanhan sauman poisto', 'Ikkunan tiivistys']

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const str = v => (v === null || v === undefined ? '' : String(v).replace('.', ','))
const hhmm = t => (t ? String(t).slice(0, 5) : '')
const BREAK_MIN = 30
const emptyLine = () => ({ tyolaji: '', maara: '', yksikko: 'jm', tes: '' })
const TUNTILAJIT = ['Siivous', 'Kiireapu', 'Valmistelutyöt', 'Odotus', 'Tuntityö']
const emptyMaterial = () => ({ nimi: '', maara: '', yksikko: 'kpl' })
const MATERIAALIT = ['Silikoni', 'Elastinen saumausmassa', 'Akryylimassa', 'Pohjanauha', 'Primer', 'Puhdistusaine', 'Maalarinteippi']

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* vanha selain */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    const ok = document.execCommand('copy'); ta.remove(); return ok
  } catch { return false }
}

export default function WorkLog({ showToast }) {
  // Jakso: viikko | kuukausi | vuosi, anchor = mikä tahansa päivä jaksolta
  const [mode, setModeState] = useState(() => {
    try { const m = localStorage.getItem('korpnex_tt_worklog_mode'); return PERIOD_LABELS[m] ? m : 'month' } catch { return 'month' }
  })
  const setMode = m => { setModeState(m); try { localStorage.setItem('korpnex_tt_worklog_mode', m) } catch { /* ok */ } }
  const [anchor, setAnchor] = useState(todayISO)
  const range = periodRange(mode, anchor)
  const month = monthKey(anchor) // UKKO- ja Excel-viennit (kuukausi)
  const pLabel = periodLabel(mode, anchor)
  const [entries, setEntries] = useState([])
  // Päivä käynnissä: keskeneräiset kirjaukset (status 'kaynnissa') ja niiden ajot
  const [live, setLive] = useState({ entries: [], trips: [] })
  const [dayStart, setDayStart] = useState(false)
  const [olderUnbilled, setOlderUnbilled] = useState([]) // aiempien jaksojen laskuttamattomat
  const [invoices, setInvoices] = useState([])
  const [invoiceModal, setInvoiceModal] = useState(null) // { client, list, cl }
  const [filter, setFilter] = useState('kaikki') // kaikki | laskuttamatta | laskutettu | ei
  const [recent, setRecent] = useState([]) // asiakas-/työmaa-ehdotuksiin
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [settings, setSettings] = useState(loadSettings)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  // kirjaukset | laskutus | rekisteri | asetukset (viimeisin muistetaan)
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('korpnex_tt_worklog_tab') || 'kirjaukset' } catch { return 'kirjaukset' }
  })
  const changeTab = t => { setTab(t); try { localStorage.setItem('korpnex_tt_worklog_tab', t) } catch { /* ok */ } }
  const [clients, setClients] = useState([])
  const [sites, setSites] = useState([])
  const [clientEdit, setClientEdit] = useState(null) // { ...asiakas } | { } uusi
  const [siteEdit, setSiteEdit] = useState(null)
  // Uusi työmaa avattu työpäivälomakkeesta → valitaan se lomakkeelle tallennuksen jälkeen
  const siteForDraftRef = useRef(false)
  // Kenttäsovelluksen "Kirjaa työpäivä" -linkki (?uusi) avaa lomakkeen heti,
  // kun edelliset merkinnät on haettu (asiakas ja km esitäytetään niistä).
  const openNewRef = useRef(new URLSearchParams(window.location.search).has('uusi'))
  // ?ajo (kenttäsovelluksen valikosta): avaa ajon aloituksen tai lopetuksen
  const openTripRef = useRef(new URLSearchParams(window.location.search).has('ajo'))
  // ?paiva (kenttäsovelluksen valikosta): aloittaa työpäivän tai näyttää käynnissä olevan
  const openDayRef = useRef(new URLSearchParams(window.location.search).has('paiva'))
  const [trips, setTrips] = useState([])
  const [openTrip, setOpenTrip] = useState(null)
  const [lastOdo, setLastOdo] = useState(null)
  const [tripModal, setTripModal] = useState(null) // { mode, trip }

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    const { from, to } = range
    const [m, r, c, st, tr, ot, lo, lv, ou] = await Promise.all([
      sb.from('work_entries').select('*').eq('archived', false).gte('work_date', from).lte('work_date', to)
        .order('work_date', { ascending: false }).order('id', { ascending: false }),
      sb.from('work_entries').select('client_name, site, site_id, kind, hourly_rate, km, km_rate, km_billable, multiplier, start_time, end_time, break_minutes')
        .eq('archived', false).order('work_date', { ascending: false }).order('id', { ascending: false }).limit(300),
      sb.from('wl_clients').select('*').order('name'),
      sb.from('wl_sites').select('*').order('name'),
      sb.from('wl_trips').select('*').eq('archived', false).gte('trip_date', from).lte('trip_date', to).order('trip_date').order('start_time'),
      sb.from('wl_trips').select('*').eq('archived', false).not('odo_start', 'is', null).is('odo_end', null).is('end_time', null)
        .is('entry_id', null).order('trip_date', { ascending: false }).limit(1),
      sb.from('wl_trips').select('odo_start, odo_end, km').eq('archived', false).not('odo_start', 'is', null).order('odo_start', { ascending: false }).limit(10),
      sb.from('work_entries').select('*').eq('archived', false).eq('status', 'kaynnissa').order('id'),
      sb.from('work_entries').select('*').eq('archived', false).is('invoiced_at', null).lt('work_date', from)
        .order('work_date', { ascending: false }).limit(500),
    ])
    // Käynnissä oleva päivä ja sen ajot (sarakkeita ei ole ennen tyoajat.sql:n päivitystä → ei päivää)
    const liveEntries = lv.error ? [] : (lv.data || [])
    let liveTrips = []
    if (liveEntries.length) {
      const lt = await sb.from('wl_trips').select('*').eq('archived', false).in('entry_id', liveEntries.map(e => e.id))
      liveTrips = lt.error ? [] : (lt.data || [])
    }
    setLive({ entries: liveEntries, trips: liveTrips })
    setOlderUnbilled(ou.error ? [] : (ou.data || []).filter(e => e.status !== 'kaynnissa' && isBillable(e)))
    const doneEntries = (m.data || []).filter(e => e.status !== 'kaynnissa')
    const invIds = [...new Set(doneEntries.map(e => e.invoice_id).filter(Boolean))]
    if (invIds.length) {
      const iv = await sb.from('wl_invoices').select('*').in('id', invIds).order('invoice_date', { ascending: false })
      setInvoices(iv.error ? [] : (iv.data || []))
    } else setInvoices([])
    const monthTrips = tr.error ? [] : (tr.data || [])
    setTrips(monthTrips)
    const open = ot.error ? null : (ot.data?.[0] || null)
    setOpenTrip(open)
    // Viimeisin tunnettu mittarilukema: loppulukema, tai alkulukema + km jos ajo kirjattiin pelkillä km:illä
    const odoReadings = (lo.error ? [] : (lo.data || [])).map(t => t.odo_end ?? (num(t.km) > 0 ? t.odo_start + Math.round(num(t.km)) : t.odo_start))
    setLastOdo(odoReadings.length ? Math.max(...odoReadings) : null)
    const regClients = c.error ? [] : (c.data || [])
    const regSites = st.error ? [] : (st.data || [])
    if (!c.error) setClients(regClients)
    if (!st.error) setSites(regSites)
    if (m.error) {
      console.error('work_entries load failed:', m.error)
      setErr(/relation|does not exist|schema cache/i.test(m.error.message)
        ? 'Työajat-taulua ei löydy. Aja supabase/tyoajat.sql Supabasen SQL Editorissa.'
        : 'Työaikojen haku epäonnistui. Tarkista yhteys ja päivitä.')
      setEntries([])
    } else setEntries(doneEntries)
    if (!r.error) setRecent(r.data || [])
    setLoading(false)
    if (openNewRef.current) {
      openNewRef.current = false
      setDraft(newDraft(null, { last: (r.data || [])[0], clients: regClients, sites: regSites, trips: monthTrips }))
      const p = new URLSearchParams(window.location.search)
      p.delete('uusi')
      const qs = p.toString().replace(/=(?=&|$)/g, '')
      try { window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '')) } catch { /* ei väliä */ }
    }
    if (openTripRef.current) {
      openTripRef.current = false
      setTripModal(open ? { mode: 'end', trip: open } : { mode: 'start', trip: null })
      const p = new URLSearchParams(window.location.search)
      p.delete('ajo')
      const qs = p.toString().replace(/=(?=&|$)/g, '')
      try { window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '')) } catch { /* ei väliä */ }
    }
    if (openDayRef.current) {
      openDayRef.current = false
      if (!liveEntries.length) setDayStart(true)
      else setTimeout(() => document.getElementById('kx-day-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
      const p = new URLSearchParams(window.location.search)
      p.delete('paiva')
      const qs = p.toString().replace(/=(?=&|$)/g, '')
      try { window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '')) } catch { /* ei väliä */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to])
  useEffect(() => { load() }, [load])


  const clientNames = useMemo(() => [...new Set(recent.map(r => r.client_name).filter(Boolean))], [recent])
  const materialNames = useMemo(() => [...new Set(entries.flatMap(e => (e.materials || []).map(m => m.nimi)).filter(Boolean))], [entries])
  const siteNames = useMemo(() => [...new Set(recent.map(r => r.site).filter(Boolean))], [recent])

  function updateTextSetting(key, value) {
    setSettings(prev => {
      const next = { ...prev, [key]: String(value || '').trim() }
      saveSettings(next)
      return next
    })
  }
  function updateSetting(key, value) {
    setSettings(prev => {
      const next = { ...prev, [key]: num(value) }
      saveSettings(next)
      return next
    })
  }

  // --- Lomake ---------------------------------------------------------------
  const clientById = (id, list = clients) => list.find(c => c.id === id) || null
  const clientByName = name => clients.find(c => !c.archived && c.name.trim().toLowerCase() === (name || '').trim().toLowerCase()) || null

  // Työmaan valinta täyttää asiakkaan, ALV:n, km:t ja hinnat
  function applySite(d, site, ctx = {}) {
    const client = clientById(site.client_id, ctx.clients || clients)
    const kind = d.id ? d.kind : site.kind
    const rate = kind === 'konsultointi' ? settings.consultRate : (client?.hourly_rate ?? settings.hourlyRate)
    const next = {
      ...d, site_id: site.id, site: site.name, client_name: client?.name || d.client_name,
      vat_mode: client?.vat_mode || 'kaannetty', kind, freeText: false,
      hourly_rate: str(rate),
      km: site.km != null ? str(site.km) : d.km,
      km_rate: str(client?.km_rate ?? settings.kmRate),
      per_diem_billable: !!client?.bill_per_diem,
    }
    return withPerDiem(next)
  }

  function newDraft(base, ctx = {}) {
    const last = ctx.last ?? recent[0]
    const siteList = ctx.sites || sites
    const siteId = base?.site_id ?? last?.site_id
    const site = siteList.find(x => x.id === siteId && !x.archived)
    let d = {
      id: null, invoiced_at: null,
      work_date: todayISO(),
      site_id: base?.site_id ?? null,
      freeText: false,
      vat_mode: base?.vat_mode ?? 'kaannetty',
      client_name: base?.client_name ?? (site ? '' : last?.client_name ?? ''),
      site: base?.site ?? (site ? '' : last?.site ?? ''),
      kind: base?.kind ?? 'tunti',
      hours: str(base?.hours ?? 8),
      hourly_rate: str(base?.hourly_rate ?? settings.hourlyRate),
      lines: base?.lines?.length ? base.lines.map(l => ({ ...l, maara: str(l.maara), tes: str(l.tes) })) : [emptyLine()],
      multiplier: str(base?.multiplier ?? settings.multiplier),
      km: str(base?.km ?? (last?.km || '')),
      km_billable: base?.km_billable ?? last?.km_billable ?? true,
      km_rate: str(base?.km_rate ?? settings.kmRate),
      travel_hours: str(base?.travel_hours || ''),
      travel_rate: str(base?.travel_rate || 0),
      per_diem: base?.per_diem ?? 'ei',
      per_diem_billable: base?.per_diem_billable ?? false,
      // Toistossa samat kellonajat ja materiaalit valmiiksi (määrät kirjataan uudelleen)
      start_time: hhmm(base?.start_time ?? last?.start_time),
      end_time: hhmm(base?.end_time ?? last?.end_time),
      break_minutes: base?.break_minutes ?? 0,
      depart_time: hhmm(base?.depart_time),
      return_time: hhmm(base?.return_time),
      materials: (base?.materials || []).map(m => ({ nimi: m.nimi, yksikko: m.yksikko, maara: '' })),
      notes: '',
    }
    if (site && !base) d = applySite(d, site, ctx)
    else if (!site && !d.client_name) d.freeText = !(ctx.sites || sites).some(x => !x.archived)
    if (!base) d = withTrip(d, ctx)
    return withHours(d)
  }
  // opts.finalize: Päivä käynnissä -kirjauksen tarkistus → tallennus merkitsee valmiiksi
  function editDraft(e, opts = {}) {
    setDraft({
      ...e,
      _finalize: !!opts.finalize,
      _step: opts.step || '',
      hours: str(e.hours), hourly_rate: str(e.hourly_rate), multiplier: str(e.multiplier),
      km: str(e.km || ''), km_rate: str(e.km_rate), travel_hours: str(e.travel_hours || ''), travel_rate: str(e.travel_rate),
      lines: e.lines?.length ? e.lines.map(l => ({ ...l, maara: str(l.maara), tes: str(l.tes) })) : [emptyLine()],
      materials: (e.materials || []).map(m => ({ nimi: m.nimi, yksikko: m.yksikko, maara: str(m.maara) })),
      notes: e.notes || '',
      start_time: hhmm(e.start_time), end_time: hhmm(e.end_time), break_minutes: e.break_minutes || 0,
      depart_time: hhmm(e.depart_time), return_time: hhmm(e.return_time),
      vat_mode: e.vat_mode || 'kaannetty',
      per_diem_billable: !!e.per_diem_billable,
      freeText: !e.site_id,
    })
  }
  const setD = (k, v) => setDraft(d => ({ ...d, [k]: v }))
  function setKind(kind) {
    setDraft(d => {
      let rate = d.hourly_rate
      if (kind === 'konsultointi' && num(rate) === num(settings.hourlyRate)) rate = str(settings.consultRate)
      if (kind === 'tunti' && num(rate) === num(settings.consultRate)) rate = str(settings.hourlyRate)
      return withHours({ ...d, kind, hourly_rate: rate })
    })
  }
  // Saman päivän ajopäiväkirjan ajo (ei vielä liitetty työpäivään) täyttää
  // km:t, lähtö- ja paluuajan sekä työmaan. Tallennus liittää ajon työpäivään.
  function withTrip(d, ctx = {}) {
    const t = (ctx.trips || trips).find(x => x.trip_date === d.work_date && !x.entry_id && !isOpenTrip(x) && num(x.km) > 0)
    if (!t) return d
    let next = { ...d, _tripId: t.id, km: str(t.km), depart_time: hhmm(t.start_time) || d.depart_time, return_time: hhmm(t.end_time) || d.return_time }
    const site = t.site_id && (ctx.sites || sites).find(x => x.id === t.site_id && !x.archived)
    if (site && !d.site_id) next = applySite(next, site, ctx)
    if (site) next.km = str(t.km)
    return withPerDiem(next)
  }

  // Tunnit kellonajoista (15 min pyöristys). Käsin kirjoitettu tunti-arvo säilyy,
  // kunnes kellonaikoja tai taukoa muutetaan.
  function withHours(d) {
    const c = calcHours(d.start_time, d.end_time, d.break_minutes)
    return c && d.kind !== 'urakka' ? { ...d, hours: str(c.hours) } : d
  }
  // Päivärahan etäisyys: omat km, tai toisen kyydillä työmaan km-tieto
  function tripDistance(d) {
    if (num(d.km) > 0) return num(d.km)
    const site = d.site_id && sites.find(x => x.id === d.site_id)
    return num(site?.km)
  }
  function withPerDiem(d) {
    const sug = suggestPerDiem(d.depart_time, d.return_time, tripDistance(d))
    return sug ? { ...d, per_diem: sug.value } : d
  }
  function setTime(k, v) {
    setDraft(d => {
      let next = { ...d, [k]: v }
      if (k === 'start_time' || k === 'end_time' || k === 'break_minutes') next = withHours(next)
      if (k === 'depart_time' || k === 'return_time') next = withPerDiem(next)
      return next
    })
  }
  function toggleBreak() {
    setTime('break_minutes', draft.break_minutes ? 0 : BREAK_MIN)
  }
  function pickSite(v) {
    if (v === '__new') {
      siteForDraftRef.current = true
      setSiteEdit({ client_id: clientByName(draft.client_name)?.id })
      return
    }
    if (v === '__free') { setDraft(d => ({ ...d, site_id: null, freeText: true })); return }
    const site = sites.find(x => String(x.id) === String(v))
    if (site) setDraft(d => applySite(d, site))
  }
  const setMat = (i, k, v) => setDraft(d => ({ ...d, materials: d.materials.map((m, j) => j === i ? { ...m, [k]: v } : m) }))
  const setLine = (i, k, v) => setDraft(d => ({ ...d, lines: d.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) }))
  // Nimikkeen valinta täyttää työlajin, yksikön ja TES-hinnan
  function pickNimike(i, v) {
    setDraft(d => ({
      ...d,
      lines: d.lines.map((l, j) => {
        if (j !== i) return l
        if (v === '__custom') return { ...l, _custom: true, tyolaji: findNimike(l.tyolaji) ? '' : l.tyolaji }
        const n = findNimike(v)
        return n ? { ...l, _custom: false, tyolaji: n.label, yksikko: n.unit, tes: str(n.tes) } : { ...l, _custom: false, tyolaji: '' }
      }),
    }))
  }
  // Tuntirivi urakan ohessa (esim. siivous): tuntihinta oletuksena asiakkaan €/h
  const emptyHourLine = () => {
    const site = draft?.site_id && sites.find(x => x.id === draft.site_id)
    const rate = (site && clientById(site.client_id)?.hourly_rate) || num(draft?.hourly_rate) || settings.hourlyRate
    return { tyolaji: '', maara: '', yksikko: 'h', tes: str(rate), hourly: true }
  }

  function draftToRow(d) {
    return {
      work_date: d.work_date,
      client_name: d.client_name.trim(),
      site: d.site.trim() || null,
      kind: d.kind,
      hours: d.kind === 'urakka' ? 0 : num(d.hours),
      hourly_rate: d.kind === 'urakka' ? 0 : num(d.hourly_rate),
      lines: d.kind === 'urakka'
        ? d.lines.filter(l => num(l.maara) && num(l.tes)).map(l => l.hourly
          ? { tyolaji: (l.tyolaji || '').trim() || 'Tuntityö', maara: num(l.maara), yksikko: 'h', tes: num(l.tes), hourly: true }
          : { tyolaji: (l.tyolaji || '').trim() || 'Urakkatyö', maara: num(l.maara), yksikko: l.yksikko || 'jm', tes: num(l.tes), ...((l.kohta || '').trim() ? { kohta: l.kohta.trim() } : {}) })
        : [],
      multiplier: num(d.multiplier) || DEFAULT_SETTINGS.multiplier,
      materials: (d.materials || []).filter(m => (m.nimi || '').trim() && num(m.maara))
        .map(m => ({ nimi: m.nimi.trim(), maara: num(m.maara), yksikko: m.yksikko || 'kpl' })),
      km: num(d.km),
      km_billable: !!d.km_billable,
      km_rate: num(d.km_rate),
      travel_hours: num(d.travel_hours),
      travel_rate: num(d.travel_rate),
      per_diem: d.per_diem,
      per_diem_billable: d.per_diem !== 'ei' && !!d.per_diem_billable,
      site_id: d.site_id || null,
      vat_mode: d.vat_mode || 'kaannetty',
      start_time: d.start_time || null,
      end_time: d.end_time || null,
      break_minutes: Number(d.break_minutes) || 0,
      depart_time: d.depart_time || null,
      return_time: d.return_time || null,
      notes: d.notes.trim() || null,
      invoiced_at: d.invoiced_at || null,
      // Uudet sarakkeet vain kun niillä on merkitystä, jotta tallennus toimii myös
      // ennen kuin tyoajat.sql on ajettu uudelleen
      ...(d._finalize ? { status: 'valmis' } : {}),
      ...(d.billing === 'ei' || 'billing' in d ? { billing: d.billing === 'ei' ? 'ei' : 'laskutettava' } : {}),
      ...('invoice_id' in d ? { invoice_id: d.invoiced_at ? (d.invoice_id || null) : null } : {}),
    }
  }

  // Päivä käynnissä -kulun uusi kirjaus: työmaan (tai vapaan asiakkaan) hinnat ja ALV
  function makeEntryRow(siteId, free) {
    let d = newDraft(null, { trips: [] })
    const site = siteId && sites.find(x => x.id === siteId)
    if (site) d = applySite(d, site)
    else d = { ...d, site_id: null, freeText: true, client_name: free?.client_name || '', site: free?.site || '', vat_mode: 'kaannetty', hourly_rate: str(settings.hourlyRate), km_rate: str(settings.kmRate), per_diem_billable: false }
    return draftToRow({ ...d, notes: '' })
  }
  const liveIds = live.entries.map(e => e.id)
  async function reviewDay(first) {
    // Tuoreet tiedot kannasta (km-jako ja ajat päivittyivät juuri)
    const { data } = await sb.from('work_entries').select('*').eq('id', first.id)
    const n = live.entries.length, i = live.entries.findIndex(e => e.id === first.id)
    editDraft(data?.[0] || first, { finalize: true, step: n > 1 && i >= 0 ? `${i + 1}/${n}` : '' })
  }

  async function save() {
    const row = draftToRow(draft)
    if (!row.work_date) { showToast('⚠ Valitse päivä'); return }
    if (!row.client_name) { showToast(draft.freeText ? '⚠ Kirjoita asiakas' : '⚠ Valitse työmaa'); return }
    const stillLive = draft.status === 'kaynnissa' && !draft._finalize // korjaus kesken päivän
    if (!stillLive && (row.kind === 'urakka' ? !row.lines.length : !row.hours)) {
      showToast(row.kind === 'urakka' ? '⚠ Lisää vähintään yksi urakka- tai tuntirivi (määrä ja hinta)' : '⚠ Kirjoita tunnit'); return
    }
    setSaving(true)
    const res = draft.id
      ? await sb.from('work_entries').update(row).eq('id', draft.id).select()
      : await sb.from('work_entries').insert([row]).select()
    setSaving(false)
    if (res.error) {
      console.error('work_entries save failed:', res.error)
      showToast(/column|schema cache/i.test(res.error.message || '') ? '⚠ Tietokanta pitää päivittää: aja supabase/tyoajat.sql uudelleen' : '⚠ Tallennus epäonnistui')
      return
    }
    const saved = res.data?.[0]
    if (saved && !draft.id && draft._tripId) {
      await sb.from('wl_trips').update({ entry_id: saved.id }).eq('id', draft._tripId)
    }
    // Liitetyn ajon km pysyy samana kuin työpäivän km (tarkistuksessa korjattu jako)
    if (saved && draft._finalize) {
      await sb.from('wl_trips').update({ km: num(saved.km) }).eq('entry_id', saved.id).eq('archived', false)
    }
    if (draft._finalize) {
      const next = live.entries.find(e => e.id !== draft.id && e.status === 'kaynnissa')
      if (next) {
        showToast('✓ Tallennettu, tarkista vielä seuraava työmaa')
        await reviewDay(next)
        load()
        return
      }
      showToast('✓ Työpäivä tallennettu')
      changeTab('kirjaukset')
    } else showToast(draft.id ? '✓ Muutokset tallennettu' : '✓ Työpäivä kirjattu')
    if (!draft.id) changeTab('kirjaukset')
    setDraft(null)
    if (saved && (saved.work_date < range.from || saved.work_date > range.to)) setAnchor(saved.work_date)
    else load()
  }

  const reloadRegistry = useCallback(async () => {
    const [c, st] = await Promise.all([
      sb.from('wl_clients').select('*').order('name'),
      sb.from('wl_sites').select('*').order('name'),
    ])
    const cl = c.error ? clients : (c.data || [])
    const si = st.error ? sites : (st.data || [])
    setClients(cl); setSites(si)
    return { clients: cl, sites: si }
  }, [clients, sites])

  async function archive(e) {
    if (!window.confirm(`Poistetaanko merkintä ${fmtDate(e.work_date)} (${e.client_name})?`)) return
    const { error } = await sb.from('work_entries').update({ archived: true }).eq('id', e.id)
    if (error) { showToast('⚠ Poisto epäonnistui'); return }
    showToast('🗑 Merkintä poistettu'); setDraft(null); load()
  }

  // Laskutetuksi merkintä: luo laskun (wl_invoices) numerolla ja päivällä ja linkittää
  // päivät siihen. Jos taulua ei vielä ole, merkitään pelkkä laskutuspäivä kuten ennen.
  async function markInvoiced({ list, client, cl, number, date }) {
    const inv = buildInvoice(list, settings)
    const net = round2((inv.kaannetty?.net || 0) + (inv.alv?.net || 0))
    const vat = round2(inv.alv?.vat || 0)
    const at = new Date(`${date}T12:00:00`).toISOString()
    let invoiceId = null
    const ins = await sb.from('wl_invoices').insert([{
      client_name: client, client_id: cl?.id || null, invoice_number: (number || '').trim() || null,
      invoice_date: date, net, vat,
    }]).select()
    if (!ins.error) invoiceId = ins.data?.[0]?.id ?? null
    else console.warn('wl_invoices insert failed (aja tyoajat.sql):', ins.error)
    const upd = invoiceId ? { invoiced_at: at, invoice_id: invoiceId } : { invoiced_at: at }
    const { error } = await sb.from('work_entries').update(upd).in('id', list.map(e => e.id))
    if (error) { showToast('⚠ Tallennus epäonnistui'); return false }
    showToast(`✓ Merkitty laskutetuksi${number ? ` (lasku ${number})` : ''}`); load()
    return true
  }
  async function cancelInvoice(invoice, list) {
    if (!window.confirm(`Perutaanko laskutus${invoice?.invoice_number ? ` (lasku ${invoice.invoice_number})` : ''}? ${list.length} päivää palaa laskuttamattomiksi.`)) return
    const ids = list.map(e => e.id)
    const upd = 'invoice_id' in (list[0] || {}) ? { invoiced_at: null, invoice_id: null } : { invoiced_at: null }
    const { error } = await sb.from('work_entries').update(upd).in('id', ids)
    if (error) { showToast('⚠ Peruminen epäonnistui'); return }
    if (invoice?.id) {
      const { count } = await sb.from('work_entries').select('id', { count: 'exact', head: true }).eq('invoice_id', invoice.id)
      if (!count) await sb.from('wl_invoices').delete().eq('id', invoice.id)
    }
    showToast('↩ Laskutus peruttu'); load()
  }

  async function downloadUkko() {
    if (!settings.travelName || !settings.homeAddress) {
      changeTab('asetukset')
      showToast('⚠ Täytä ensin matkalaskun tiedot: nimi ja kotiosoite')
      setTimeout(() => document.getElementById('kx-wl-travelinfo')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
      return
    }
    setExporting(true)
    try {
      await downloadUkkoTravelClaim(entries, sites, { name: settings.travelName, homeAddress: settings.homeAddress, vehicle: settings.vehicle }, settings, periodKey(mode, anchor), trips)
      showToast('✓ UKKO-matkalasku ladattu')
    } catch (e) {
      console.error('ukko travel claim failed:', e)
      showToast('⚠ Matkalaskun teko epäonnistui')
    }
    setExporting(false)
  }

  async function downloadExcel() {
    setExporting(true)
    try {
      await downloadWorkbook(entries, settings, { key: periodKey(mode, anchor), label: pLabel }, clients, sites, trips)
      showToast('✓ Excel ladattu')
    } catch (e) {
      console.error('xlsx export failed:', e)
      showToast('⚠ Excelin teko epäonnistui')
    }
    setExporting(false)
  }

  // --- Kuukauden yhteenvedot -------------------------------------------------
  const byClient = useMemo(() => {
    const m = new Map()
    for (const e of entries.filter(isBillable)) {
      const k = e.client_name
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(e)
    }
    // Laskuttamattomat asiakkaat ensin, kokonaan laskutetut perään
    const open = list => list.some(e => !e.invoiced_at && isBillable(e)) ? 0 : 1
    return [...m.entries()].sort((a, b) => open(a[1]) - open(b[1]) || a[0].localeCompare(b[0], 'fi'))
  }, [entries])
  const claim = useMemo(() => buildTravelClaim(entries, settings, trips), [entries, settings, trips])
  const usage = useMemo(() => buildMaterialUsage(entries), [entries])
  const monthTotal = round2(entries.filter(isBillable).reduce((s, e) => s + entryTotals(e, settings).total, 0))
  const unbilledTotal = round2(entries.filter(e => !e.invoiced_at && isBillable(e)).reduce((s, e) => s + entryTotals(e, settings).total, 0))
  const travelByDay = useMemo(() => dayTravel(entries), [entries])
  const counts = useMemo(() => {
    const c = { kaikki: entries.length, laskuttamatta: 0, laskutettu: 0, ei: 0 }
    for (const e of entries) c[billingState(e)]++
    return c
  }, [entries])
  const shown = filter === 'kaikki' ? entries : entries.filter(e => billingState(e) === filter)
  // Aiempien jaksojen laskuttamattomat kuukausittain
  const olderByMonth = useMemo(() => {
    const m = new Map()
    for (const e of olderUnbilled) {
      const k = monthKey(e.work_date)
      const cur = m.get(k) || { key: k, days: 0, eur: 0 }
      cur.days++; cur.eur = round2(cur.eur + entryTotals(e, settings).total)
      m.set(k, cur)
    }
    return [...m.values()]
  }, [olderUnbilled, settings])

  const preview = draft ? entryTotals(draftToRow(draft), settings) : null
  const sameDay = draft && !draft.id ? entries.filter(e => e.work_date === draft.work_date) : []

  return (
    <div className="kx-wl">
      <div className="kx-main-head">
        <div>
          <div className="kx-main-title">Työajat</div>
          <div className="kx-main-sub">Kirjaa työpäivät, tee laskurivit ja matkalasku. Näkyy vain sinulle.</div>
        </div>
        <div className="kx-main-head-actions kx-wl-headbtns">
          {!live.entries.length && <button className="kx-btn-primary" onClick={() => setDayStart(true)}>▶ Aloita työpäivä</button>}
          <button className={live.entries.length ? 'kx-btn-primary' : 'kx-btn-ghost'} onClick={() => setDraft(newDraft())}>＋ Kirjaa jälkikäteen</button>
        </div>
      </div>

      <DayPanel
        live={live} sites={sites} clients={clients} settings={settings} makeEntryRow={makeEntryRow} showToast={showToast}
        onChanged={async (o = {}) => { await load(); if (o.review && live.entries[0]) reviewDay(live.entries[0]) }}
        onReview={reviewDay}
        onEdit={e => editDraft(e)}
      />
      <OpenTripBanner trip={openTrip} onEnd={() => setTripModal({ mode: 'end', trip: openTrip })} />

      <div className="kx-wl-tabbar" role="tablist" aria-label="Työajat-näkymä">
        {[
          ['kirjaukset', '🗓', 'Kirjaukset', 'Kirjaukset'],
          ['ajot', '🚗', 'Ajopäiväkirja', 'Ajot'],
          ['laskutus', '🧾', 'Laskutus', 'Laskutus'],
          ['rekisteri', '🏗', 'Asiakkaat & työmaat', 'Työmaat'],
          ['asetukset', '⚙', 'Asetukset', 'Asetukset'],
        ].map(([k, icon, label, short]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => changeTab(k)}>
            <span aria-hidden="true" className="kx-wl-tabicon">{icon}</span>
            <span className="kx-wl-tablong">{label}</span><span className="kx-wl-tabshort">{short}</span>
          </button>
        ))}
      </div>

      {tab === 'rekisteri' && (
        <WorkRegistry clients={clients} sites={sites} onEditClient={c => setClientEdit(c)} onEditSite={x => setSiteEdit(x)} />
      )}

      {(tab === 'kirjaukset' || tab === 'laskutus' || tab === 'ajot') && <>
      <div className="kx-wl-monthbar">
        <div className="kx-wl-seg kx-wl-periodseg" role="radiogroup" aria-label="Jakso">
          {Object.entries(PERIOD_LABELS).map(([k, l]) => (
            <button key={k} role="radio" aria-checked={mode === k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{l}</button>
          ))}
        </div>
        <div className="kx-wl-periodnav">
          <button className="kx-btn-ghost kx-btn-sm" onClick={() => setAnchor(a => shiftPeriod(mode, a, -1))} aria-label="Edellinen jakso">‹</button>
          <div className="kx-wl-month">{pLabel}</div>
          <button className="kx-btn-ghost kx-btn-sm" onClick={() => setAnchor(a => shiftPeriod(mode, a, 1))} aria-label="Seuraava jakso">›</button>
          {(todayISO() < range.from || todayISO() > range.to) && <button className="kx-btn-ghost kx-btn-sm" onClick={() => setAnchor(todayISO())}>Tänään</button>}
        </div>
        <div className="kx-wl-monthstats" style={tab !== 'laskutus' ? { display: 'none' } : undefined}>
          <span><b>{fmtEur(monthTotal)}</b> laskutettavaa</span>
          {unbilledTotal > 0 && unbilledTotal !== monthTotal && <span className="kx-wl-due">{fmtEur(unbilledTotal)} laskuttamatta</span>}
        </div>
      </div>

      {err && <div className="kx-error">{err}</div>}
      {loading && !entries.length && <div className="kx-empty-note">Ladataan…</div>}

      {!loading && !err && entries.length === 0 && tab !== 'ajot' && (
        <div className="kx-empty-note">
          Ei {tab === 'laskutus' ? 'laskutettavaa' : 'merkintöjä'} jaksolla {pLabel.toLowerCase()}.<br />
          {!live.entries.length && <button className="kx-btn-primary" style={{ marginTop: 12 }} onClick={() => setDayStart(true)}>▶ Aloita työpäivä</button>}
          <button className="kx-btn-ghost" style={{ marginTop: 12, marginLeft: 8 }} onClick={() => setDraft(newDraft())}>＋ Kirjaa jälkikäteen</button>
        </div>
      )}

      {tab === 'ajot' && (
        <DriveLog
          entries={entries} trips={trips.filter(t => !liveIds.includes(t.entry_id))} sites={sites} settings={settings}
          openTrip={openTrip} exporting={exporting} onExcel={downloadExcel}
          onStartTrip={() => setTripModal({ mode: 'start', trip: null })}
          onNewTrip={() => setTripModal({ mode: 'new', trip: null })}
          onEditTrip={r => {
            const t = r.tripId && trips.find(x => x.id === r.tripId)
            if (t) setTripModal({ mode: isOpenTrip(t) ? 'end' : 'edit', trip: t })
            else { const e = entries.find(x => x.id === r.entryId); if (e) editDraft(e) }
          }}
        />
      )}

      {tab === 'laskutus' && entries.length > 0 && (
        <div className="kx-card kx-wl-reports">
          <div>
            <div className="kx-card-title" style={{ margin: 0 }}>Raportit · {pLabel}</div>
            <div className="kx-main-sub">UKKO:n matkalaskupohja täytettynä ja koko jakson Excel-raportti</div>
          </div>
          <div className="kx-wl-actions">
            <button className="kx-btn-primary kx-btn-sm" onClick={downloadUkko} disabled={exporting}>⬇ UKKO-matkalasku</button>
            <button className="kx-btn-ghost kx-btn-sm" onClick={downloadExcel} disabled={exporting}>⬇ Excel-raportti</button>
          </div>
        </div>
      )}

      {tab === 'laskutus' && olderByMonth.length > 0 && (
        <div className="kx-wl-warn kx-wl-older">
          <div><b>Aiemmilta kuukausilta laskuttamatta {fmtEur(round2(olderByMonth.reduce((s, x) => s + x.eur, 0)))}</b></div>
          <div className="kx-wl-actions" style={{ marginTop: 6 }}>
            {olderByMonth.map(x => (
              <button key={x.key} className="kx-btn-ghost kx-btn-sm" onClick={() => { setMode('month'); setAnchor(`${x.key}-15`) }}>
                {monthLabel(x.key)}: {x.days} pv · {fmtEur(x.eur)} →
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'laskutus' && <>
      {/* 1) Laskutettavaa asiakkaittain */}
      {byClient.map(([client, list]) => {
        const unbilled = list.filter(e => !e.invoiced_at)
        const inv = buildInvoice(unbilled, settings)
        const billedTotal = round2(list.filter(e => e.invoiced_at).reduce((s, e) => s + entryTotals(e, settings).total, 0))
        const cl = clientById(list.find(e => e.site_id)?.site_id && sites.find(x => x.id === list.find(e => e.site_id).site_id)?.client_id) || clientByName(client)
        return (
          <div key={client} className="kx-card kx-wl-invoice">
            <div className="kx-wl-invoice-head" style={unbilled.length ? undefined : { marginBottom: 0 }}>
              <div>
                <div className="kx-card-title" style={{ margin: 0 }}>{client}</div>
                <div className="kx-main-sub">
                  {unbilled.length ? `${unbilled.length} laskuttamatonta päivää` : 'Kaikki laskutettu'}
                  {billedTotal > 0 && ` · laskutettu ${fmtEur(billedTotal)}`}
                </div>
              </div>
              {unbilled.length > 0 && (
                <div className="kx-wl-actions">
                  <button className="kx-btn-primary kx-btn-sm" onClick={async () => showToast(await copyText(ukkoText(unbilled, settings)) ? '✓ UKKO-rivit kopioitu' : '⚠ Kopiointi ei onnistunut')}>📋 UKKO-rivit</button>
                  <button className="kx-btn-ghost kx-btn-sm" onClick={async () => showToast(await copyText(groupMessageText(unbilled)) ? '✓ Viesti kopioitu' : '⚠ Kopiointi ei onnistunut')}>💬 Viesti ryhmään</button>
                  <button className="kx-btn-ghost kx-btn-sm" onClick={() => setInvoiceModal({ list: unbilled, client, cl, number: '', date: todayISO() })}>✓ Merkitse laskutetuksi</button>
                </div>
              )}
            </div>
            {unbilled.length > 0 && (() => {
              // Sama sisältö kuin kopioitavassa UKKO-tekstissä: nimikkeet yhdistettynä
              const rows = buildUkkoRows(unbilled, settings)
              const net = round2(rows.reduce((s2, r) => s2 + r.total, 0))
              const sitesTxt = [...new Set(unbilled.map(e => (e.site || '').trim()).filter(Boolean))].join(', ')
              return (
                <div className="kx-wl-group">
                  <div className="kx-wl-group-title">{[settings.invoiceTitle, sitesTxt, datesText(unbilled.map(e => e.work_date))].filter(Boolean).join(' ')}</div>
                  <div className="kx-table-wrap">
                    <table className="kx-wl-table">
                      <thead><tr><th>Tuote</th><th className="num">Määrä</th><th className="num">Hinta</th><th className="num">Veroton</th></tr></thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i}>
                            <td>{r.desc}</td>
                            <td className="num">{fmtNum(r.qty)} {r.unit}</td>
                            <td className="num">{fmtEur(r.price)}</td>
                            <td className="num">{fmtEur(r.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr><td colSpan={3}>Yhteensä alv 0</td><td className="num">{fmtEur(net)}</td></tr>
                        {inv.alv && <tr className="kx-wl-sub"><td colSpan={3}>Konsultoinnista ALV {fmtNum(settings.vatPct, 1)} %</td><td className="num">{fmtEur(inv.alv.vat)}</td></tr>}
                      </tfoot>
                    </table>
                  </div>
                  <details className="kx-wl-msgprev">
                    <summary>💬 Näytä viesti ryhmään</summary>
                    <pre>{groupMessageText(unbilled)}</pre>
                  </details>
                </div>
              )
            })()}
            {(() => {
              // Tämän jakson laskutetut päivät laskuittain
              const billed = list.filter(e => e.invoiced_at)
              if (!billed.length) return null
              const groups = new Map()
              for (const e of billed) {
                const k = e.invoice_id || `d-${e.invoiced_at.slice(0, 10)}`
                if (!groups.has(k)) groups.set(k, [])
                groups.get(k).push(e)
              }
              return (
                <div className="kx-wl-group">
                  <div className="kx-wl-group-title">Laskutettu</div>
                  <div className="kx-wl-matlist">
                    {[...groups.entries()].map(([k, es]) => {
                      const invc = invoices.find(x => x.id === k)
                      const sum = round2(es.reduce((a, e) => a + entryTotals(e, settings).total, 0))
                      return (
                        <div key={k} className="kx-wl-invrow">
                          <span>
                            {invc?.invoice_number ? <b>Lasku {invc.invoice_number}</b> : 'Laskutettu'}
                            {' '}{fmtDate((invc?.invoice_date || es[0].invoiced_at).slice(0, 10))} · {es.length} pv · {fmtEur(sum)}
                            {invc && invc.net !== sum && <span className="kx-wl-period"> (koko lasku {fmtEur(invc.net)})</span>}
                          </span>
                          <span className="kx-wl-invbtns">
                            <button className="kx-wl-linkbtn" style={{ marginTop: 0 }} onClick={async () => showToast(await copyText(ukkoText(es, settings)) ? '✓ UKKO-rivit kopioitu' : '⚠ Kopiointi ei onnistunut')}>📋 UKKO</button>
                            <button className="kx-wl-linkbtn" style={{ marginTop: 0 }} onClick={async () => showToast(await copyText(groupMessageText(es)) ? '✓ Viesti kopioitu' : '⚠ Kopiointi ei onnistunut')}>💬 Viesti</button>
                            <button className="kx-wl-linkbtn" style={{ marginTop: 0, color: '#475569' }} onClick={() => cancelInvoice(invc, es)}>↩ Peru</button>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}
          </div>
        )
      })}

      {/* 2) Oma matkalasku */}
      {claim.rows.length > 0 && (
        <div className="kx-card">
          <div className="kx-wl-invoice-head">
            <div>
              <div className="kx-card-title" style={{ margin: 0 }}>Oma matkalasku</div>
              <div className="kx-main-sub">Korpnex maksaa sinulle verovapaasti: {fmtNum(claim.km)} km = {fmtEur(claim.kmEur)}, päivärahat {fmtEur(claim.pdEur)}</div>
            </div>
            <div className="kx-wl-actions">
              <div className="kx-wl-big">{fmtEur(claim.total)}</div>
              <button className="kx-btn-primary kx-btn-sm" onClick={downloadUkko} disabled={exporting}>{exporting ? 'Tehdään…' : '⬇ UKKO-matkalasku'}</button>
              <button className="kx-btn-ghost kx-btn-sm" onClick={async () => showToast(await copyText(travelClaimText(claim, settings)) ? '✓ Matkalasku kopioitu' : '⚠ Kopiointi ei onnistunut')}>📋 Kopioi</button>
            </div>
          </div>
          <div className="kx-table-wrap">
            <table className="kx-wl-table kx-wl-table-wide">
              <thead><tr><th>Päivä</th><th>Kohde</th><th className="num">Km</th><th className="num">Km-korvaus</th><th>Päiväraha</th><th className="num">€</th></tr></thead>
              <tbody>
                {claim.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{fmtDate(r.date)}</td>
                    <td>{[r.site, r.client].filter(Boolean).join(' / ')}</td>
                    <td className="num">{r.km ? fmtNum(r.km) : ''}</td>
                    <td className="num">{r.kmEur ? fmtEur(r.kmEur) : ''}</td>
                    <td>{r.pdEur ? PER_DIEM_LABELS[r.perDiem] : ''}</td>
                    <td className="num">{r.pdEur ? fmtEur(r.pdEur) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="kx-hint">Päiväraha edellyttää yli 15 km matkaa kotoa ja yli 6 h (osa) tai yli 10 h (koko) kestoa. Rakennustyömailla on omat ehtonsa, tarkista UKKO:lta.</div>
        </div>
      )}

      {/* 3) Materiaalit */}
      {usage.length > 0 && (
        <div className="kx-card">
          <div className="kx-wl-invoice-head">
            <div>
              <div className="kx-card-title" style={{ margin: 0 }}>Materiaalit</div>
              <div className="kx-main-sub">Tilaajan tuotteet, kulutus työmaittain. Näkyvät laskulla tiedoksi.</div>
            </div>
            <button className="kx-btn-ghost kx-btn-sm" onClick={async () => showToast(await copyText(materialUsageText(usage)) ? '✓ Materiaalilista kopioitu' : '⚠ Kopiointi ei onnistunut')}>📋 Kopioi</button>
          </div>
          <div className="kx-table-wrap">
            <table className="kx-wl-table">
              <thead><tr><th>Työmaa</th><th>Materiaali</th><th className="num">Määrä</th></tr></thead>
              <tbody>
                {usage.map((r, i) => (
                  <tr key={i}>
                    <td>{i === 0 || usage[i - 1].site !== r.site ? r.site : ''}</td>
                    <td>{r.name}</td>
                    <td className="num">{fmtNum(r.qty)} {r.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      </>}

      {/* 4) Merkinnät */}
      {tab === 'kirjaukset' && entries.length > 0 && (
        <WorkSummary entries={entries} settings={settings} mode={mode} anchor={anchor}
          onDrill={a => { setMode(mode === 'year' ? 'month' : 'week'); setAnchor(a) }} />
      )}
      {tab === 'kirjaukset' && entries.length > 0 && (
        <div className="kx-card">
          <div className="kx-wl-invoice-head">
            <div>
              <div className="kx-card-title" style={{ margin: 0 }}>Merkinnät ({shown.length})</div>
              <div className="kx-main-sub">Napauta merkintää muokataksesi tai poistaaksesi sen.</div>
            </div>
          </div>
          <div className="kx-wl-chips" role="radiogroup" aria-label="Laskutustila">
            {[['kaikki', 'Kaikki'], ['laskuttamatta', BILLING_LABELS.laskuttamatta], ['laskutettu', BILLING_LABELS.laskutettu], ['ei', BILLING_LABELS.ei]]
              .filter(([k]) => k === 'kaikki' || counts[k] > 0 || filter === k)
              .map(([k, l]) => (
                <button key={k} role="radio" aria-checked={filter === k} className={`kx-wl-chip kx-wl-chip-${k}${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>
                  {l} <span>{counts[k]}</span>
                </button>
              ))}
          </div>
          {shown.length === 0 && <div className="kx-empty-note" style={{ padding: '14px 0 4px' }}>Ei merkintöjä tällä suodattimella.</div>}
          <div className="kx-wl-list">
            {shown.map((e, i) => {
              const t = entryTotals(e, settings)
              const st = billingState(e)
              const tv = travelByDay.get(e.work_date)
              // Väliotsikko: kuukausinäkymässä viikoittain, vuosinäkymässä kuukausittain
              const groupKey = mode === 'year' ? monthKey(e.work_date) : mode === 'month' ? periodKey('week', e.work_date) : null
              const prevKey = i > 0 ? (mode === 'year' ? monthKey(shown[i - 1].work_date) : mode === 'month' ? periodKey('week', shown[i - 1].work_date) : null) : undefined
              let head = null
              if (groupKey && groupKey !== prevKey) {
                const grp = shown.filter(x => (mode === 'year' ? monthKey(x.work_date) : periodKey('week', x.work_date)) === groupKey)
                const h = round2(grp.reduce((a, x) => a + workHours(x), 0))
                head = (
                  <div className="kx-wl-listhead">
                    <span>{mode === 'year' ? monthLabel(groupKey) : periodLabel('week', e.work_date)}</span>
                    <b>{fmtNum(h)} h</b>
                  </div>
                )
              }
              const what = e.kind === 'urakka'
                ? (e.lines || []).map(l => `${l.tyolaji} ${fmtNum(l.maara)} ${l.yksikko}`).join(', ')
                : `${fmtNum(e.hours)} h × ${fmtEur(e.hourly_rate)}`
              return (
                <React.Fragment key={e.id}>
                {head}
                <div className="kx-wl-row">
                  <button className="kx-wl-row-main" onClick={() => editDraft(e)}>
                    <div className="kx-wl-date">{new Date(e.work_date + 'T12:00:00').toLocaleDateString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric' })}</div>
                    <div className="kx-wl-row-body">
                      <div className="kx-wl-row-title">{e.client_name}{e.site ? `, ${e.site}` : ''}</div>
                      <div className="kx-wl-row-sub">
                        <span className={`kx-wl-kind kx-wl-kind-${e.kind}`}>{KIND_LABELS[e.kind]}</span>
                        {e.start_time && e.end_time && `${fmtTime(e.start_time)}–${fmtTime(e.end_time)}${e.break_minutes ? ` (−${e.break_minutes} min)` : ''} · `}
                        {what}
                        {e.materials?.length > 0 && ` · ${e.materials.map(m => `${m.nimi} ${fmtNum(m.maara)} ${m.yksikko}`).join(', ')}`}
                        {num(e.km) > 0 && ` · ${fmtNum(e.km)} km${e.km_billable ? '' : ' (ei laskuteta)'}`}
                        {e.per_diem !== 'ei' && ` · ${PER_DIEM_LABELS[e.per_diem].toLowerCase()}${e.per_diem_billable ? ' (laskutetaan)' : ''}`}
                        {tv?.travel > 0 && entries.filter(x => x.work_date === e.work_date)[0] === e && ` · matka-aika ${fmtDuration(tv.travel)}`}
                      </div>
                    </div>
                    <div className="kx-wl-row-sum">
                      <span style={st === 'ei' ? { color: '#94a3b8', textDecoration: 'line-through' } : undefined}>{fmtEur(t.total)}</span>
                      {e.kind === 'urakka' && workHours(e) > 0 && <span className="kx-wl-rowhours">{fmtNum(workHours(e))} h</span>}
                      <span className={`kx-wl-billed kx-wl-billed-${st}`}>{BILLING_LABELS[st].toLowerCase()}</span>
                    </div>
                  </button>
                  <button className="kx-btn-ghost kx-btn-sm kx-wl-edit" onClick={() => editDraft(e)} aria-label="Muokkaa">✏️<span className="kx-wl-edit-label"> Muokkaa</span></button>
                  <button className="kx-icon-btn" title="Kirjaa samanlainen päivä tänään" aria-label="Kirjaa samanlainen päivä tänään" onClick={() => setDraft(newDraft(e))}>↻</button>
                </div>
                </React.Fragment>
              )
            })}
          </div>
        </div>
      )}

      </>}

      {/* Asetukset */}
      {tab === 'asetukset' && (
      <div className="kx-card">
        <div className="kx-card-title" style={{ margin: 0 }}>Oletushinnat</div>
        {(
          <div className="kx-wl-grid" style={{ marginTop: 14 }}>
            {[
              ['hourlyRate', 'Tuntityö €/h (alv 0)'],
              ['consultRate', 'Konsultointi €/h (alv 0)'],
              ['multiplier', 'Urakan kerroin (TES-hinta ×)'],
              ['kmRate', 'Km-hinta asiakkaalle €/km'],
              ['ownKmRate', 'Oma km-korvaus €/km (verovapaa)'],
              ['pdPart', 'Osapäiväraha €'],
              ['pdFull', 'Kokopäiväraha €'],
              ['vatPct', 'ALV % (konsultointi)'],
            ].map(([k, label]) => (
              <label key={k} className="kx-wl-field">
                <span>{label}</span>
                <input className="kx-input" inputMode="decimal" defaultValue={str(settings[k])} onBlur={e => updateSetting(k, e.target.value)} />
              </label>
            ))}
            <div id="kx-wl-travelinfo" className="kx-wl-section-title" style={{ gridColumn: '1 / -1', marginTop: 8 }}>Matkalaskun tiedot (UKKO-pohja)</div>
            {[
              ['invoiceTitle', 'Laskun otsikon alku (UKKO)', 'esim. Kiireapu'],
              ['travelName', 'Nimi', 'Etunimi Sukunimi'],
              ['vehicle', 'Auton rekisterinumero', 'ABC-123'],
              ['homeAddress', 'Kotiosoite (reitin alku ja loppu)', 'Katu 1, 60100 Seinäjoki'],
            ].map(([k, label, ph]) => (
              <label key={k} className={`kx-wl-field${k === 'homeAddress' ? ' kx-wl-wide' : ''}`}>
                <span>{label}</span>
                <input className="kx-input" placeholder={ph} defaultValue={settings[k]} onBlur={e => updateTextSetting(k, e.target.value)} />
              </label>
            ))}
            <div className="kx-hint" style={{ gridColumn: '1 / -1' }}>Oletukset koskevat uusia merkintöjä. Vanhat merkinnät pitävät omat hintansa. Verovapaat korvaukset 2026: 0,55 €/km, osapäiväraha 25 €, kokopäiväraha 54 €.</div>
          </div>
        )}
      </div>
      )}

      {/* Lomake */}
      {draft && (
        <div className="kx-wl-overlay" onClick={() => !saving && setDraft(null)}>
          <div className="kx-wl-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={draft.id ? 'Muokkaa työpäivää' : 'Kirjaa työpäivä'}>
            <div className="kx-wl-modal-head">
              <div className="kx-modal-title">
                {draft._finalize
                  ? `📝 Tarkista työpäivä${draft._step ? ` (${draft._step})` : ''}`
                  : draft.status === 'kaynnissa' ? 'Korjaa käynnissä olevaa päivää' : draft.id ? 'Muokkaa työpäivää' : 'Kirjaa työpäivä'}
              </div>
              <button className="kx-icon-btn" onClick={() => setDraft(null)} aria-label="Sulje">✕</button>
            </div>
            {!draft.id && sameDay.length > 0 && (
              <div className="kx-wl-sameday">
                <div>Päivälle {fmtDate(draft.work_date)} on jo kirjattu:</div>
                {sameDay.map(e => (
                  <div key={e.id} className="kx-wl-sameday-row">
                    <span>{e.client_name}{e.site ? `, ${e.site}` : ''} · {e.kind === 'urakka' ? 'urakka' : `${fmtNum(e.hours)} h`} · {fmtEur(entryTotals(e, settings).total)}</span>
                    <button className="kx-btn-ghost kx-btn-sm" onClick={() => editDraft(e)}>✏️ Muokkaa tätä</button>
                  </div>
                ))}
              </div>
            )}
            {draft._finalize && (
              <div className="kx-wl-sameday">
                Ajat ja kilometrit tulivat päivän kirjauksesta. Tarkista ne, {draft.kind === 'urakka' ? 'lisää urakkarivit' : 'katso tunnit'} ja materiaalit ja tallenna.
                {draft._step && ' Kilometrit on jaettu työmaille, korjaa tarvittaessa.'}
              </div>
            )}
            {draft.status === 'kaynnissa' && !draft._finalize && (
              <div className="kx-wl-sameday">Päivä on vielä käynnissä. Tallennus korjaa tiedot, ja päivä jatkuu napeista.</div>
            )}
            {draft.invoiced_at && <div className="kx-wl-warn">Tämä päivä on jo merkitty laskutetuksi {fmtDate(draft.invoiced_at.slice(0, 10))}. Muutokset eivät päivity lähetettyyn laskuun.</div>}

            <div className="kx-wl-grid">
              <label className="kx-wl-field">
                <span>Päivä</span>
                <input className="kx-input" type="date" value={draft.work_date} onChange={e => setD('work_date', e.target.value)} />
              </label>
              <label className="kx-wl-field">
                <span>Työmaa</span>
                <select className="kx-input" value={draft.freeText ? '__free' : (draft.site_id ?? '')} onChange={e => pickSite(e.target.value)}>
                  {!draft.site_id && !draft.freeText && <option value="">— Valitse työmaa —</option>}
                  {clients.filter(c => !c.archived).map(c => {
                    const own = sites.filter(x => x.client_id === c.id && (!x.archived || x.id === draft.site_id))
                    return own.length ? (
                      <optgroup key={c.id} label={c.name}>
                        {own.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </optgroup>
                    ) : null
                  })}
                  <option value="__new">＋ Uusi työmaa…</option>
                  <option value="__free">Muu (kirjoita vapaasti)</option>
                </select>
              </label>
            </div>
            {draft.freeText ? (
              <div className="kx-wl-grid">
                <label className="kx-wl-field">
                  <span>Asiakas</span>
                  <input className="kx-input" list="kx-wl-clients" placeholder="esim. Zaumax Oy" value={draft.client_name} onChange={e => setD('client_name', e.target.value)} />
                  <datalist id="kx-wl-clients">{clientNames.map(c => <option key={c} value={c} />)}</datalist>
                </label>
                <label className="kx-wl-field">
                  <span>Työmaa / kohde</span>
                  <input className="kx-input" list="kx-wl-sites" placeholder="esim. Kauhajoki" value={draft.site} onChange={e => setD('site', e.target.value)} />
                  <datalist id="kx-wl-sites">{siteNames.map(x => <option key={x} value={x} />)}</datalist>
                </label>
                <label className="kx-wl-field kx-wl-wide">
                  <span>ALV-käsittely</span>
                  <select className="kx-input" value={draft.vat_mode} onChange={e => setD('vat_mode', e.target.value)}>
                    {Object.entries(VAT_MODE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
              </div>
            ) : draft.site_id && (() => {
              const site = sites.find(x => x.id === draft.site_id)
              const cl = site && clientById(site.client_id)
              const info = clientInfoLines(cl)
              return (
                <div className="kx-wl-clientinfo">
                  <div><b>{cl?.name || draft.client_name}</b>{site?.address ? ` · ${site.address}` : ''}</div>
                  <div className="kx-wl-period">
                    {info.length ? info.join(' · ') : 'Y-tunnus ja laskutusosoite puuttuvat'}
                    {' · '}{draft.vat_mode === 'alv' ? 'ALV 25,5 %' : 'käännetty ALV'}
                  </div>
                </div>
              )
            })()}

            <div className="kx-wl-seg" role="radiogroup" aria-label="Työn tyyppi">
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <button key={k} role="radio" aria-checked={draft.kind === k} className={draft.kind === k ? 'active' : ''} onClick={() => setKind(k)}>{label}</button>
              ))}
            </div>

            <div className="kx-wl-section-title">Työaika</div>
            <div className="kx-wl-timerow">
              <label className="kx-wl-field">
                <span>Alkoi</span>
                <input className="kx-input" type="time" step="300" value={draft.start_time} onChange={e => setTime('start_time', e.target.value)} />
              </label>
              <label className="kx-wl-field">
                <span>Loppui</span>
                <input className="kx-input" type="time" step="300" value={draft.end_time} onChange={e => setTime('end_time', e.target.value)} />
              </label>
              <button type="button" className={`kx-wl-break${draft.break_minutes ? ' on' : ''}`} aria-pressed={!!draft.break_minutes} onClick={toggleBreak}>
                {draft.break_minutes ? `✓ Ruokatauko −${draft.break_minutes} min` : `＋ Ruokatauko ${BREAK_MIN} min`}
              </button>
            </div>
            {(() => {
              const c = calcHours(draft.start_time, draft.end_time, draft.break_minutes)
              if (!c) return draft.start_time || draft.end_time ? <div className="kx-wl-period">Valitse sekä alkamis- että loppumisaika.</div> : null
              return (
                <div className="kx-wl-calc">
                  {fmtTime(draft.start_time)}–{fmtTime(draft.end_time)}{draft.break_minutes ? ` − ${draft.break_minutes} min` : ''} = <b>{fmtNum(c.hours)} h</b>
                  {c.raw !== c.rounded && <span> (todellinen {fmtDuration(c.raw)}, pyöristetty 15 min)</span>}
                  {draft.kind === 'urakka' && <span> · urakassa tunnit vain tiedoksi</span>}
                </div>
              )
            })()}

            {draft.kind !== 'urakka' ? (
              <div className="kx-wl-grid">
                <label className="kx-wl-field">
                  <span>Tunnit</span>
                  <input className="kx-input" inputMode="decimal" value={draft.hours} onChange={e => setD('hours', e.target.value)} />
                </label>
                <label className="kx-wl-field">
                  <span>Tuntihinta € (alv 0)</span>
                  <input className="kx-input" inputMode="decimal" value={draft.hourly_rate} onChange={e => setD('hourly_rate', e.target.value)} />
                </label>
              </div>
            ) : (
              <div className="kx-wl-lines">
                <datalist id="kx-wl-tyolajit">{TYOLAJIT.map(t => <option key={t} value={t} />)}</datalist>
                <datalist id="kx-wl-tuntilajit">{TUNTILAJIT.map(t => <option key={t} value={t} />)}</datalist>
                <datalist id="kx-wl-kohdat">{[...new Set(draft.lines.map(l => (l.kohta || '').trim()).filter(Boolean))].map(t => <option key={t} value={t} />)}</datalist>
                <div className="kx-wl-line kx-wl-line-head" aria-hidden="true">
                  <span className="kx-wl-line-name">Nimike</span><span>Määrä</span><span>Yks.</span><span>TES €/yks.</span><span>Laskutus</span>
                </div>
                {draft.lines.map((l, i) => {
                  if (l.hourly) return null
                  const p = unitPrice(l, draft.multiplier)
                  const known = findNimike(l.tyolaji)
                  const custom = l._custom || (!known && !!l.tyolaji)
                  return (
                    <div key={i} className="kx-wl-line">
                      <div className="kx-wl-line-name kx-wl-line-pick">
                        <select className="kx-input kx-input-sm" aria-label="Nimike" value={custom ? '__custom' : (known ? known.label : '')} onChange={e => pickNimike(i, e.target.value)}>
                          <option value="">— Valitse nimike —</option>
                          {TES_NIMIKKEET.map(([g, items]) => (
                            <optgroup key={g} label={g}>
                              {items.map(([name, unit, tes]) => <option key={name} value={name}>{name} · {fmtEur(tes)}/{unit}</option>)}
                            </optgroup>
                          ))}
                          <option value="__custom">✏️ Muu työlaji (kirjoita)</option>
                        </select>
                        {custom && <input className="kx-input kx-input-sm" list="kx-wl-tyolajit" placeholder="Työlaji" value={l.tyolaji} autoFocus={l._custom && !l.tyolaji} onChange={e => setLine(i, 'tyolaji', e.target.value)} />}
                        <input className="kx-input kx-input-sm kx-wl-kohta" list="kx-wl-kohdat" placeholder="Kohta / osasto (vapaaehtoinen)" aria-label="Kohta" value={l.kohta || ''} onChange={e => setLine(i, 'kohta', e.target.value)} />
                      </div>
                      <input className="kx-input kx-input-sm" inputMode="decimal" placeholder="Määrä" aria-label="Määrä" value={l.maara} onChange={e => setLine(i, 'maara', e.target.value)} />
                      <select className="kx-input kx-input-sm" aria-label="Yksikkö" value={l.yksikko} onChange={e => setLine(i, 'yksikko', e.target.value)}>
                        {(UNITS.includes(l.yksikko) ? UNITS : [l.yksikko, ...UNITS]).map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                      <input className="kx-input kx-input-sm" inputMode="decimal" placeholder="TES €" aria-label="TES-hinta €/yksikkö" value={l.tes} onChange={e => setLine(i, 'tes', e.target.value)} />
                      <div className="kx-wl-line-calc">{p ? `${fmtEur(p)}/${l.yksikko} · ${fmtEur(round2(num(l.maara) * p))}` : '–'}</div>
                      {draft.lines.filter(x => !x.hourly).length > 1 && <button className="kx-icon-btn" aria-label="Poista rivi" onClick={() => setD('lines', draft.lines.filter((_, j) => j !== i))}>✕</button>}
                    </div>
                  )
                })}
                <div className="kx-wl-lines-foot">
                  <button className="kx-btn-ghost kx-btn-sm" onClick={() => setD('lines', [...draft.lines, { ...emptyLine(), kohta: [...draft.lines].reverse().find(l => !l.hourly)?.kohta || '' }])}>＋ Rivi</button>
                  <label className="kx-wl-inline">
                    Kerroin
                    <input className="kx-input kx-input-sm" style={{ width: 70 }} inputMode="decimal" value={draft.multiplier} onChange={e => setD('multiplier', e.target.value)} />
                  </label>
                </div>
                <div className="kx-hint">TES-hinta laskimesta (teslaskin.mittaviiva.fi) × kerroin = laskutushinta.</div>

                <div className="kx-wl-section-title" style={{ marginTop: 6 }}>Tuntityö urakan lisäksi</div>
                {draft.lines.some(l => l.hourly) && (
                  <div className="kx-wl-line kx-wl-hourline kx-wl-line-head" aria-hidden="true">
                    <span className="kx-wl-line-name">Mitä tehtiin</span><span>Tunnit</span><span>€/h</span><span>Laskutus</span>
                  </div>
                )}
                {draft.lines.map((l, i) => {
                  if (!l.hourly) return null
                  const p = unitPrice(l, draft.multiplier)
                  return (
                    <div key={i} className="kx-wl-line kx-wl-hourline">
                      <input className="kx-input kx-input-sm kx-wl-line-name" list="kx-wl-tuntilajit" placeholder="esim. Siivous" value={l.tyolaji} onChange={e => setLine(i, 'tyolaji', e.target.value)} />
                      <input className="kx-input kx-input-sm" inputMode="decimal" placeholder="h" aria-label="Tunnit" value={l.maara} onChange={e => setLine(i, 'maara', e.target.value)} />
                      <input className="kx-input kx-input-sm" inputMode="decimal" placeholder="€/h" aria-label="Tuntihinta" value={l.tes} onChange={e => setLine(i, 'tes', e.target.value)} />
                      <div className="kx-wl-line-calc">{p && num(l.maara) ? `${fmtNum(num(l.maara))} h × ${fmtEur(p)} = ${fmtEur(round2(num(l.maara) * p))}` : 'tunnit × €/h'}</div>
                      <button className="kx-icon-btn" aria-label="Poista tuntirivi" onClick={() => setD('lines', draft.lines.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  )
                })}
                <div className="kx-wl-lines-foot">
                  <button className="kx-btn-ghost kx-btn-sm" onClick={() => setD('lines', [...draft.lines, emptyHourLine()])}>＋ Tunteja (esim. siivous)</button>
                </div>
                {draft.lines.some(l => l.hourly) && <div className="kx-hint">Tuntirivit laskutetaan tuntihinnalla ilman urakan kerrointa, samalla laskulla urakan kanssa.</div>}
              </div>
            )}

            <div className="kx-wl-section-title">Materiaalit</div>
            <div className="kx-wl-lines">
              <datalist id="kx-wl-materiaalit">{[...new Set([...MATERIAALIT, ...materialNames])].map(t => <option key={t} value={t} />)}</datalist>
              {draft.materials.length > 0 && (
                <div className="kx-wl-line kx-wl-mat kx-wl-line-head" aria-hidden="true">
                  <span className="kx-wl-line-name">Materiaali</span><span>Määrä</span><span>Yks.</span>
                </div>
              )}
              {draft.materials.map((m, i) => {
                return (
                  <div key={i} className="kx-wl-line kx-wl-mat">
                    <input className="kx-input kx-input-sm kx-wl-line-name" list="kx-wl-materiaalit" placeholder="Materiaali" value={m.nimi} onChange={e => setMat(i, 'nimi', e.target.value)} />
                    <input className="kx-input kx-input-sm" inputMode="decimal" placeholder="Määrä" aria-label="Määrä" value={m.maara} onChange={e => setMat(i, 'maara', e.target.value)} />
                    <select className="kx-input kx-input-sm" aria-label="Yksikkö" value={m.yksikko} onChange={e => setMat(i, 'yksikko', e.target.value)}>
                      {/* Vanhoilla riveillä voi olla yksikkö, jota listassa ei enää ole (esim. "putki" tai "paketti") */}
                      {(MATERIAL_UNITS.includes(m.yksikko) ? MATERIAL_UNITS : [m.yksikko, ...MATERIAL_UNITS]).map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <button className="kx-icon-btn" aria-label="Poista materiaali" onClick={() => setD('materials', draft.materials.filter((_, j) => j !== i))}>✕</button>
                  </div>
                )
              })}
              <div className="kx-wl-lines-foot">
                <button className="kx-btn-ghost kx-btn-sm" onClick={() => setD('materials', [...draft.materials, emptyMaterial()])}>＋ Materiaali</button>
              </div>
              {draft.materials.length > 0 && <div className="kx-hint">Tilaajan omat tuotteet. Kulutus näkyy laskulla tiedoksi, mutta niitä ei laskuteta.</div>}
            </div>

            <div className="kx-wl-section-title">Matkat</div>
            <div className="kx-wl-grid">
              <label className="kx-wl-field">
                <span>Km omalla autolla (meno-paluu, 0 = toisen kyyti)</span>
                <input className="kx-input" inputMode="decimal" placeholder="0" value={draft.km} onChange={e => setD('km', e.target.value)} />
              </label>
              <label className="kx-wl-field">
                <span>Km-hinta asiakkaalle €</span>
                <input className="kx-input" inputMode="decimal" value={draft.km_rate} disabled={!draft.km_billable} onChange={e => setD('km_rate', e.target.value)} />
              </label>
              <label className="kx-checkbox-row kx-wl-wide" style={{ margin: 0 }}>
                <input type="checkbox" checked={draft.km_billable} onChange={e => setD('km_billable', e.target.checked)} />
                Laskuta kilometrit asiakkaalta
              </label>
              {/* Matka-aikaa ei laskuteta; kentät näkyvät vain vanhoissa merkinnöissä, joissa niitä on käytetty */}
              {(num(draft.travel_hours) > 0 || num(draft.travel_rate) > 0) && <>
                <label className="kx-wl-field">
                  <span>Matka-aika h</span>
                  <input className="kx-input" inputMode="decimal" placeholder="0" value={draft.travel_hours} onChange={e => setD('travel_hours', e.target.value)} />
                </label>
                <label className="kx-wl-field">
                  <span>Matka-ajan hinta €/h (0 = ei laskuteta)</span>
                  <input className="kx-input" inputMode="decimal" value={draft.travel_rate} onChange={e => setD('travel_rate', e.target.value)} />
                </label>
              </>}
              <label className="kx-wl-field">
                <span>Lähdin kotoa</span>
                <input className="kx-input" type="time" step="300" value={draft.depart_time} onChange={e => setTime('depart_time', e.target.value)} />
              </label>
              <label className="kx-wl-field">
                <span>Palasin kotiin</span>
                <input className="kx-input" type="time" step="300" value={draft.return_time} onChange={e => setTime('return_time', e.target.value)} />
              </label>
              {(() => {
                const sug = suggestPerDiem(draft.depart_time, draft.return_time, tripDistance(draft))
                return sug ? (
                  <div className="kx-wl-calc kx-wl-wide">
                    Matka {fmtDuration(sug.dur)} → <b>{PER_DIEM_LABELS[sug.value].toLowerCase()}</b> ({sug.reason})
                    {!num(draft.km) && tripDistance(draft) > 0 && <span> · toisen kyydillä, etäisyys työmaan tiedoista ({fmtNum(tripDistance(draft))} km meno-paluu)</span>}
                    {sug.value !== draft.per_diem && <span> · valittu käsin: {PER_DIEM_LABELS[draft.per_diem].toLowerCase()}</span>}
                  </div>
                ) : null
              })()}
              <label className="kx-wl-field kx-wl-wide">
                <span>Päiväraha (oma matkalasku)</span>
                <select className="kx-input" value={draft.per_diem} onChange={e => setD('per_diem', e.target.value)}>
                  <option value="ei">Ei päivärahaa</option>
                  <option value="osa">Osapäiväraha, yli 6 h ({fmtEur(settings.pdPart)})</option>
                  <option value="koko">Kokopäiväraha, yli 10 h ({fmtEur(settings.pdFull)})</option>
                </select>
              </label>
              {draft.per_diem !== 'ei' && (
                <label className="kx-checkbox-row kx-wl-wide" style={{ margin: 0 }}>
                  <input type="checkbox" checked={!!draft.per_diem_billable} onChange={e => setD('per_diem_billable', e.target.checked)} />
                  Laskuta päiväraha asiakkaalta (vain jos sovittu)
                </label>
              )}
              <label className="kx-wl-field kx-wl-wide">
                <span>Lisätieto</span>
                <input className="kx-input" placeholder="esim. B-rappu, ikkunat 3. krs" value={draft.notes} onChange={e => setD('notes', e.target.value)} />
              </label>
              {(() => {
                const t = dayTravel([draftToRow(draft)]).get(draft.work_date)
                return t && t.travel > 0 ? <div className="kx-wl-calc kx-wl-wide">Matka-aika {fmtDuration(t.travel)} <span>(tiedoksi, ei laskuteta)</span></div> : null
              })()}
            </div>

            {draft.status !== 'kaynnissa' && <>
              <div className="kx-wl-section-title">Laskutus</div>
              <div className="kx-wl-seg" role="radiogroup" aria-label="Laskutustila">
                {['laskuttamatta', 'laskutettu', 'ei'].map(k => (
                  <button key={k} role="radio" aria-checked={billingState(draft) === k} className={billingState(draft) === k ? 'active' : ''}
                    onClick={() => setDraft(d => ({
                      ...d,
                      billing: k === 'ei' ? 'ei' : 'laskutettava',
                      invoiced_at: k === 'laskutettu' ? (d.invoiced_at || new Date().toISOString()) : null,
                      ...(k !== 'laskutettu' && 'invoice_id' in d ? { invoice_id: null } : {}),
                    }))}>{BILLING_LABELS[k]}</button>
                ))}
              </div>
              {billingState(draft) === 'ei' && <div className="kx-hint" style={{ marginTop: -6 }}>Ei näy laskuriveillä eikä laskutettavissa summissa. Tunnit, km:t ja päivärahat lasketaan silti.</div>}
            </>}

            <div className="kx-wl-preview">
              <div>
                <div className="kx-wl-preview-label">Asiakkaalle alv 0</div>
                <div className="kx-wl-preview-sum">{fmtEur(preview.total)}</div>
                <div className="kx-wl-period">työ {fmtEur(preview.work)}{preview.travel ? ` + matkat ${fmtEur(round2(preview.travel - preview.perDiemBill))}` : ''}{preview.perDiemBill ? ` + päiväraha ${fmtEur(preview.perDiemBill)}` : ''}</div>
              </div>
              {(preview.ownKm > 0 || preview.perDiem > 0) && (
                <div style={{ textAlign: 'right' }}>
                  <div className="kx-wl-preview-label">Sinulle verovapaasti</div>
                  <div className="kx-wl-preview-sum kx-wl-own">{fmtEur(round2(preview.ownKm + preview.perDiem))}</div>
                </div>
              )}
            </div>

            <div className="kx-modal-actions">
              {draft.id && <button className="kx-btn-ghost" style={{ marginRight: 'auto', color: '#b91c1c' }} onClick={() => archive(draft)}>🗑 Poista</button>}
              <button className="kx-btn-ghost" disabled={saving} onClick={() => setDraft(null)}>Peruuta</button>
              <button className="kx-btn-primary" disabled={saving} onClick={save}>
                {saving ? 'Tallennetaan…' : draft._finalize ? (liveIds.filter(id => id !== draft.id).length ? 'Tallenna ja seuraava' : '✓ Tallenna päivä') : draft.id ? 'Tallenna muutokset' : 'Kirjaa työpäivä'}
              </button>
            </div>
          </div>
        </div>
      )}
      {dayStart && (
        <DayStartModal
          sites={sites} clients={clients} settings={settings} lastOdo={lastOdo} lastSiteId={recent[0]?.site_id}
          makeEntryRow={makeEntryRow} showToast={showToast}
          onClose={() => setDayStart(false)}
          onStarted={() => { setDayStart(false); load() }}
        />
      )}
      {invoiceModal && (
        <div className="kx-wl-overlay" onClick={() => setInvoiceModal(null)}>
          <div className="kx-wl-modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()} role="dialog" aria-label="Merkitse laskutetuksi">
            <div className="kx-wl-modal-head">
              <div className="kx-modal-title">✓ Merkitse laskutetuksi</div>
              <button className="kx-icon-btn" onClick={() => setInvoiceModal(null)} aria-label="Sulje">✕</button>
            </div>
            <div className="kx-wl-clientinfo">
              <div><b>{invoiceModal.client}</b></div>
              <div className="kx-wl-period">{invoiceModal.list.length} päivää · {fmtEur(round2(invoiceModal.list.reduce((a, e) => a + entryTotals(e, settings).total, 0)))} alv 0</div>
            </div>
            <div className="kx-wl-grid">
              <label className="kx-wl-field"><span>Laskun numero (vapaaehtoinen)</span>
                <input className="kx-input" placeholder="esim. UKKO:n laskunro" value={invoiceModal.number} autoFocus
                  onChange={e => setInvoiceModal(x => ({ ...x, number: e.target.value }))} /></label>
              <label className="kx-wl-field"><span>Laskun päivä</span>
                <input className="kx-input" type="date" value={invoiceModal.date} onChange={e => setInvoiceModal(x => ({ ...x, date: e.target.value }))} /></label>
            </div>
            <div className="kx-modal-actions">
              <button className="kx-btn-ghost" onClick={() => setInvoiceModal(null)}>Peruuta</button>
              <button className="kx-btn-primary" disabled={!invoiceModal.date} onClick={async () => { if (await markInvoiced(invoiceModal)) setInvoiceModal(null) }}>✓ Merkitse laskutetuksi</button>
            </div>
          </div>
        </div>
      )}
      {tripModal && (
        <TripModal
          mode={tripModal.mode} trip={tripModal.trip} sites={sites} clients={clients} settings={settings}
          lastOdo={lastOdo} showToast={showToast}
          onClose={() => setTripModal(null)}
          onSaved={() => { setTripModal(null); load() }}
        />
      )}

      {/* Rekisterilomakkeet (pinoutuvat työpäivälomakkeen päälle) */}
      {siteEdit && (
        <SiteModal
          site={siteEdit.id ? siteEdit : null}
          defaultClientId={siteEdit.client_id}
          clients={clients.filter(c => !c.archived)}
          showToast={showToast}
          onNewClient={() => setClientEdit({ _forSite: true })}
          onClose={() => { setSiteEdit(null); siteForDraftRef.current = false }}
          onSaved={async saved => {
            const reg = await reloadRegistry()
            setSiteEdit(null)
            if (saved && siteForDraftRef.current) {
              const site = reg.sites.find(x => x.id === saved.id)
              if (site) setDraft(d => d && applySite(d, site, reg))
            }
            siteForDraftRef.current = false
          }}
        />
      )}
      {clientEdit && (
        <ClientModal
          client={clientEdit.id ? clientEdit : null}
          settings={settings}
          showToast={showToast}
          onClose={() => setClientEdit(null)}
          onSaved={async saved => {
            await reloadRegistry()
            const forSite = clientEdit._forSite
            setClientEdit(null)
            if (saved && forSite) setSiteEdit(x => ({ ...(x || {}), client_id: saved.id }))
          }}
        />
      )}

    </div>
  )
}

export const WORKLOG_CSS = DAYFLOW_CSS + SUMMARY_CSS + `
.kx-wl-periodseg { flex: 0 0 auto; min-width: 250px; }
.kx-wl-periodseg button { padding: 7px 10px; }
.kx-wl-periodnav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kx-wl-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.kx-wl-chip { border: 1.5px solid #e3e8ef; background: #fff; color: #334155; border-radius: 999px; padding: 5px 12px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
.kx-wl-chip span { color: #94a3b8; font-weight: 700; margin-left: 3px; }
.kx-wl-chip.active { border-color: #0878E8; background: #eef5ff; color: #0a3d7a; }
.kx-wl-chip:focus-visible { outline: 2px solid #0878E8; outline-offset: 2px; }
.kx-wl-listhead { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; font-weight: 700; color: #475569; background: #f4f6fa; border-radius: 8px; padding: 6px 10px; margin-top: 8px; }
.kx-wl-billed-laskuttamatta { color: #b45309 !important; }
.kx-wl-billed-ei { color: #94a3b8 !important; }
.kx-wl-rowhours { display: block; font-size: 11px; font-weight: 600; color: #64748b; }
.kx-wl-invrow { align-items: center; flex-wrap: wrap; }
.kx-wl-invbtns { display: inline-flex; gap: 12px; }
.kx-wl-invbtns .kx-wl-linkbtn { color: #0878E8; }
.kx-wl-msgprev { margin-top: 10px; font-size: 13px; }
.kx-wl-msgprev summary { cursor: pointer; color: #0878E8; font-weight: 600; }
.kx-wl-msgprev pre { white-space: pre-wrap; font-family: inherit; background: #f4f6fa; border-radius: 10px; padding: 10px 12px; margin: 8px 0 0; color: #0f172a; }
.kx-wl-older .kx-btn-ghost { background: #fff; }
@media (max-width: 640px) {
  .kx-wl-periodseg { width: 100%; min-width: 0; }
  .kx-wl-periodnav { width: 100%; }
}

.kx-wl { display: flex; flex-direction: column; gap: 16px; max-width: 980px; }
.kx-wl .kx-main-head { margin-bottom: 0; }
.kx-wl-back { align-self: flex-start; background: #0a1428; color: #fff; border: none; border-radius: 10px; padding: 10px 16px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; }
.kx-wl-back:hover { background: #17275c; }
.kx-wl-back:focus-visible { outline: 2px solid #0878E8; outline-offset: 2px; }
.kx-wl-monthbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kx-wl-month { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 17px; font-weight: 800; color: #0a1428; min-width: 150px; text-align: center; }
.kx-wl-monthstats { margin-left: auto; display: flex; gap: 12px; align-items: baseline; font-size: 13.5px; color: #475569; flex-wrap: wrap; }
.kx-wl-monthstats b { color: #0a1428; font-size: 15px; }
.kx-wl-due { color: #b45309; font-weight: 600; }
.kx-wl-invoice-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.kx-wl-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kx-wl-big { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 20px; font-weight: 800; color: #047857; }
.kx-wl-group + .kx-wl-group { margin-top: 18px; padding-top: 14px; border-top: 1px dashed #e3e8ef; }
.kx-wl-group-title { font-size: 12.5px; font-weight: 700; color: #334155; margin-bottom: 6px; }
.kx-wl-table { width: 100%; border-collapse: collapse; font-size: 13.5px; font-variant-numeric: tabular-nums; }
.kx-wl-table th { text-align: left; font-size: 11.5px; font-weight: 600; color: #64748b; padding: 6px 8px; border-bottom: 1px solid #e3e8ef; white-space: nowrap; }
.kx-wl-table td { padding: 8px; border-bottom: 1px solid #f1f4f9; vertical-align: top; color: #0f172a; }
.kx-wl-table .num { text-align: right; white-space: nowrap; }
.kx-wl-table tfoot td { font-weight: 700; border-bottom: none; padding-top: 10px; }
.kx-wl-table tfoot .kx-wl-sub td { font-weight: 500; color: #64748b; padding-top: 2px; }
.kx-wl-tabbar { display: flex; gap: 4px; border-bottom: 1px solid #e3e8ef; overflow-x: auto; scrollbar-width: none; margin-top: -4px; }
.kx-wl-tabbar::-webkit-scrollbar { display: none; }
.kx-wl-tabbar button { display: inline-flex; align-items: center; gap: 7px; background: none; border: none; border-bottom: 2.5px solid transparent; padding: 10px 14px 11px; font-size: 14px; font-weight: 700; color: #64748b; cursor: pointer; font-family: inherit; white-space: nowrap; margin-bottom: -1px; }
.kx-wl-tabbar button:hover:not(.active) { color: #0a1428; }
.kx-wl-tabshort { display: none; }
.kx-wl-headbtns { display: flex; gap: 8px; flex-wrap: wrap; }
.kx-wl-tripbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; background: #ecfdf5; border: 1.5px solid #6ee7b7; color: #065f46; border-radius: 14px; padding: 12px 16px; font-size: 13.5px; }
.kx-wl-tripbar b { font-size: 14.5px; }
.kx-wl-private { font-size: 12px; color: #94a3b8; font-style: italic; text-align: center; padding: 5px 0; border-bottom: 1px solid #f1f4f9; background: repeating-linear-gradient(135deg, transparent 0 6px, #f8fafc 6px 12px); }
.kx-wl-odo { font-size: 18px !important; font-variant-numeric: tabular-nums; letter-spacing: .5px; }
.kx-wl-tabbar button.active { color: #0878E8; border-bottom-color: #0878E8; }
.kx-wl-tabbar button:focus-visible { outline: 2px solid #0878E8; outline-offset: -2px; border-radius: 6px; }
.kx-wl-reports { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; background: linear-gradient(135deg, #eef5ff, #fff); border-color: #cfe3fb; }
.kx-wl-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.kx-wl-stats > * { background: #fff; border: 1px solid #e3e8ef; border-radius: 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; text-align: left; font-family: inherit; }
.kx-wl-stats b { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 18px; font-weight: 800; color: #0a1428; font-variant-numeric: tabular-nums; }
.kx-wl-stats span { font-size: 12px; color: #64748b; font-weight: 600; }
.kx-wl-stats button { cursor: pointer; border-color: #fde68a; background: #fffbeb; }
.kx-wl-stats button b { color: #b45309; }
.kx-wl-stats button:focus-visible { outline: 2px solid #0878E8; outline-offset: 2px; }
/* iOS Safari: time-kentällä on oma minimileveys ja keskitetty teksti, joka työntää kentän yli reunan */
.kx-wl-modal input[type="time"] { -webkit-appearance: none; appearance: none; display: block; width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; text-align: left; }
.kx-wl-modal input[type="time"]::-webkit-date-and-time-value { text-align: left; }
.kx-wl-timerow { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px 12px; align-items: end; }
.kx-wl-break { height: 42px; padding: 0 14px; border-radius: 10px; border: 1.5px dashed #94a3b8; background: #fff; color: #334155; font-size: 13.5px; font-weight: 700; cursor: pointer; font-family: inherit; white-space: nowrap; }
.kx-wl-break.on { border: 1.5px solid #047857; background: #ecfdf5; color: #047857; }
.kx-wl-break:focus-visible, .kx-wl-linkbtn:focus-visible { outline: 2px solid #0878E8; outline-offset: 2px; }
.kx-wl-calc { font-size: 13px; color: #334155; background: #f4f6fa; border-radius: 10px; padding: 8px 12px; font-variant-numeric: tabular-nums; }
.kx-wl-calc b { color: #0a1428; font-size: 14.5px; }
.kx-wl-calc span { color: #64748b; }
.kx-wl-clientinfo { background: #eef5ff; border: 1px solid #cfe3fb; border-radius: 10px; padding: 9px 12px; font-size: 13.5px; color: #0a3d7a; }
.kx-wl-linkbtn { background: none; border: none; padding: 0; margin-top: 4px; color: #b45309; font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; text-align: left; }
.kx-wl-inline-row { display: flex; gap: 8px; align-items: center; }
.kx-wl-inline-row > select { flex: 1; min-width: 0; }
.kx-wl-matlist { display: flex; flex-direction: column; font-size: 13.5px; }
.kx-wl-matlist > div { display: flex; justify-content: space-between; gap: 12px; padding: 6px 8px; border-bottom: 1px solid #f1f4f9; }
.kx-wl-matlist b { font-variant-numeric: tabular-nums; white-space: nowrap; }
.kx-wl-period { font-size: 11.5px; color: #94a3b8; margin-top: 1px; }
.kx-wl .kx-hint { font-size: 12px; color: #64748b; margin-top: 8px; line-height: 1.5; }
.kx-wl-list { display: flex; flex-direction: column; }
.kx-wl-row { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid #f1f4f9; }
.kx-wl-row:last-child { border-bottom: none; }
.kx-wl-row-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 10px 6px; background: none; border: none; text-align: left; cursor: pointer; font-family: inherit; border-radius: 10px; }
.kx-wl-row-main:hover { background: #f8fafc; }
.kx-wl-row-main:focus-visible, .kx-wl-seg button:focus-visible, .kx-wl-settings-toggle:focus-visible { outline: 2px solid #0878E8; outline-offset: 2px; }
.kx-wl-date { flex: 0 0 64px; font-size: 13px; font-weight: 700; color: #0a1428; text-transform: capitalize; }
.kx-wl-row-body { flex: 1; min-width: 0; }
.kx-wl-row-title { font-size: 14px; font-weight: 600; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-wl-row-sub { font-size: 12.5px; color: #64748b; margin-top: 2px; }
.kx-wl-kind { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 6px; margin-right: 6px; background: #eef5ff; color: #0a3d7a; }
.kx-wl-kind-urakka { background: #fff4e0; color: #8a4b00; }
.kx-wl-kind-konsultointi { background: #ecfdf5; color: #065f46; }
.kx-wl-row-sum { flex-shrink: 0; text-align: right; font-size: 14px; font-weight: 700; color: #0a1428; font-variant-numeric: tabular-nums; }
.kx-wl-billed { display: block; font-size: 11px; font-weight: 600; color: #059669; }
.kx-wl-settings-toggle { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 10px; background: none; border: none; padding: 0; cursor: pointer; font-family: inherit; flex-wrap: wrap; text-align: left; }
.kx-wl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
.kx-wl-wide { grid-column: 1 / -1; }
.kx-wl-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.kx-wl-field > span { font-size: 12px; font-weight: 600; color: #475569; }
.kx-wl-overlay { position: fixed; inset: 0; background: rgba(10,20,40,.55); backdrop-filter: blur(4px); z-index: 100; display: flex; align-items: flex-start; justify-content: center; padding: 24px 16px; overflow-y: auto; }
.kx-wl-modal { background: #fff; border-radius: 18px; padding: 22px; width: 100%; max-width: 620px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 30px 80px rgba(0,0,0,.35); margin: auto 0; }
.kx-wl-modal-head { display: flex; justify-content: space-between; align-items: center; }
.kx-wl-sameday { background: #eef5ff; border: 1px solid #cfe3fb; color: #0a3d7a; border-radius: 10px; padding: 10px 12px; font-size: 13px; display: flex; flex-direction: column; gap: 6px; }
.kx-wl-sameday-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; }
.kx-wl-warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 10px; padding: 9px 12px; font-size: 13px; }
.kx-wl-seg { display: flex; background: #f1f4f9; border-radius: 11px; padding: 3px; gap: 2px; }
.kx-wl-seg button { flex: 1; background: none; border: none; padding: 9px 6px; border-radius: 8px; font-size: 13.5px; font-weight: 600; color: #64748b; cursor: pointer; font-family: inherit; }
.kx-wl-seg button.active { background: #fff; color: #0a1428; box-shadow: 0 1px 3px rgba(15,23,42,.15); }
.kx-wl-section-title { font-size: 13px; font-weight: 700; color: #0a1428; margin-bottom: -4px; }
.kx-wl-lines { display: flex; flex-direction: column; gap: 8px; }
.kx-wl-line { display: grid; grid-template-columns: minmax(0, 2fr) 76px 64px 76px minmax(0, 1.4fr) 28px; gap: 6px; align-items: center; }
.kx-wl-line.kx-wl-mat { grid-template-columns: minmax(0, 1fr) 90px 110px 28px; }
.kx-wl-line.kx-wl-hourline { grid-template-columns: minmax(0, 2fr) 76px 76px minmax(0, 1fr) 28px; }
.kx-wl-line-pick { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.kx-wl-line-pick select { min-width: 0; width: 100%; }
.kx-wl-kohta { font-size: 12.5px; color: #475569; }
.kx-wl-line.kx-wl-mat > .kx-icon-btn { grid-row: auto; grid-column: auto; }
.kx-wl-line-head { font-size: 11.5px; font-weight: 600; color: #64748b; margin-bottom: -4px; }
.kx-wl-line-head > span:last-child { grid-column: span 2; }
.kx-wl-line-calc { font-size: 12px; color: #475569; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kx-wl-lines-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.kx-wl-inline { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: #475569; }
.kx-wl-preview { display: flex; justify-content: space-between; gap: 12px; background: #f4f6fa; border-radius: 12px; padding: 12px 14px; }
.kx-wl-preview-label { font-size: 11.5px; font-weight: 600; color: #64748b; }
.kx-wl-preview-sum { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 22px; font-weight: 800; color: #0a1428; font-variant-numeric: tabular-nums; }
.kx-wl-own { color: #047857; }
@media (max-width: 640px) {
  .kx-wl-grid { grid-template-columns: 1fr; }
  .kx-wl-monthstats { margin-left: 0; width: 100%; }
  .kx-wl-month { min-width: 0; flex: 1; }
  .kx-wl-line { grid-template-columns: 1fr 1fr 1fr 28px; }
  .kx-wl-line.kx-wl-mat { grid-template-columns: 1fr 1fr 28px; }
  .kx-wl-line.kx-wl-hourline { grid-template-columns: 1fr 1fr 1fr 28px; }
  .kx-wl-hourline .kx-wl-line-calc { grid-column: auto; margin-top: 0; }
  .kx-wl-line.kx-wl-hourline > .kx-icon-btn { grid-row: 2; grid-column: 4; }
  .kx-wl-line + .kx-wl-line { margin-top: 6px; }
  .kx-wl-line.kx-wl-mat .kx-wl-line-name { grid-column: 1 / -1; }
  .kx-wl-line.kx-wl-mat + .kx-wl-line.kx-wl-mat { margin-top: 6px; }
  .kx-wl-line-name { grid-column: 1 / -1; }
  .kx-wl-line-calc { grid-column: 1 / -1; margin-top: -2px; }
  .kx-wl-line > .kx-icon-btn { grid-row: 2; grid-column: 4; }
  .kx-wl-overlay { padding: 0; }
  .kx-wl-modal { border-radius: 0; min-height: 100%; padding: max(env(safe-area-inset-top), 16px) 16px 24px; }
  .kx-wl-date { flex-basis: 44px; font-size: 12px; }
  .kx-wl-row { gap: 2px; }
  .kx-wl-row-main { gap: 8px; padding: 10px 2px; }
  .kx-wl-edit { padding: 6px 8px; }
  .kx-wl-edit-label { display: none; }
  .kx-wl-line-head { display: none; }
  .kx-wl-timerow { grid-template-columns: 1fr 1fr; }
  .kx-wl-break { grid-column: 1 / -1; }
  .kx-wl-stats { grid-template-columns: 1fr 1fr; }
  .kx-wl-headbtns { width: 100%; }
  .kx-wl-headbtns > button { flex: 1; }
  .kx-wl-tripbar > button { width: 100%; }
  .kx-wl-tabbar { gap: 0; }
  .kx-wl-tabbar button { flex: 1; flex-direction: column; gap: 2px; padding: 8px 2px 9px; font-size: 12px; }
  .kx-wl-tabicon { font-size: 17px; }
  .kx-wl-tablong { display: none; }
  .kx-wl-tabshort { display: inline; }
  .kx-wl-table-wide { min-width: 560px; }
  .kx-wl-modal .kx-input { font-size: 16px; } /* iOS ei zoomaa kenttään */
}
`
