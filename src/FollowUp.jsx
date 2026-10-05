// src/FollowUp.jsx — kenttäsovelluksen "Seuranta"-välilehti.
//
// Näyttää työmaan aiempien kierrosten avoimet ja asiakkaan kuittaamat
// havainnot. Uusintakäynnillä konsultti tarkistaa ne paikan päällä:
//   ✓ Korjattu   → ottaa jälkikuvan, tila korjattu (varmistettu)
//   ↩ Palauta    → kuitattu ei ollutkaan kunnossa, takaisin avoimeksi
import React, { useEffect, useState, useCallback } from 'react'
import { sb } from './supabaseClient.js'
import { compressImage } from './shared.js'
import { uploadPhoto, usePhotoUrls } from './photos.js'

const sevColor = { Kriittinen: '#d63030', Huomio: '#d07800', Info: '#1a8a50' }
const fmtDate = d => d ? new Date(d).toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric' }) : ''

export function useFollowUp(siteName, currentReportId) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const reload = useCallback(async () => {
    if (!siteName) { setRows([]); return }
    setLoading(true)
    const { data, error } = await sb.from('safety_observations')
      .select('*').eq('site', siteName).eq('archived', false).in('status', ['avoin', 'kuitattu'])
      .order('created_at', { ascending: true })
    setLoading(false)
    if (!error) setRows(data || [])
  }, [siteName])
  useEffect(() => { reload() }, [reload])
  const list = rows.filter(r => r.report_id !== currentReportId)
  // Kuitatut ensin — ne odottavat tarkastusta.
  list.sort((a, b) => (a.status === 'kuitattu' ? 0 : 1) - (b.status === 'kuitattu' ? 0 : 1))
  return { list, loading, reload, setRows }
}

export default function FollowUp({ list, loading, reload, setRows, worksiteId, inspectorName, isOnline }) {
  const [openId, setOpenId] = useState(null)
  const [afterPhoto, setAfterPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [lightbox, setLightbox] = useState(null)

  const allPaths = list.flatMap(o => [...(o.photos || []).map(p => p.path), o.ack_photo])
  const urls = usePhotoUrls(allPaths)

  function close() { setOpenId(null); setAfterPhoto(null); setErr('') }

  async function markFixed(o) {
    setErr(''); setBusy(true)
    try {
      let fixPath = null
      if (afterPhoto) fixPath = await uploadPhoto(o.worksite_id || worksiteId, afterPhoto)
      const patch = { status: 'korjattu', fixed_at: new Date().toISOString(), fixed_by_name: inspectorName || null, fix_photo: fixPath }
      const { error } = await sb.from('safety_observations').update(patch).eq('id', o.id)
      if (error) throw error
      setRows(prev => prev.filter(r => r.id !== o.id))
      close()
    } catch (e) {
      setErr(!navigator.onLine ? 'Ei verkkoyhteyttä — yritä kun yhteys palaa.' : 'Tallennus epäonnistui: ' + (e?.message || e))
    }
    setBusy(false)
  }

  async function reopen(o) {
    const comment = window.prompt('Miksi palautetaan avoimeksi? (näkyy asiakkaalle)', '')
    if (comment === null) return
    setBusy(true)
    const patch = { status: 'avoin', reopen_comment: comment.trim() || 'Ei vielä korjattu', ack_at: null, ack_by: null, ack_by_name: null, ack_comment: null, ack_photo: null }
    const { error } = await sb.from('safety_observations').update(patch).eq('id', o.id)
    setBusy(false)
    if (error) { alert('Tallennus epäonnistui — tarkista yhteys.'); return }
    setRows(prev => prev.map(r => r.id === o.id ? { ...r, ...patch } : r))
  }

  const waiting = list.filter(o => o.status === 'kuitattu').length

  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12.5, color: '#6a7086', lineHeight: 1.5 }}>
          Aiempien kierrosten avoimet puutteet.{waiting > 0 && <> <b style={{ color: '#d07800' }}>{waiting} odottaa tarkastustasi.</b></>}
        </div>
        <button onClick={reload} style={{ background: 'none', border: 'none', fontSize: 12, color: '#223a8c', fontWeight: 700 }}>🔄 Päivitä</button>
      </div>

      {!isOnline && <div style={warnBox}>⚠ Offline — lista voi olla vanhentunut.</div>}
      {loading && list.length === 0 && <div style={{ textAlign: 'center', color: '#6a7086', fontSize: 13, padding: 20 }}>Ladataan…</div>}
      {!loading && list.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 24px', color: '#6a7086' }}>
          <div style={{ fontSize: 44, marginBottom: 10, opacity: 0.35 }}>✅</div>
          <p style={{ fontSize: 14, lineHeight: 1.6 }}>Ei avoimia puutteita aiemmilta kierroksilta.</p>
        </div>
      )}

      {list.map(o => {
        const open = openId === o.id
        const isAck = o.status === 'kuitattu'
        return (
          <div key={o.id} style={{ background: '#fff', border: `1px solid ${isAck ? '#f0c36d' : '#d3d6e0'}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: sevColor[o.sev] || '#999', marginTop: 5, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#14183a' }}>{o.havainto || '(ei kuvausta)'}</div>
                <div style={{ fontSize: 11.5, color: '#6a7086', marginTop: 2 }}>
                  {[o.yritys, `merkitty ${fmtDate(o.created_at)}`, o.due_date && `määräaika ${fmtDate(o.due_date)}`].filter(Boolean).join(' · ')}
                </div>
                {o.note && <div style={{ fontSize: 12.5, color: '#3a3f5c', marginTop: 4 }}>{o.note}</div>}
              </div>
              <StatusBadge status={o.status} />
            </div>

            {(o.photos || []).length > 0 && (
              <div style={{ display: 'flex', gap: 6, padding: '0 12px 10px', overflowX: 'auto' }}>
                {o.photos.map(p => <Thumb key={p.path} url={urls[p.path]} label="Ennen" onClick={() => setLightbox(urls[p.path])} />)}
              </div>
            )}

            {isAck && (
              <div style={{ margin: '0 12px 10px', background: '#fff8e6', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: '#7a5b00', display: 'flex', gap: 8 }}>
                {o.ack_photo && <Thumb url={urls[o.ack_photo]} label="Asiakas" small onClick={() => setLightbox(urls[o.ack_photo])} />}
                <div><b>{o.ack_by_name}</b> kuittasi korjatuksi {fmtDate(o.ack_at)}{o.ack_comment ? `: "${o.ack_comment}"` : ''}</div>
              </div>
            )}
            {o.reopen_comment && o.status === 'avoin' && (
              <div style={{ margin: '0 12px 10px', fontSize: 12, color: '#d63030' }}>↩ Palautettu: {o.reopen_comment}</div>
            )}

            {!open ? (
              <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px' }}>
                <button onClick={() => { setOpenId(o.id); setAfterPhoto(null); setErr('') }} style={btnOk}>✓ Korjattu</button>
                {isAck && <button onClick={() => reopen(o)} disabled={busy} style={btnGhost}>↩ Ei korjattu</button>}
              </div>
            ) : (
              <div style={{ borderTop: '1px solid #eef0f5', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: '#f9fafc' }}>
                <div style={{ fontSize: 12.5, color: '#3a3f5c', fontWeight: 700 }}>Jälkikuva korjatusta kohdasta</div>
                {afterPhoto ? (
                  <div style={{ position: 'relative', width: 120, height: 120, borderRadius: 8, overflow: 'hidden' }}>
                    <img src={afterPhoto} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <button onClick={() => setAfterPhoto(null)} style={{ position: 'absolute', top: 3, right: 3, background: 'rgba(0,0,0,.6)', border: 'none', color: '#fff', borderRadius: '50%', width: 22, height: 22 }}>×</button>
                  </div>
                ) : (
                  <label style={{ ...btnGhost, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' }}>
                    📷 Ota jälkikuva
                    <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                      onChange={async e => { const f = e.target.files?.[0]; if (f) setAfterPhoto(await compressImage(f, 1280, 0.72)); e.target.value = '' }} />
                  </label>
                )}
                {err && <div style={{ fontSize: 12.5, color: '#d63030' }}>{err}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => markFixed(o)} disabled={busy} style={btnOk}>{busy ? 'Tallennetaan…' : afterPhoto ? '✓ Merkitse korjatuksi' : '✓ Korjattu ilman kuvaa'}</button>
                  <button onClick={close} style={btnGhost}>Peruuta</button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.9)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
          <img src={lightbox} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8 }} />
        </div>
      )}
    </div>
  )
}

export function StatusBadge({ status }) {
  const s = {
    avoin: ['Avoin', '#d63030', 'rgba(214,48,48,0.1)'],
    kuitattu: ['Odottaa tarkastusta', '#a65b00', 'rgba(245,168,0,0.16)'],
    korjattu: ['✓ Korjattu', '#1a8a50', 'rgba(26,138,80,0.1)'],
  }[status] || ['Avoin', '#d63030', 'rgba(214,48,48,0.1)']
  return <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 20, color: s[1], background: s[2], whiteSpace: 'nowrap', flexShrink: 0 }}>{s[0]}</span>
}

function Thumb({ url, label, onClick, small }) {
  const size = small ? 54 : 76
  return (
    <button onClick={onClick} style={{ position: 'relative', width: size, height: size, flexShrink: 0, borderRadius: 8, overflow: 'hidden', border: 'none', padding: 0, background: '#e2e5ee' }}>
      {url && <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      {label && <span style={{ position: 'absolute', left: 0, bottom: 0, right: 0, background: 'rgba(23,39,92,.75)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 0' }}>{label}</span>}
    </button>
  )
}

const btnOk = { flex: 1, padding: '10px 8px', borderRadius: 8, border: '1px solid #1a8a50', background: 'rgba(26,138,80,0.1)', color: '#1a8a50', fontWeight: 700, fontSize: 13 }
const btnGhost = { flex: 1, padding: '10px 8px', borderRadius: 8, border: '1px solid #d3d6e0', background: '#eef0f5', color: '#3a3f5c', fontWeight: 700, fontSize: 13 }
const warnBox = { background: '#fff3cd', border: '1px solid #f0c36d', borderRadius: 10, padding: '8px 12px', fontSize: 12.5, color: '#7a5b00' }
