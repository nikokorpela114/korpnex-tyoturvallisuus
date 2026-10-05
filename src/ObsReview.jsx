// src/ObsReview.jsx — havaintokortit kuvineen ja kuittausketju Valvomoon.
//
//   Asiakas:    näkee havainnon, ennen-kuvat ja tilan; voi kuitata avoimen
//               havainnon korjatuksi (kommentti + valinnainen kuva).
//   Konsultti:  "Odottaa tarkastusta" -listassa voi merkitä korjatuksi
//               (jälkikuvan kanssa) tai palauttaa avoimeksi.
import React, { useState } from 'react'
import { sb } from './supabaseClient.js'
import { compressImage } from './shared.js'
import { uploadPhoto } from './photos.js'

const sevColor = { Kriittinen: '#d63030', Huomio: '#d07800', Info: '#1a8a50' }
const fmt = d => d ? new Date(d).toLocaleDateString('fi-FI') : ''
const fmtDt = d => d ? new Date(d).toLocaleString('fi-FI', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export const STATUS = {
  avoin: { label: 'Avoin', color: '#d63030', bg: 'rgba(214,48,48,0.1)' },
  kuitattu: { label: 'Odottaa tarkastusta', color: '#a65b00', bg: 'rgba(245,168,0,0.16)' },
  korjattu: { label: '✓ Korjattu', color: '#1a8a50', bg: 'rgba(26,138,80,0.1)' },
}

export function StatusTag({ status }) {
  const s = STATUS[status] || STATUS.avoin
  return <span className="kx-tag" style={{ background: s.bg, color: s.color }}>{s.label}</span>
}

export function overdue(o) {
  if (!o.due_date || o.status === 'korjattu') return false
  return new Date(o.due_date + 'T23:59:59') < new Date()
}

export function Photo({ url, label, onOpen }) {
  return (
    <button className="kx-photo" onClick={() => url && onOpen?.(url)}>
      {url ? <img src={url} alt="" /> : <span className="kx-photo-ph">📷</span>}
      {label && <span className="kx-photo-label">{label}</span>}
    </button>
  )
}

// Yksi havainto luku-tilassa + toiminnot (children).
export function ObsCard({ o, urls, showSite, onOpenPhoto, children }) {
  return (
    <div className="kx-card kx-obs-card" style={o.status === 'kuitattu' ? { borderColor: '#f0c36d' } : undefined}>
      <div className="kx-obs-card-head">
        <span className="kx-obs-index">
          {showSite ? <b style={{ color: '#17275c' }}>{o.site}</b> : 'Havainto'} · {fmt(o.created_at)}
        </span>
        <div className="kx-obs-tags">
          <span className="kx-tag" style={{ background: 'rgba(0,0,0,0.04)', color: sevColor[o.sev] }}>{o.sev}</span>
          <StatusTag status={o.status} />
        </div>
      </div>
      <div className="kx-obs-title">{o.havainto || '(ei kuvausta)'}</div>
      <div className="kx-obs-meta-row">
        {o.yritys && <span>🏢 {o.yritys}</span>}
        {o.due_date && <span style={overdue(o) ? { color: '#d63030', fontWeight: 700 } : undefined}>⏱ Korjattava {fmt(o.due_date)}{overdue(o) ? ' — myöhässä' : ''}</span>}
        {o.inspector && <span>👷 {o.inspector}</span>}
      </div>
      {o.note && <div className="kx-obs-note">{o.note}</div>}

      {((o.photos || []).length > 0 || o.ack_photo || o.fix_photo) && (
        <div className="kx-photo-row">
          {(o.photos || []).map(p => <Photo key={p.path} url={urls[p.path]} label="Ennen" onOpen={onOpenPhoto} />)}
          {o.ack_photo && <Photo url={urls[o.ack_photo]} label="Asiakkaan kuva" onOpen={onOpenPhoto} />}
          {o.fix_photo && <Photo url={urls[o.fix_photo]} label="Jälkeen" onOpen={onOpenPhoto} />}
        </div>
      )}

      <div className="kx-timeline">
        <div>🔴 Merkitty {fmtDt(o.created_at)}{o.inspector ? ` · ${o.inspector}` : ''}</div>
        {o.reopen_comment && o.status === 'avoin' && <div style={{ color: '#d63030' }}>↩ Palautettu avoimeksi: {o.reopen_comment}</div>}
        {o.ack_at && <div>🟡 Kuitattu korjatuksi {fmtDt(o.ack_at)} · {o.ack_by_name}{o.ack_comment ? ` — "${o.ack_comment}"` : ''}</div>}
        {o.status === 'korjattu' && <div>🟢 Korjaus varmistettu {fmtDt(o.fixed_at)}{o.fixed_by_name ? ` · ${o.fixed_by_name}` : ''}</div>}
      </div>
      {children}
    </div>
  )
}

// Asiakkaan "Kuittaa korjatuksi" -lomake.
export function AckAction({ o, onDone }) {
  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [photo, setPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (o.status !== 'avoin') return null
  if (!open) {
    return <button className="kx-btn-primary kx-btn-ack" onClick={() => setOpen(true)}>✓ Kuittaa korjatuksi</button>
  }
  async function submit() {
    setBusy(true); setErr('')
    try {
      let path = null
      if (photo) path = await uploadPhoto(o.worksite_id, photo)
      const { error } = await sb.rpc('tt_ack_observation', { p_id: o.id, p_comment: comment, p_photo: path })
      if (error) throw error
      sb.functions.invoke('tt-admin', { body: { action: 'notify_ack', observation_id: o.id } }).catch(() => {})
      onDone?.()
    } catch (e) {
      setErr(e?.message || 'Kuittaus epäonnistui')
      setBusy(false)
    }
  }
  return (
    <div className="kx-ack-form">
      <div className="kx-label">Kuittaa korjatuksi</div>
      <textarea className="kx-input kx-textarea" placeholder="Mitä tehtiin? (valinnainen) esim. Kaide asennettu takaisin" value={comment} onChange={e => setComment(e.target.value)} />
      <div className="kx-ack-photo-row">
        {photo ? (
          <div className="kx-photo"><img src={photo} alt="" /><button className="kx-photo-x" onClick={() => setPhoto(null)}>×</button></div>
        ) : (
          <label className="kx-btn-ghost kx-btn-sm" style={{ cursor: 'pointer' }}>
            📷 Lisää kuva korjauksesta
            <input type="file" accept="image/*" style={{ display: 'none' }}
              onChange={async e => { const f = e.target.files?.[0]; if (f) setPhoto(await compressImage(f, 1280, 0.72)); e.target.value = '' }} />
          </label>
        )}
      </div>
      {err && <div className="kx-error" style={{ margin: 0 }}>{err}</div>}
      <div className="kx-obs-card-foot">
        <button className="kx-btn-ghost kx-btn-sm" onClick={() => { setOpen(false); setErr('') }} disabled={busy}>Peruuta</button>
        <button className="kx-btn-primary kx-btn-sm" onClick={submit} disabled={busy}>{busy ? 'Lähetetään…' : 'Lähetä kuittaus'}</button>
      </div>
      <div className="kx-hint">Korpnex tarkistaa korjauksen seuraavalla käynnillä ja merkitsee sen varmistetuksi.</div>
    </div>
  )
}

// Konsultin tarkastus: korjattu (jälkikuva) / ei korjattu (palautus).
export function ReviewAction({ o, reviewerName, onDone }) {
  const [busy, setBusy] = useState(false)
  async function markFixed(file) {
    setBusy(true)
    try {
      let path = null
      if (file) path = await uploadPhoto(o.worksite_id, await compressImage(file, 1280, 0.72))
      const patch = { status: 'korjattu', fixed_at: new Date().toISOString(), fixed_by_name: reviewerName || null, fix_photo: path }
      const { error } = await sb.from('safety_observations').update(patch).eq('id', o.id)
      if (error) throw error
      onDone?.({ ...o, ...patch })
    } catch (e) { alert('Tallennus epäonnistui: ' + (e?.message || e)) }
    setBusy(false)
  }
  async function reopen() {
    const c = window.prompt('Miksi palautetaan avoimeksi? (näkyy asiakkaalle)', '')
    if (c === null) return
    setBusy(true)
    const patch = { status: 'avoin', reopen_comment: c.trim() || 'Ei vielä korjattu', ack_at: null, ack_by: null, ack_by_name: null, ack_comment: null, ack_photo: null }
    const { error } = await sb.from('safety_observations').update(patch).eq('id', o.id)
    setBusy(false)
    if (error) { alert('Tallennus epäonnistui'); return }
    onDone?.({ ...o, ...patch })
  }
  return (
    <div className="kx-obs-card-foot">
      <button className="kx-btn-ghost kx-btn-sm" disabled={busy} onClick={reopen}>↩ Ei korjattu</button>
      <div style={{ display: 'flex', gap: 6 }}>
        <label className="kx-btn-ghost kx-btn-sm" style={{ cursor: 'pointer' }}>
          📷 Korjattu + jälkikuva
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) markFixed(f) }} />
        </label>
        <button className="kx-btn-primary kx-btn-sm" disabled={busy} onClick={() => markFixed(null)}>✓ Korjattu</button>
      </div>
    </div>
  )
}

export function Lightbox({ url, onClose }) {
  if (!url) return null
  return (
    <div className="kx-lightbox" onClick={onClose}>
      <img src={url} alt="" />
    </div>
  )
}

export const OBS_REVIEW_CSS = `
.kx-obs-title { font-size: 15px; font-weight: 800; color: #14183a; line-height: 1.35; }
.kx-obs-meta-row { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: #6a7086; }
.kx-obs-note { font-size: 13px; color: #3a3f5c; line-height: 1.5; background: #f9fafc; border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; }
.kx-photo-row { display: flex; gap: 8px; flex-wrap: wrap; }
.kx-photo { position: relative; width: 96px; height: 96px; border-radius: 8px; overflow: hidden; border: none; padding: 0; background: #e2e5ee; cursor: zoom-in; flex-shrink: 0; }
.kx-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.kx-photo-ph { display: flex; align-items: center; justify-content: center; height: 100%; opacity: .4; }
.kx-photo-label { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(23,39,92,.78); color: #fff; font-size: 10px; font-weight: 700; padding: 2px 0; text-align: center; }
.kx-photo-x { position: absolute; top: 3px; right: 3px; width: 22px; height: 22px; border-radius: 50%; border: none; background: rgba(0,0,0,.6); color: #fff; cursor: pointer; }
.kx-timeline { font-size: 12px; color: #3a3f5c; display: flex; flex-direction: column; gap: 3px; border-top: 1px solid #eef0f5; padding-top: 8px; line-height: 1.45; }
.kx-btn-ack { width: 100%; justify-content: center; background: #1a8a50; }
.kx-btn-ack:hover { background: #157443; }
.kx-ack-form { display: flex; flex-direction: column; gap: 8px; background: #f4f8f5; border: 1px solid rgba(26,138,80,0.3); border-radius: 10px; padding: 10px; }
.kx-ack-photo-row { display: flex; gap: 8px; align-items: center; }
.kx-hint { font-size: 11.5px; color: #6a7086; }
.kx-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.9); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 16px; cursor: zoom-out; }
.kx-lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; }
.kx-filter-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.kx-filter { padding: 7px 12px; border-radius: 20px; border: 1px solid #d3d6e0; background: #fff; font-size: 12.5px; font-weight: 700; color: #6a7086; cursor: pointer; }
.kx-filter.active { background: #17275c; border-color: #17275c; color: #fff; }
`
