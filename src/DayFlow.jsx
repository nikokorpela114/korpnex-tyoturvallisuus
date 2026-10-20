// src/DayFlow.jsx — Työajat: "Päivä käynnissä" -kulku.
//
// Työpäivä kirjataan napeilla sitä mukaa kuin päivä etenee, eikä ajoa ja
// työaikaa tarvitse merkitä erikseen:
//   ▶ Lähden kotoa   → työpäivä (status 'kaynnissa') + siihen liitetty ajo (mittari)
//   🏗 Saavuin        → työt alkoivat
//   ⏸ Tauko          → tauon alku/loppu tai pikanappi 30 min
//   🔁 Vaihdan työmaata → nykyinen työmaa päättyy, uusi alkaa (oma kirjaus ja ajo)
//   🏁 Työt loppui    → työn loppuaika
//   🏠 Kotona         → loppulukema, km:t jaetaan työmaille, päivärahaehdotus
//   📝 Tarkista       → tavallinen lomake (urakkarivit, materiaalit) → status 'valmis'
// Keskeneräinen päivä ei näy laskuilla, matkalaskulla eikä summissa ennen tarkistusta.
// Matka-aikaa ei laskuteta (näkyy vain tunneissa tiedoksi).
import React, { useEffect, useState } from 'react'
import { sb } from './supabaseClient.js'
import { num, fmtNum, fmtTime, fmtDuration, timeToMin, calcHours, suggestPerDiem, allocateDayKm, PER_DIEM_LABELS } from './worklog.js'

const pad = n => String(n).padStart(2, '0')
export const nowDate = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
export const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const hhmm = t => (t ? String(t).slice(0, 5) : '')
const intOrNull = v => { const s = String(v ?? '').replace(/\s/g, ''); if (!s) return null; const n = parseInt(s, 10); return isFinite(n) ? n : null }
const fmtOdo = n => (n == null ? '–' : Number(n).toLocaleString('fi-FI'))
const SEP = ' – '
const minsBetween = (a, b) => { const x = timeToMin(a), y = timeToMin(b); if (x === null || y === null) return 0; let d = y - x; if (d < 0) d += 1440; return d }

export const isLive = e => e?.status === 'kaynnissa'
const hasCar = live => !!live.entries[0]?.live?.car
const tripOf = (live, entryId) => live.trips.find(t => t.entry_id === entryId && !t.archived) || null

// Vaihe päätellään viimeisen työmaan kellonajoista
export function dayPhase(e) {
  if (!e) return null
  if (e.return_time) return 'tarkistus'
  if (e.end_time) return 'paluu'
  if (e.start_time) return e.live?.break_start ? 'tauko' : 'tyo'
  return 'matka'
}
export const PHASE_LABELS = {
  matka: '🚗 Matkalla työmaalle', tyo: '🏗 Töissä', tauko: '⏸ Tauolla',
  paluu: '🏠 Matkalla kotiin', tarkistus: '📝 Tarkista ja tallenna',
}

// Työaika tähän mennessä (min), käynnissä oleva tauko vähennetään
export function workedMinutes(segs, now = nowTime()) {
  let m = 0
  for (const e of segs) {
    if (!e.start_time) continue
    m += minsBetween(e.start_time, e.end_time || now)
    m -= Number(e.break_minutes) || 0
    if (e.live?.break_start && !e.end_time) m -= minsBetween(e.live.break_start, now)
  }
  return Math.max(0, m)
}

const siteAddr = (sites, e) => {
  const s = e.site_id && sites.find(x => x.id === e.site_id)
  return ((s?.address || s?.name || e.site || e.client_name || '')).trim()
}
const purposeOf = row => `Työkeikka: ${row.client_name}${row.site ? `, ${row.site}` : ''}`

// --- Työmaan valinta ----------------------------------------------------------
function SitePicker({ sites, clients, value, onChange }) {
  const active = sites.filter(s => !s.archived)
  return (
    <select className="kx-input" value={value} onChange={e => onChange(e.target.value)}>
      {!value && <option value="">— Valitse työmaa —</option>}
      {clients.filter(c => !c.archived).map(c => {
        const own = active.filter(x => x.client_id === c.id)
        return own.length ? <optgroup key={c.id} label={c.name}>{own.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup> : null
      })}
      <option value="__free">Muu (kirjoita asiakas)</option>
    </select>
  )
}
function FreeClient({ d, set }) {
  return (
    <div className="kx-wl-grid">
      <label className="kx-wl-field"><span>Asiakas</span>
        <input className="kx-input" placeholder="esim. Zaumax Oy" value={d.client_name} onChange={e => set('client_name', e.target.value)} /></label>
      <label className="kx-wl-field"><span>Työmaa / kohde</span>
        <input className="kx-input" placeholder="esim. Kauhajoki" value={d.site} onChange={e => set('site', e.target.value)} /></label>
    </div>
  )
}
function rowFor(d, makeEntryRow) {
  if (d.site_id === '__free') {
    if (!d.client_name.trim()) return { error: '⚠ Kirjoita asiakas' }
    return { row: makeEntryRow(null, { client_name: d.client_name.trim(), site: d.site.trim() }) }
  }
  if (!d.site_id) return { error: '⚠ Valitse työmaa' }
  return { row: makeEntryRow(Number(d.site_id)) }
}
const dbError = (error, showToast) => {
  console.error('day flow save failed:', error)
  showToast(/column|status|live|schema cache/i.test(error?.message || '')
    ? '⚠ Tietokanta pitää päivittää: aja supabase/tyoajat.sql uudelleen'
    : '⚠ Tallennus epäonnistui')
}

function Modal({ title, children, actions, onClose, busy }) {
  return (
    <div className="kx-wl-overlay" onClick={() => !busy && onClose()}>
      <div className="kx-wl-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="kx-wl-modal-head">
          <div className="kx-modal-title">{title}</div>
          <button className="kx-icon-btn" onClick={onClose} aria-label="Sulje">✕</button>
        </div>
        {children}
        <div className="kx-modal-actions">{actions}</div>
      </div>
    </div>
  )
}

// --- Päivän aloitus -----------------------------------------------------------
export function DayStartModal({ sites, clients, settings, lastOdo, lastSiteId, makeEntryRow, onClose, onStarted, showToast }) {
  const firstSite = sites.find(s => s.id === lastSiteId && !s.archived) || sites.find(s => !s.archived)
  const [d, setD] = useState(() => ({
    site_id: firstSite ? String(firstSite.id) : '__free', client_name: '', site: '',
    car: true, odo: lastOdo != null ? String(lastOdo) : '', time: nowTime(), atSite: false,
  }))
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setD(x => ({ ...x, [k]: v }))
  const odo = intOrNull(d.odo)

  async function start() {
    const r = rowFor(d, makeEntryRow)
    if (r.error) { showToast(r.error); return }
    if (d.car && odo == null) { showToast('⚠ Kirjoita mittarilukema tai valitse "Kyydillä / muu"'); return }
    const date = nowDate()
    setBusy(true)
    const entry = {
      ...r.row, work_date: date, status: 'kaynnissa', live: { car: d.car },
      depart_time: d.time, start_time: d.atSite ? d.time : null, end_time: null, return_time: null,
      break_minutes: 0, hours: 0, km: 0, per_diem: 'ei', invoiced_at: null,
    }
    const res = await sb.from('work_entries').insert([entry]).select()
    if (res.error) { setBusy(false); dbError(res.error, showToast); return }
    const saved = res.data[0]
    if (d.car) {
      const home = (settings.homeAddress || '').trim() || 'Koti'
      const dest = siteAddr(sites, saved)
      const tr = await sb.from('wl_trips').insert([{
        trip_date: date, start_time: d.time, odo_start: odo, site_id: saved.site_id || null,
        client_name: saved.client_name, purpose: purposeOf(saved), route: dest ? [home, dest].join(SEP) : null, entry_id: saved.id,
      }]).select()
      if (tr.error) console.error('day trip insert failed:', tr.error)
    }
    setBusy(false)
    showToast(d.atSite ? '🏗 Työpäivä aloitettu' : '🚗 Työpäivä aloitettu, hyvää matkaa!')
    onStarted()
  }

  return (
    <Modal title="▶ Aloita työpäivä" onClose={onClose} busy={busy} actions={<>
      <button className="kx-btn-ghost" disabled={busy} onClick={onClose}>Peruuta</button>
      <button className="kx-btn-primary" disabled={busy} onClick={start}>{busy ? 'Tallennetaan…' : d.atSite ? '🏗 Aloita työt' : '🚗 Lähden nyt'}</button>
    </>}>
      <label className="kx-wl-field"><span>Työmaa</span>
        <SitePicker sites={sites} clients={clients} value={d.site_id} onChange={v => set('site_id', v)} /></label>
      {d.site_id === '__free' && <FreeClient d={d} set={set} />}
      <div className="kx-wl-seg" role="radiogroup" aria-label="Kulkutapa">
        <button role="radio" aria-checked={d.car} className={d.car ? 'active' : ''} onClick={() => set('car', true)}>🚗 Omalla autolla</button>
        <button role="radio" aria-checked={!d.car} className={!d.car ? 'active' : ''} onClick={() => set('car', false)}>Kyydillä / muu</button>
      </div>
      <div className="kx-wl-grid">
        <label className="kx-wl-field"><span>{d.atSite ? 'Työt alkoivat' : 'Lähtöaika'}</span>
          <input className="kx-input" type="time" step="300" value={d.time} onChange={e => set('time', e.target.value)} /></label>
        {d.car && (
          <label className="kx-wl-field"><span>Mittarilukema nyt (km)</span>
            <input className="kx-input kx-wl-odo" inputMode="numeric" placeholder="esim. 200000" value={d.odo}
              onChange={e => set('odo', e.target.value.replace(/[^\d]/g, ''))} /></label>
        )}
        <label className="kx-checkbox-row kx-wl-wide" style={{ margin: 0 }}>
          <input type="checkbox" checked={d.atSite} onChange={e => set('atSite', e.target.checked)} />
          Olen jo työmaalla (työt alkavat heti)
        </label>
      </div>
      {d.car && lastOdo != null && odo != null && odo > lastOdo && (
        <div className="kx-wl-calc">Edellisen työajon jälkeen yksityisajoa <b>{fmtNum(odo - lastOdo)} km</b></div>
      )}
      <div className="kx-hint" style={{ marginTop: 0 }}>Lähtöaika on päivärahan alku. Ajo kirjautuu ajopäiväkirjaan tähän työpäivään liitettynä.</div>
    </Modal>
  )
}

// --- Työmaan vaihto -----------------------------------------------------------
function SwitchModal({ live, sites, clients, makeEntryRow, onClose, onDone, showToast }) {
  const cur = live.entries[live.entries.length - 1]
  const retarget = dayPhase(cur) === 'matka' // vielä matkalla → vaihdetaan vain kohde
  const car = hasCar(live)
  const curTrip = tripOf(live, cur.id)
  const [d, setD] = useState({ site_id: '', client_name: '', site: '', time: nowTime(), odo: '' })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setD(x => ({ ...x, [k]: v }))
  const odo = intOrNull(d.odo)

  async function save() {
    const r = rowFor(d, makeEntryRow)
    if (r.error) { showToast(r.error); return }
    if (odo != null && curTrip?.odo_start != null && odo < curTrip.odo_start) { showToast('⚠ Lukema on pienempi kuin lähtölukema'); return }
    setBusy(true)
    let error = null
    if (retarget) {
      const { work_date, depart_time, start_time, ...fields } = r.row // eslint-disable-line no-unused-vars
      const res = await sb.from('work_entries').update({ ...fields, status: 'kaynnissa', hours: 0, km: 0, per_diem: 'ei' }).eq('id', cur.id).select()
      error = res.error
      if (!error && curTrip) {
        const e2 = res.data[0]
        await sb.from('wl_trips').update({ site_id: e2.site_id || null, client_name: e2.client_name, purpose: purposeOf(e2) }).eq('id', curTrip.id)
      }
    } else {
      const upd = { end_time: hhmm(cur.end_time) || d.time }
      if (cur.live?.break_start) {
        upd.break_minutes = (Number(cur.break_minutes) || 0) + minsBetween(cur.live.break_start, d.time)
        upd.live = { ...cur.live, break_start: null }
      }
      const a = await sb.from('work_entries').update(upd).eq('id', cur.id)
      error = a.error
      if (!error && curTrip && curTrip.odo_end == null) {
        await sb.from('wl_trips').update({
          end_time: d.time, odo_end: odo,
          km: odo != null && curTrip.odo_start != null ? odo - curTrip.odo_start : null,
        }).eq('id', curTrip.id)
      }
      if (!error) {
        const first = live.entries[0]
        const res = await sb.from('work_entries').insert([{
          ...r.row, work_date: cur.work_date, status: 'kaynnissa', live: { car },
          depart_time: hhmm(first.depart_time) || null, start_time: null, end_time: null, return_time: null,
          break_minutes: 0, hours: 0, km: 0, per_diem: 'ei', invoiced_at: null,
        }]).select()
        error = res.error
        if (!error && car) {
          const e2 = res.data[0]
          const tr = await sb.from('wl_trips').insert([{
            trip_date: cur.work_date, start_time: d.time, odo_start: odo, site_id: e2.site_id || null,
            client_name: e2.client_name, purpose: purposeOf(e2), entry_id: e2.id,
          }])
          if (tr.error) console.error('switch trip insert failed:', tr.error)
        }
      }
    }
    setBusy(false)
    if (error) { dbError(error, showToast); return }
    showToast(retarget ? '✓ Kohde vaihdettu' : '🔁 Työmaa vaihdettu, matkalla seuraavalle')
    onDone()
  }

  return (
    <Modal title={retarget ? 'Vaihda kohde' : '🔁 Vaihdan työmaata'} onClose={onClose} busy={busy} actions={<>
      <button className="kx-btn-ghost" disabled={busy} onClick={onClose}>Peruuta</button>
      <button className="kx-btn-primary" disabled={busy} onClick={save}>{busy ? 'Tallennetaan…' : retarget ? 'Vaihda kohde' : '🔁 Lähden seuraavalle'}</button>
    </>}>
      <div className="kx-wl-clientinfo">
        <div><b>Nyt: {cur.client_name}{cur.site ? `, ${cur.site}` : ''}</b></div>
        {!retarget && <div className="kx-wl-period">Työt tällä työmaalla päättyvät {cur.end_time ? `klo ${fmtTime(cur.end_time)}` : 'valittuun aikaan'}.</div>}
      </div>
      <label className="kx-wl-field"><span>{retarget ? 'Uusi kohde' : 'Seuraava työmaa'}</span>
        <SitePicker sites={sites} clients={clients} value={d.site_id} onChange={v => set('site_id', v)} /></label>
      {d.site_id === '__free' && <FreeClient d={d} set={set} />}
      {!retarget && (
        <div className="kx-wl-grid">
          <label className="kx-wl-field"><span>Lähtöaika</span>
            <input className="kx-input" type="time" step="300" value={d.time} onChange={e => set('time', e.target.value)} /></label>
          {car && (
            <label className="kx-wl-field"><span>Mittarilukema nyt (vapaaehtoinen)</span>
              <input className="kx-input kx-wl-odo" inputMode="numeric" placeholder={curTrip?.odo_start != null ? `yli ${fmtOdo(curTrip.odo_start)}` : ''}
                value={d.odo} onChange={e => set('odo', e.target.value.replace(/[^\d]/g, ''))} /></label>
          )}
        </div>
      )}
      {!retarget && car && <div className="kx-hint" style={{ marginTop: 0 }}>Lukema jakaa päivän kilometrit työmaille tarkasti. Ilman sitä km:t jaetaan työmaiden km-tietojen suhteessa, ja voit korjata ne tarkistuksessa.</div>}
    </Modal>
  )
}

// --- Kotiinpaluu: km-jako, reitit ja päiväraha ---------------------------------
function HomeModal({ live, sites, settings, onClose, onDone, showToast }) {
  const segs = live.entries
  const first = segs[0], last = segs[segs.length - 1]
  const car = hasCar(live)
  const trips = segs.map(e => tripOf(live, e.id))
  const odoStart = trips[0]?.odo_start ?? null
  const [d, setD] = useState({ time: nowTime(), odo: '', km: '' })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setD(x => ({ ...x, [k]: v }))
  const odo = intOrNull(d.odo)
  const total = car ? (odo != null && odoStart != null ? odo - odoStart : num(d.km)) : 0
  const siteKm = e => num(e.site_id && sites.find(x => x.id === e.site_id)?.km)
  const pd = suggestPerDiem(first.depart_time, d.time, total || Math.max(0, ...segs.map(siteKm)))

  async function save() {
    if (car && odo == null && !num(d.km)) { showToast('⚠ Kirjoita loppulukema tai ajetut kilometrit'); return }
    if (car && odo != null && odoStart != null && odo < odoStart) { showToast('⚠ Loppulukema on pienempi kuin lähtölukema'); return }
    if (car && total > 2000) { showToast('⚠ Yli 2000 km yhdessä päivässä, tarkista lukemat'); return }
    const legs = segs.map((e, i) => {
      const t = trips[i]
      const end = i === segs.length - 1 ? odo : t?.odo_end
      return { known: segs.length === 1 ? total : (t?.odo_start != null && end != null ? end - t.odo_start : null), weight: siteKm(e) }
    })
    const kms = car ? allocateDayKm(legs, total) : segs.map(() => 0)
    const home = (settings.homeAddress || '').trim() || 'Koti'
    setBusy(true)
    let error = null
    for (let i = 0; i < segs.length && !error; i++) {
      const e = segs[i], isLast = i === segs.length - 1
      const end = hhmm(e.end_time) || (isLast ? d.time : null)
      const c = calcHours(e.start_time, end, e.break_minutes)
      const upd = {
        km: kms[i], end_time: end, hours: e.kind === 'urakka' ? 0 : (c ? c.hours : 0),
        per_diem: isLast && pd ? pd.value : 'ei', live: { ...(e.live || {}), break_start: null },
      }
      if (isLast) { upd.return_time = d.time; upd.depart_time = hhmm(first.depart_time) || null }
      const res = await sb.from('work_entries').update(upd).eq('id', e.id)
      error = res.error
      const t = trips[i]
      if (!error && t) {
        const parts = [i === 0 ? home : siteAddr(sites, segs[i - 1]), siteAddr(sites, e)]
        if (isLast) parts.push(home)
        await sb.from('wl_trips').update({
          km: kms[i], route: parts.filter(Boolean).join(SEP),
          end_time: isLast ? d.time : (t.end_time || end), odo_end: isLast ? odo : t.odo_end,
        }).eq('id', t.id)
      }
    }
    setBusy(false)
    if (error) { dbError(error, showToast); return }
    showToast('🏠 Tervetuloa kotiin! Tarkista vielä päivän tiedot.')
    onDone()
  }

  return (
    <Modal title="🏠 Kotona" onClose={onClose} busy={busy} actions={<>
      <button className="kx-btn-ghost" disabled={busy} onClick={onClose}>Peruuta</button>
      <button className="kx-btn-primary" disabled={busy} onClick={save}>{busy ? 'Tallennetaan…' : '🏠 Päätä päivä'}</button>
    </>}>
      <div className="kx-wl-grid">
        <label className="kx-wl-field"><span>Paluuaika</span>
          <input className="kx-input" type="time" step="300" value={d.time} onChange={e => set('time', e.target.value)} /></label>
        {car && odoStart != null && (
          <label className="kx-wl-field"><span>Mittarilukema nyt</span>
            <input className="kx-input kx-wl-odo" inputMode="numeric" placeholder={`yli ${fmtOdo(odoStart)}`} value={d.odo}
              onChange={e => set('odo', e.target.value.replace(/[^\d]/g, ''))} autoFocus /></label>
        )}
        {car && (odoStart == null || odo == null) && (
          <label className="kx-wl-field"><span>{odoStart == null ? 'Ajetut km yhteensä' : 'Tai ajetut km yhteensä'}</span>
            <input className="kx-input" inputMode="decimal" placeholder="esim. 116" value={d.km} onChange={e => set('km', e.target.value)} /></label>
        )}
      </div>
      {car && total > 0 && (
        <div className="kx-wl-calc">
          {odo != null && odoStart != null ? <>{fmtOdo(odo)} − {fmtOdo(odoStart)} = </> : null}<b>{fmtNum(total)} km</b> työajoa
          {segs.length > 1 && <span> · jaetaan {segs.length} työmaalle</span>}
        </div>
      )}
      {pd && (
        <div className="kx-wl-calc">
          Kodista kotiin {fmtDuration(pd.dur)} → <b>{PER_DIEM_LABELS[pd.value].toLowerCase()}</b> ({pd.reason})
        </div>
      )}
    </Modal>
  )
}

// --- Päivä käynnissä -paneeli (näkyy kaikilla välilehdillä) -------------------
export function DayPanel({ live, sites, clients, settings, makeEntryRow, onChanged, onReview, onEdit, showToast }) {
  const [modal, setModal] = useState(null) // 'switch' | 'home'
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(nowTime)
  useEffect(() => { const t = setInterval(() => setNow(nowTime()), 30000); return () => clearInterval(t) }, [])
  if (!live.entries.length) return null
  const segs = live.entries
  const cur = segs[segs.length - 1]
  const phase = dayPhase(cur)
  const car = hasCar(live)
  const firstTrip = tripOf(live, segs[0].id)
  const worked = workedMinutes(segs, now)

  async function update(fields, msg) {
    setBusy(true)
    const { error } = await sb.from('work_entries').update(fields).eq('id', cur.id)
    setBusy(false)
    if (error) { dbError(error, showToast); return }
    if (msg) showToast(msg)
    onChanged()
  }
  const t = nowTime()
  const arrive = () => update({ start_time: t }, '🏗 Työt alkoivat ' + fmtTime(t))
  const breakStart = () => update({ live: { ...(cur.live || {}), break_start: t } }, '⏸ Tauko alkoi')
  const breakEnd = () => {
    const m = minsBetween(cur.live.break_start, t)
    update({ break_minutes: (Number(cur.break_minutes) || 0) + m, live: { ...cur.live, break_start: null } }, `▶ Tauko ${m} min`)
  }
  const quickBreak = () => update({ break_minutes: (Number(cur.break_minutes) || 0) + 30 }, '✓ Ruokatauko 30 min')
  const endWork = () => {
    const fields = { end_time: t }
    if (cur.live?.break_start) {
      fields.break_minutes = (Number(cur.break_minutes) || 0) + minsBetween(cur.live.break_start, t)
      fields.live = { ...cur.live, break_start: null }
    }
    update(fields, '🏁 Työt loppuivat ' + fmtTime(t))
  }
  const resume = () => update({ end_time: null }, '↩ Jatketaan töitä')
  async function cancelDay() {
    if (!window.confirm('Perutaanko koko käynnissä oleva työpäivä? Kirjaukset ja ajot poistetaan.')) return
    setBusy(true)
    const ids = segs.map(e => e.id)
    await sb.from('wl_trips').update({ archived: true }).in('entry_id', ids)
    const { error } = await sb.from('work_entries').update({ archived: true }).in('id', ids)
    setBusy(false)
    if (error) { dbError(error, showToast); return }
    showToast('🗑 Työpäivä peruttu'); onChanged()
  }

  return (
    <div className={`kx-day kx-day-${phase}`} role="status" id="kx-day-panel">
      <div className="kx-day-head">
        <div>
          <div className="kx-day-title">Työpäivä käynnissä</div>
          <div className="kx-day-phase">{PHASE_LABELS[phase]}</div>
        </div>
        <div className="kx-day-worked">
          <b>{fmtDuration(worked)}</b>
          <span>työaikaa{segs.reduce((s, e) => s + (Number(e.break_minutes) || 0), 0) ? ` (tauot ${segs.reduce((s, e) => s + (Number(e.break_minutes) || 0), 0)} min)` : ''}</span>
        </div>
      </div>
      <ol className="kx-day-steps">
        <li>🚗 Lähtö {fmtTime(segs[0].depart_time)}{car && firstTrip?.odo_start != null ? ` · mittari ${fmtOdo(firstTrip.odo_start)}` : car ? '' : ' · kyydillä'}</li>
        {segs.map((e, i) => (
          <li key={e.id} className={e === cur ? 'cur' : ''}>
            🏗 <b>{e.client_name}{e.site ? `, ${e.site}` : ''}</b>
            {e.start_time ? ` · ${fmtTime(e.start_time)}–${e.end_time ? fmtTime(e.end_time) : ''}` : i > 0 ? ' · matkalla' : ''}
            {e.break_minutes ? ` · tauko ${e.break_minutes} min` : ''}
            {e.live?.break_start && !e.end_time ? ` · tauolla klo ${fmtTime(e.live.break_start)} alkaen` : ''}
            {phase === 'tarkistus' && num(e.km) > 0 ? ` · ${fmtNum(e.km)} km` : ''}
          </li>
        ))}
        {cur.return_time && <li>🏠 Kotona {fmtTime(cur.return_time)}{cur.per_diem !== 'ei' ? ` · ${PER_DIEM_LABELS[cur.per_diem].toLowerCase()}` : ''}</li>}
      </ol>
      <div className="kx-day-actions">
        {phase === 'matka' && <>
          <button className="kx-btn-primary" disabled={busy} onClick={arrive}>🏗 Saavuin, työt alkaa</button>
          <button className="kx-btn-ghost" disabled={busy} onClick={() => setModal('switch')}>Vaihda kohde</button>
        </>}
        {phase === 'tyo' && <>
          <button className="kx-btn-primary" disabled={busy} onClick={endWork}>🏁 Työt loppui</button>
          <button className="kx-btn-ghost" disabled={busy} onClick={breakStart}>⏸ Tauko alkaa</button>
          <button className="kx-btn-ghost" disabled={busy} onClick={quickBreak}>＋ Ruokatauko 30 min</button>
          <button className="kx-btn-ghost" disabled={busy} onClick={() => setModal('switch')}>🔁 Vaihdan työmaata</button>
        </>}
        {phase === 'tauko' && <>
          <button className="kx-btn-primary" disabled={busy} onClick={breakEnd}>▶ Tauko päättyi</button>
          <button className="kx-btn-ghost" disabled={busy} onClick={endWork}>🏁 Työt loppui</button>
        </>}
        {phase === 'paluu' && <>
          <button className="kx-btn-primary" disabled={busy} onClick={() => setModal('home')}>🏠 Olen kotona</button>
          <button className="kx-btn-ghost" disabled={busy} onClick={() => setModal('switch')}>🔁 Lähden toiselle työmaalle</button>
          <button className="kx-btn-ghost" disabled={busy} onClick={resume}>↩ Jatkan töitä</button>
        </>}
        {phase === 'tarkistus' && (
          <button className="kx-btn-primary" disabled={busy} onClick={() => onReview(segs[0])}>📝 Tarkista ja tallenna päivä</button>
        )}
      </div>
      <div className="kx-day-links">
        <button className="kx-wl-linkbtn" onClick={() => onEdit(cur)}>✏️ Korjaa aikoja tai tietoja</button>
        <button className="kx-wl-linkbtn" style={{ color: '#b91c1c' }} disabled={busy} onClick={cancelDay}>✕ Peru päivä</button>
      </div>
      {modal === 'switch' && (
        <SwitchModal live={live} sites={sites} clients={clients} makeEntryRow={makeEntryRow} showToast={showToast}
          onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged() }} />
      )}
      {modal === 'home' && (
        <HomeModal live={live} sites={sites} settings={settings} showToast={showToast}
          onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged({ review: true }) }} />
      )}
    </div>
  )
}

export const DAYFLOW_CSS = `
.kx-day { background: linear-gradient(135deg, #ecfdf5, #fff); border: 1.5px solid #6ee7b7; border-radius: 16px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.kx-day-tauko { background: linear-gradient(135deg, #fffbeb, #fff); border-color: #fcd34d; }
.kx-day-matka, .kx-day-paluu { background: linear-gradient(135deg, #eef5ff, #fff); border-color: #93c5fd; }
.kx-day-tarkistus { background: linear-gradient(135deg, #fff7ed, #fff); border-color: #fdba74; }
.kx-day-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.kx-day-title { font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .4px; }
.kx-day-phase { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 18px; font-weight: 800; color: #0a1428; margin-top: 2px; }
.kx-day-worked { text-align: right; display: flex; flex-direction: column; }
.kx-day-worked b { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 20px; font-weight: 800; color: #047857; font-variant-numeric: tabular-nums; white-space: nowrap; }
.kx-day-worked span { font-size: 11.5px; color: #64748b; font-weight: 600; }
.kx-day-steps { list-style: none; margin: 0; padding: 0 0 0 4px; display: flex; flex-direction: column; gap: 3px; font-size: 13px; color: #334155; border-left: 2px solid #cbd5e1; }
.kx-day-steps li { padding-left: 10px; }
.kx-day-steps li.cur { color: #0a1428; }
.kx-day-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.kx-day-actions .kx-btn-primary { font-size: 15px; padding: 12px 18px; }
.kx-day-links { display: flex; gap: 16px; flex-wrap: wrap; }
.kx-day-links .kx-wl-linkbtn { color: #475569; margin-top: 0; }
@media (max-width: 640px) {
  .kx-day-actions > button { flex: 1 1 100%; }
  .kx-day-actions > .kx-btn-ghost { flex: 1 1 45%; }
}
`
