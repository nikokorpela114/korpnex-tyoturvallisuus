// src/DriveLog.jsx — Työajat: ajopäiväkirja (taulu wl_trips).
//
// Kulku: "🚗 Lähden ajoon" (alkulukema) → "🏁 Ajo päättyi" (loppulukema) →
// km = loppu − alku. Jos samalle päivälle on työpäivä, ajo liitetään siihen ja
// työpäivän km:t (ja lähtö/paluuajat, jos tyhjiä) päivittyvät. Muuten ajo jää
// erilliseksi ajoksi ja menee suoraan omaan matkalaskuun. Peräkkäisten
// lukemien väli näytetään yksityisajona, joka ei kuulu korvauksiin.
import React, { useState } from 'react'
import { sb } from './supabaseClient.js'
import { num, fmtNum, fmtDate, fmtTime, fmtEur, round2, buildDriveLog } from './worklog.js'

const pad = n => String(n).padStart(2, '0')
const nowDate = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const hhmm = t => (t ? String(t).slice(0, 5) : '')
const intOrNull = v => { const s = String(v ?? '').replace(/\s/g, ''); if (!s) return null; const n = parseInt(s, 10); return isFinite(n) ? n : null }
const fmtOdo = n => (n == null ? '–' : Number(n).toLocaleString('fi-FI'))

// Liittää valmiin ajon saman päivän työpäivään (sama työmaa ensisijaisesti)
async function linkTripToEntry(trip) {
  const { data: ents } = await sb.from('work_entries').select('id, site_id, km, depart_time, return_time')
    .eq('archived', false).eq('work_date', trip.trip_date)
  if (!ents?.length) return null
  const { data: taken } = await sb.from('wl_trips').select('entry_id').eq('archived', false)
    .in('entry_id', ents.map(e => e.id)).neq('id', trip.id)
  const free = ents.filter(e => !(taken || []).some(t => t.entry_id === e.id))
  const target = free.find(e => trip.site_id && e.site_id === trip.site_id) || (free.length === 1 ? free[0] : null)
  if (!target) return null
  const upd = { km: num(trip.km) }
  if (!target.depart_time && trip.start_time) upd.depart_time = trip.start_time
  if (!target.return_time && trip.end_time) upd.return_time = trip.end_time
  await sb.from('work_entries').update(upd).eq('id', target.id)
  await sb.from('wl_trips').update({ entry_id: target.id }).eq('id', trip.id)
  return target.id
}

// Reitti tallennetaan muodossa "Lähtö – Kohde – Lähtö" (meno-paluu) tai "Lähtö – Kohde".
const SEP = ' – '
function parseRoute(route, home) {
  const parts = String(route || '').split(SEP).map(x => x.trim()).filter(Boolean)
  if (parts.length === 3 && parts[0] === parts[2]) return { from: parts[0], dest: parts[1], roundTrip: true }
  if (parts.length === 2) return { from: parts[0], dest: parts[1], roundTrip: false }
  return { from: home || '', dest: parts.length ? String(route).trim() : '', roundTrip: true }
}
const composeRoute = (from, dest, roundTrip) => {
  const a = (from || '').trim() || 'Koti', b = (dest || '').trim()
  if (!b) return ''
  return roundTrip ? [a, b, a].join(SEP) : [a, b].join(SEP)
}
const siteAddr = s => (s?.address || s?.name || '').trim()

// --- Ajon aloitus / lopetus / muokkaus ----------------------------------------
export function TripModal({ mode, trip, sites, clients, settings, lastOdo, onClose, onSaved, showToast }) {
  // mode: 'start' | 'end' | 'edit' | 'new' (jälkikäteen)
  const activeSites = sites.filter(s => !s.archived)
  const [d, setD] = useState(() => ({
    trip_date: trip?.trip_date || nowDate(),
    start_time: hhmm(trip?.start_time) || (mode === 'start' ? nowTime() : ''),
    end_time: hhmm(trip?.end_time) || (mode === 'end' ? nowTime() : ''),
    odo_start: trip?.odo_start != null ? String(trip.odo_start) : '',
    odo_end: trip?.odo_end != null ? String(trip.odo_end) : '',
    km: trip?.km != null && trip?.odo_start == null ? String(trip.km).replace('.', ',') : '',
    site_id: trip?.site_id ?? (mode === 'start' || mode === 'new' ? (activeSites[0]?.id ?? '') : ''),
    purpose: trip?.purpose || '',
    ...(() => {
      const r = parseRoute(trip?.route, settings.homeAddress)
      const initSite = sites.find(x => String(x.id) === String(trip?.site_id ?? (mode === 'start' || mode === 'new' ? activeSites[0]?.id : '')))
      const dest = r.dest || siteAddr(initSite)
      const known = activeSites.some(x => siteAddr(x) === dest)
      return { from: r.from || settings.homeAddress || '', dest, destChoice: dest ? (known ? dest : '__custom') : '', roundTrip: r.roundTrip }
    })(),
  }))
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setD(x => ({ ...x, [k]: v }))
  const site = sites.find(s => String(s.id) === String(d.site_id))
  const client = site && clients.find(c => c.id === site.client_id)
  const autoPurpose = site ? `Työkeikka: ${client?.name || ''}${client ? ', ' : ''}${site.name}` : ''
  const route = composeRoute(d.from, d.dest, d.roundTrip)
  const destOptions = [...new Map(activeSites.filter(x => siteAddr(x)).map(x => [siteAddr(x), x])).values()]
  function pickSiteForTrip(v) {
    const sNew = sites.find(x => String(x.id) === String(v))
    setD(x => {
      const next = { ...x, site_id: v }
      // Työmaan vaihto vaihtaa kohteen, ellei kohdetta ole kirjoitettu käsin
      if (sNew && siteAddr(sNew) && x.destChoice !== '__custom') { next.dest = siteAddr(sNew); next.destChoice = siteAddr(sNew) }
      return next
    })
  }
  function pickDest(v) {
    if (v === '__custom') setD(x => ({ ...x, destChoice: '__custom', dest: '' }))
    else setD(x => ({ ...x, destChoice: v, dest: v }))
  }
  const s0 = intOrNull(d.odo_start), s1 = intOrNull(d.odo_end)
  const odoKm = s0 != null && s1 != null ? s1 - s0 : null
  const showEnd = mode !== 'start'

  async function save() {
    if (mode === 'start' && s0 == null) { showToast('⚠ Kirjoita mittarilukema'); return }
    if (mode === 'end' && s1 == null) { showToast('⚠ Kirjoita loppulukema'); return }
    if (odoKm != null && odoKm < 0) { showToast('⚠ Loppulukema on pienempi kuin alkulukema'); return }
    if (odoKm != null && odoKm > 2000) { showToast('⚠ Yli 2000 km yhdellä ajolla, tarkista lukemat'); return }
    if ((mode === 'new' || mode === 'edit') && odoKm == null && !num(d.km) && !(mode === 'edit' && s0 != null)) {
      showToast('⚠ Kirjoita lukemat tai kilometrit'); return
    }
    const row = {
      trip_date: d.trip_date,
      start_time: d.start_time || null,
      end_time: showEnd ? (d.end_time || null) : null,
      odo_start: s0,
      odo_end: showEnd ? s1 : null,
      km: odoKm != null ? odoKm : (num(d.km) || null),
      site_id: d.site_id ? Number(d.site_id) : null,
      client_name: client?.name || trip?.client_name || null,
      purpose: (d.purpose || autoPurpose).trim() || null,
      route: route || null,
    }
    setSaving(true)
    const res = trip?.id
      ? await sb.from('wl_trips').update(row).eq('id', trip.id).select()
      : await sb.from('wl_trips').insert([row]).select()
    if (res.error) { setSaving(false); console.error('wl_trips save failed:', res.error); showToast('⚠ Tallennus epäonnistui'); return }
    const saved = res.data?.[0]
    let linked = saved?.entry_id || null
    // Valmis ajo: liitetään työpäivään tai päivitetään liitetyn työpäivän km:t
    if (saved && (saved.odo_end != null || (saved.odo_start == null && num(saved.km) > 0))) {
      if (saved.entry_id) await sb.from('work_entries').update({ km: num(saved.km) }).eq('id', saved.entry_id)
      else linked = await linkTripToEntry(saved)
    }
    setSaving(false)
    showToast(mode === 'start' ? '🚗 Ajo aloitettu, hyvää matkaa!'
      : mode === 'end' ? `🏁 Ajo päättyi: ${fmtNum(saved?.km || 0)} km${linked ? ', päivitetty työpäivään' : ''}`
        : '✓ Ajo tallennettu')
    onSaved(saved, { linked })
  }

  async function archive() {
    if (!window.confirm('Poistetaanko ajo ajopäiväkirjasta?')) return
    const { error } = await sb.from('wl_trips').update({ archived: true, entry_id: null }).eq('id', trip.id)
    if (error) { showToast('⚠ Poisto epäonnistui'); return }
    showToast('🗑 Ajo poistettu'); onSaved(null, {})
  }

  const title = { start: '🚗 Lähden ajoon', end: '🏁 Ajo päättyi', edit: 'Muokkaa ajoa', new: 'Lisää ajo jälkikäteen' }[mode]
  return (
    <div className="kx-wl-overlay" onClick={() => !saving && onClose()}>
      <div className="kx-wl-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="kx-wl-modal-head">
          <div className="kx-modal-title">{title}</div>
          <button className="kx-icon-btn" onClick={onClose} aria-label="Sulje">✕</button>
        </div>

        {mode === 'end' && trip && (
          <div className="kx-wl-clientinfo">
            <div><b>Lähtö {fmtDate(trip.trip_date)} klo {fmtTime(trip.start_time)}</b> · mittari {fmtOdo(trip.odo_start)} km</div>
            {trip.purpose && <div className="kx-wl-period">{trip.purpose}</div>}
          </div>
        )}

        <div className="kx-wl-grid">
          {mode !== 'end' && <>
            <label className="kx-wl-field"><span>Päivä</span>
              <input className="kx-input" type="date" value={d.trip_date} onChange={e => set('trip_date', e.target.value)} /></label>
            <label className="kx-wl-field"><span>Lähtöaika</span>
              <input className="kx-input" type="time" step="300" value={d.start_time} onChange={e => set('start_time', e.target.value)} /></label>
            <label className="kx-wl-field kx-wl-wide"><span>Mittarilukema lähtiessä (km){mode === 'start' ? '' : ', vapaaehtoinen'}</span>
              <input className="kx-input kx-wl-odo" inputMode="numeric" placeholder={lastOdo != null ? `edellinen loppulukema ${fmtOdo(lastOdo)}` : 'esim. 200000'}
                value={d.odo_start} onChange={e => set('odo_start', e.target.value.replace(/[^\d]/g, ''))} autoFocus={mode === 'start'} /></label>
          </>}
          {showEnd && <>
            <label className="kx-wl-field"><span>Paluuaika</span>
              <input className="kx-input" type="time" step="300" value={d.end_time} onChange={e => set('end_time', e.target.value)} /></label>
            <label className="kx-wl-field"><span>Mittarilukema palatessa</span>
              <input className="kx-input kx-wl-odo" inputMode="numeric" placeholder={s0 != null ? `yli ${fmtOdo(s0)}` : 'esim. 200116'}
                value={d.odo_end} onChange={e => set('odo_end', e.target.value.replace(/[^\d]/g, ''))} autoFocus={mode === 'end'} /></label>
          </>}
          {odoKm != null && (
            <div className="kx-wl-calc kx-wl-wide">
              {fmtOdo(s1)} − {fmtOdo(s0)} = <b>{fmtNum(odoKm)} km</b> työajoa
              {mode === 'start' && lastOdo != null && s0 > lastOdo && <span> · yksityisajoa edellisen jälkeen {fmtNum(s0 - lastOdo)} km</span>}
            </div>
          )}
          {mode === 'start' && lastOdo != null && s0 != null && s0 > lastOdo && odoKm == null && (
            <div className="kx-wl-calc kx-wl-wide">Edellisen työajon jälkeen yksityisajoa <b>{fmtNum(s0 - lastOdo)} km</b></div>
          )}
          {(mode === 'new' || mode === 'edit') && s0 == null && (
            <label className="kx-wl-field kx-wl-wide"><span>Tai pelkät kilometrit (meno-paluu)</span>
              <input className="kx-input" inputMode="decimal" placeholder="esim. 116" value={d.km} onChange={e => set('km', e.target.value)} /></label>
          )}
          {mode !== 'end' && <>
            <label className="kx-wl-field kx-wl-wide"><span>Työmaa</span>
              <select className="kx-input" value={d.site_id ?? ''} onChange={e => pickSiteForTrip(e.target.value)}>
                <option value="">Muu ajo (ei työmaata)</option>
                {clients.filter(c => !c.archived).map(c => {
                  const own = activeSites.filter(x => x.client_id === c.id)
                  return own.length ? <optgroup key={c.id} label={c.name}>{own.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup> : null
                })}
              </select></label>
            <label className="kx-wl-field kx-wl-wide"><span>Ajon tarkoitus</span>
              <input className="kx-input" placeholder={autoPurpose || 'esim. Tarvikeostokset, asiakastapaaminen'} value={d.purpose} onChange={e => set('purpose', e.target.value)} /></label>
            <div className="kx-wl-section-title kx-wl-wide" style={{ marginTop: 4 }}>Reitti</div>
            <label className="kx-wl-field kx-wl-wide"><span>Lähtöosoite</span>
              <input className="kx-input" placeholder="Kotiosoite, esim. Kotikatu 1, 60100 Seinäjoki" value={d.from} onChange={e => set('from', e.target.value)} /></label>
            <label className="kx-wl-field kx-wl-wide"><span>Kohde</span>
              <select className="kx-input" value={d.destChoice} onChange={e => pickDest(e.target.value)}>
                {!d.destChoice && <option value="">— Valitse kohde —</option>}
                {destOptions.map(x => <option key={x.id} value={siteAddr(x)}>{siteAddr(x)}{x.address ? ` (${x.name})` : ''}</option>)}
                <option value="__custom">✏️ Kirjoita muu osoite…</option>
              </select></label>
            {d.destChoice === '__custom' && (
              <label className="kx-wl-field kx-wl-wide"><span>Kohteen osoite</span>
                <input className="kx-input" placeholder="esim. K-Rauta, Kaarretie 2, Seinäjoki" value={d.dest} onChange={e => set('dest', e.target.value)} autoFocus /></label>
            )}
            <label className="kx-checkbox-row kx-wl-wide" style={{ margin: 0 }}>
              <input type="checkbox" checked={d.roundTrip} onChange={e => set('roundTrip', e.target.checked)} />
              Meno-paluu (takaisin lähtöosoitteeseen)
            </label>
            {route && <div className="kx-wl-calc kx-wl-wide">Reitti: <b>{route}</b></div>}
          </>}
        </div>
        {!settings.homeAddress && mode !== 'end' && <div className="kx-hint">Vinkki: lisää kotiosoite kohtaan ⚙ Asetukset → Matkalaskun tiedot, niin lähtöosoite täyttyy automaattisesti.</div>}

        <div className="kx-modal-actions">
          {trip?.id && mode === 'edit' && <button className="kx-btn-ghost" style={{ marginRight: 'auto', color: '#b91c1c' }} onClick={archive}>🗑 Poista</button>}
          <button className="kx-btn-ghost" disabled={saving} onClick={onClose}>Peruuta</button>
          <button className="kx-btn-primary" disabled={saving} onClick={save}>
            {saving ? 'Tallennetaan…' : mode === 'start' ? '🚗 Aloita ajo' : mode === 'end' ? '🏁 Päätä ajo' : 'Tallenna'}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Käynnissä olevan ajon palkki (näkyy kaikilla välilehdillä) ---------------
export function OpenTripBanner({ trip, onEnd }) {
  if (!trip) return null
  return (
    <div className="kx-wl-tripbar" role="status">
      <div>
        <b>🚗 Ajo käynnissä</b>
        <span> · lähtö {fmtDate(trip.trip_date)} klo {fmtTime(trip.start_time)} · mittari {fmtOdo(trip.odo_start)} km</span>
        {trip.purpose && <div className="kx-wl-period" style={{ color: 'inherit', opacity: 0.8 }}>{trip.purpose}</div>}
      </div>
      <button className="kx-btn-primary kx-btn-sm" onClick={onEnd}>🏁 Ajo päättyi</button>
    </div>
  )
}

// --- Ajot-välilehti -----------------------------------------------------------
export default function DriveLog({ entries, trips, sites, settings, onEditTrip, onNewTrip, onStartTrip, openTrip, onExcel, exporting }) {
  const log = buildDriveLog(entries, trips, sites, settings.homeAddress)
  const eur = round2(log.businessKm * num(settings.ownKmRate))
  return (
    <>
      <div className="kx-wl-stats">
        <div><b>{fmtNum(log.businessKm)} km</b><span>työajoa</span></div>
        <div><b>{fmtEur(eur)}</b><span>km-korvaukset</span></div>
        <div><b>{log.rows.filter(r => !r.open).length}</b><span>ajoa</span></div>
        <div><b>{fmtNum(log.privateKm)} km</b><span>yksityisajoa välissä</span></div>
      </div>

      <div className="kx-wl-actions">
        {!openTrip && <button className="kx-btn-primary kx-btn-sm" onClick={onStartTrip}>🚗 Lähden ajoon</button>}
        <button className="kx-btn-ghost kx-btn-sm" onClick={onNewTrip}>＋ Lisää ajo jälkikäteen</button>
        <button className="kx-btn-ghost kx-btn-sm" onClick={onExcel} disabled={exporting} style={{ marginLeft: 'auto' }}>⬇ Ajopäiväkirja (Excel)</button>
      </div>

      {log.rows.length === 0 ? (
        <div className="kx-empty-note">
          Ei ajoja tässä kuussa. Paina <b>🚗 Lähden ajoon</b>, kun lähdet työajoon, ja kirjaa mittarilukema.
          Työpäivien kilometrit näkyvät täällä automaattisesti.
        </div>
      ) : (
        <div className="kx-card">
          <div className="kx-card-title" style={{ margin: '0 0 6px' }}>Ajopäiväkirja</div>
          <div className="kx-wl-list">
            {log.rows.map((r, i) => (
              <React.Fragment key={`${r.source}-${r.entryId || ''}-${r.tripId || ''}-${i}`}>
                {r.privateBefore > 0 && <div className="kx-wl-private">yksityisajoa välissä {fmtNum(r.privateBefore)} km (ei korvauksiin)</div>}
                <div className="kx-wl-row">
                  <button className="kx-wl-row-main" onClick={() => onEditTrip(r)}>
                    <div className="kx-wl-date">{new Date(r.date + 'T12:00:00').toLocaleDateString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric' })}</div>
                    <div className="kx-wl-row-body">
                      <div className="kx-wl-row-title">{r.purpose || 'Työajo'}</div>
                      <div className="kx-wl-row-sub">
                        <span className={`kx-wl-kind ${r.source === 'ajo' ? 'kx-wl-kind-urakka' : ''}`}>{r.open ? 'Käynnissä' : r.source === 'ajo' ? 'Erillinen ajo' : 'Työpäivä'}</span>
                        {[r.start && r.end ? `${fmtTime(r.start)}–${fmtTime(r.end)}` : r.start ? `lähtö ${fmtTime(r.start)}` : '',
                          r.odoStart != null ? `mittari ${fmtOdo(r.odoStart)} → ${fmtOdo(r.odoEnd)}` : 'ei mittarilukemia',
                          r.route].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="kx-wl-row-sum">{r.open ? '…' : `${fmtNum(r.km)} km`}</div>
                  </button>
                </div>
              </React.Fragment>
            ))}
          </div>
          <div className="kx-hint">Työpäivien kilometrit tulevat työkirjauksista. Erilliset ajot (esim. tarvikeostokset) menevät suoraan omaan matkalaskuun ja UKKO-matkalaskulle.</div>
        </div>
      )}
    </>
  )
}
