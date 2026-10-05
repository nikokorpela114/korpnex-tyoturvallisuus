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

const sevColor = { Kriittinen: '#dc2626', Huomio: '#d97706', Info: '#059669' }
const fmt = d => d ? new Date(d).toLocaleDateString('fi-FI') : ''
const fmtDt = d => d ? new Date(d).toLocaleString('fi-FI', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export const STATUS = {
  avoin: { label: 'Avoin', color: '#dc2626', bg: 'rgba(220,38,38,0.1)' },
  kuitattu: { label: 'Odottaa tarkastusta', color: '#a65b00', bg: 'rgba(245,168,0,0.16)' },
  korjattu: { label: '✓ Korjattu', color: '#059669', bg: 'rgba(5,150,105,0.1)' },
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
          {showSite ? <b style={{ color: '#0a1428' }}>{o.site}</b> : 'Havainto'} · {fmt(o.created_at)}
        </span>
        <div className="kx-obs-tags">
          <span className="kx-tag" style={{ background: 'rgba(0,0,0,0.04)', color: sevColor[o.sev] }}>{o.sev}</span>
          <StatusTag status={o.status} />
        </div>
      </div>
      <div className="kx-obs-title">{o.havainto || '(ei kuvausta)'}</div>
      <div className="kx-obs-meta-row">
        {o.yritys && <span><b style={{ color: '#334155', fontWeight: 600 }}>{o.yritys}</b></span>}
        {o.luokka && <span className="kx-luokka">{o.luokka}</span>}
        {o.due_date && <span style={overdue(o) ? { color: '#dc2626', fontWeight: 700 } : undefined}>Korjattava {fmt(o.due_date)} mennessä{overdue(o) ? ' — myöhässä' : ''}</span>}
        {o.inspector && <span>Tarkastaja: {o.inspector}</span>}
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
        <div className="kx-tl-red">Merkitty {fmtDt(o.created_at)}{o.inspector ? ` · ${o.inspector}` : ''}</div>
        {o.reopen_comment && o.status === 'avoin' && <div className="kx-tl-red" style={{ color: '#dc2626' }}>Palautettu avoimeksi: {o.reopen_comment}</div>}
        {o.ack_at && <div className="kx-tl-amber">Kuitattu korjatuksi {fmtDt(o.ack_at)} · {o.ack_by_name}{o.ack_comment ? ` — "${o.ack_comment}"` : ''}</div>}
        {o.status === 'korjattu' && <div className="kx-tl-green">Korjaus varmistettu {fmtDt(o.fixed_at)}{o.fixed_by_name ? ` · ${o.fixed_by_name}` : ''}</div>}
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
.kx-obs-title { font-family: 'Jakarta', 'Inter', sans-serif; font-size: 16.5px; font-weight: 700; color: #0a1428; line-height: 1.35; letter-spacing: -.1px; }
.kx-obs-meta-row { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; color: #64748b; }
.kx-obs-note { font-size: 13.5px; color: #334155; line-height: 1.55; background: #f8fafc; border: 1px solid #eef1f6; border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; }
.kx-photo-row { display: flex; gap: 8px; flex-wrap: wrap; }
.kx-photo { position: relative; width: 108px; height: 108px; border-radius: 12px; overflow: hidden; border: 1px solid #e3e8ef; padding: 0; background: #eef1f6; cursor: zoom-in; flex-shrink: 0; transition: transform .15s, box-shadow .15s; }
.kx-photo:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(15,23,42,.12); }
.kx-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.kx-photo-ph { display: flex; align-items: center; justify-content: center; height: 100%; opacity: .4; }
.kx-photo-label { position: absolute; left: 6px; bottom: 6px; background: rgba(10,20,40,.78); backdrop-filter: blur(4px); color: #fff; font-size: 10.5px; font-weight: 700; padding: 3px 7px; border-radius: 6px; }
.kx-photo-x { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 50%; border: none; background: rgba(0,0,0,.6); color: #fff; cursor: pointer; }
.kx-timeline { list-style: none; font-size: 12.5px; color: #334155; display: flex; flex-direction: column; gap: 0; border-top: 1px solid #f1f4f9; padding-top: 12px; line-height: 1.45; }
.kx-timeline > div { position: relative; padding: 0 0 10px 20px; }
.kx-timeline > div:last-child { padding-bottom: 0; }
.kx-timeline > div::before { content: ''; position: absolute; left: 4px; top: 5px; width: 8px; height: 8px; border-radius: 50%; background: var(--dot, #cbd3df); box-shadow: 0 0 0 3px #fff, 0 0 0 4px var(--dot, #cbd3df); }
.kx-timeline > div:not(:last-child)::after { content: ''; position: absolute; left: 7.5px; top: 14px; bottom: 0; width: 1px; background: #e3e8ef; }
.kx-tl-red { --dot: #dc2626; } .kx-tl-amber { --dot: #d97706; } .kx-tl-green { --dot: #059669; }
.kx-btn-ack { width: 100%; justify-content: center; padding: 11px 16px; background: #059669 !important; border-color: #059669 !important; box-shadow: 0 1px 2px rgba(5,150,105,.3) !important; }
.kx-btn-ack:hover { background: #047857 !important; }
.kx-ack-form { display: flex; flex-direction: column; gap: 10px; background: #f0fdf7; border: 1px solid #a7e3cb; border-radius: 12px; padding: 12px; }
.kx-ack-photo-row { display: flex; gap: 8px; align-items: center; }
.kx-hint { font-size: 12px; color: #64748b; line-height: 1.5; }
.kx-lightbox { position: fixed; inset: 0; background: rgba(5,10,20,.92); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 20px; cursor: zoom-out; }
.kx-lightbox img { max-width: 100%; max-height: 100%; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.kx-luokka { background: #eef5ff; color: #0a5bb5; font-weight: 600; font-size: 11.5px; padding: 1px 8px; border-radius: 10px; }
.kx-filter-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
.kx-filter { padding: 7px 14px; border-radius: 20px; border: 1px solid #dbe1ea; background: #fff; font-size: 13px; font-weight: 600; color: #64748b; cursor: pointer; transition: all .15s; }
.kx-filter:hover:not(.active) { border-color: #cbd3df; color: #0f172a; }
.kx-filter.active { background: #0a1428; border-color: #0a1428; color: #fff; }
`
