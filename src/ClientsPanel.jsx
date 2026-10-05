// src/ClientsPanel.jsx — Valvomon Asiakkaat-näkymä (vain konsultti).
//
// Asiakasyritykset, niiden työmaat ja käyttäjät. Käyttäjä kutsutaan
// sähköpostilla (tt-admin -Edge Function): hän saa linkin, josta asettaa
// oman salasanansa, ja näkee sen jälkeen vain oman yrityksensä työmaat.
import React, { useEffect, useState, useCallback } from 'react'
import { sb } from './supabaseClient.js'

async function callAdmin(body) {
  const { data, error } = await sb.functions.invoke('tt-admin', { body })
  if (error) {
    let msg = error.message
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch { /* ei väliä */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export default function ClientsPanel({ onSitesChanged, showToast }) {
  const [clients, setClients] = useState([])
  const [sites, setSites] = useState([])
  const [users, setUsers] = useState([])
  const [usersErr, setUsersErr] = useState('')
  const [newName, setNewName] = useState('')
  const [newY, setNewY] = useState('')
  const [invite, setInvite] = useState({}) // clientId -> { name, email, busy }

  const load = useCallback(async () => {
    const [c, w] = await Promise.all([
      sb.from('clients').select('*').eq('archived', false).order('name'),
      sb.from('worksites').select('id, name, client_id, archived').eq('archived', false).order('name'),
    ])
    setClients(c.data || []); setSites(w.data || [])
    try { const r = await callAdmin({ action: 'list' }); setUsers(r.users || []); setUsersErr('') }
    catch (e) { setUsersErr(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  async function addClient() {
    const name = newName.trim()
    if (!name) return
    const { error } = await sb.from('clients').insert([{ name, y_tunnus: newY.trim() || null }])
    if (error) { showToast('⚠ Lisäys epäonnistui'); return }
    setNewName(''); setNewY(''); showToast('✓ Asiakas lisätty'); load()
  }

  async function archiveClient(c) {
    if (!window.confirm(`Arkistoidaanko asiakas "${c.name}"? Sen käyttäjät eivät enää näe työmaita (työmaat ja data säilyvät).`)) return
    await sb.from('worksites').update({ client_id: null }).eq('client_id', c.id)
    const { error } = await sb.from('clients').update({ archived: true }).eq('id', c.id)
    if (error) { showToast('⚠ Arkistointi epäonnistui'); return }
    showToast('🗄 Asiakas arkistoitu'); load(); onSitesChanged?.()
  }

  async function setSiteClient(siteId, clientId) {
    const { error } = await sb.from('worksites').update({ client_id: clientId }).eq('id', siteId)
    if (error) { showToast('⚠ Tallennus epäonnistui'); return }
    load(); onSitesChanged?.()
  }

  async function sendInvite(c) {
    const f = invite[c.id] || {}
    if (!f.email?.trim()) { showToast('⚠ Anna sähköposti'); return }
    setInvite(p => ({ ...p, [c.id]: { ...f, busy: true } }))
    try {
      const r = await callAdmin({ action: 'invite', email: f.email.trim(), name: (f.name || '').trim(), client_id: c.id })
      setInvite(p => ({ ...p, [c.id]: {} }))
      showToast(r.emailed ? '✓ Kutsu lähetetty sähköpostiin' : `⚠ Tunnus luotu, mutta sähköposti ei lähtenyt: ${r.emailError}`)
      load()
    } catch (e) {
      setInvite(p => ({ ...p, [c.id]: { ...f, busy: false } }))
      showToast('⚠ ' + e.message)
    }
  }

  async function resend(u) {
    try { await callAdmin({ action: 'resend', user_id: u.id }); showToast('✓ Uusi linkki lähetetty') }
    catch (e) { showToast('⚠ ' + e.message) }
  }
  async function remove(u) {
    if (!window.confirm(`Poistetaanko käyttäjän ${u.email} tunnus? Hän ei pääse enää portaaliin.`)) return
    try { await callAdmin({ action: 'remove', user_id: u.id }); showToast('🗑 Tunnus poistettu'); load() }
    catch (e) { showToast('⚠ ' + e.message) }
  }

  const unassigned = sites.filter(s => !s.client_id)
  const consultants = users.filter(u => u.role === 'konsultti')

  return (
    <div className="kx-clients">
      <div className="kx-card">
        <div className="kx-card-title">Uusi asiakasyritys</div>
        <div className="kx-note-row" style={{ flexWrap: 'wrap' }}>
          <input className="kx-input" style={{ flex: 2, minWidth: 180 }} placeholder="Yrityksen nimi" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addClient()} />
          <input className="kx-input" style={{ flex: 1, minWidth: 120 }} placeholder="Y-tunnus (valinnainen)" value={newY} onChange={e => setNewY(e.target.value)} onKeyDown={e => e.key === 'Enter' && addClient()} />
          <button className="kx-btn-primary" onClick={addClient}>＋ Lisää</button>
        </div>
        <div className="kx-hint" style={{ marginTop: 8 }}>
          1) Lisää asiakas → 2) liitä sen työmaat → 3) kutsu käyttäjät. Asiakas näkee vain omien työmaidensa tiedot.
        </div>
      </div>

      {usersErr && <div className="kx-error">Käyttäjälistan haku epäonnistui: {usersErr}</div>}

      {clients.length === 0 && <div className="kx-empty-note">Ei vielä asiakkaita.</div>}

      {clients.map(c => {
        const cSites = sites.filter(s => s.client_id === c.id)
        const cUsers = users.filter(u => u.client_id === c.id)
        const f = invite[c.id] || {}
        return (
          <div key={c.id} className="kx-card kx-client-card">
            <div className="kx-measure-row-head">
              <div>
                <div className="kx-main-title" style={{ fontSize: 17 }}>{c.name}</div>
                {c.y_tunnus && <div className="kx-main-sub">Y-tunnus {c.y_tunnus}</div>}
              </div>
              <button className="kx-btn-ghost kx-btn-sm" onClick={() => archiveClient(c)}>🗄 Arkistoi</button>
            </div>

            <div className="kx-label" style={{ marginTop: 12 }}>Työmaat ({cSites.length})</div>
            <div className="kx-chip-row">
              {cSites.map(s => (
                <span key={s.id} className="kx-chip">{s.name}<button onClick={() => setSiteClient(s.id, null)} title="Irrota">×</button></span>
              ))}
              {unassigned.length > 0 && (
                <select className="kx-input kx-input-sm" style={{ width: 'auto' }} value="" onChange={e => e.target.value && setSiteClient(Number(e.target.value), c.id)}>
                  <option value="">＋ Liitä työmaa…</option>
                  {unassigned.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              {cSites.length === 0 && unassigned.length === 0 && <span className="kx-hint">Ei vapaita työmaita — lisää työmaa ensin.</span>}
            </div>

            <div className="kx-label" style={{ marginTop: 14 }}>Käyttäjät ({cUsers.length})</div>
            <div className="kx-user-list">
              {cUsers.map(u => (
                <div key={u.id} className="kx-user-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="kx-user-name">{u.name || u.email}</div>
                    <div className="kx-user-sub">{u.email} · {u.last_sign_in_at ? `kirjautunut ${new Date(u.last_sign_in_at).toLocaleDateString('fi-FI')}` : 'ei vielä kirjautunut'}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="kx-btn-ghost kx-btn-sm" onClick={() => resend(u)} title="Lähetä uusi salasanalinkki">✉ Uusi linkki</button>
                    <button className="kx-icon-btn" onClick={() => remove(u)} title="Poista tunnus">🗑</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="kx-note-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <input className="kx-input kx-input-sm" style={{ flex: 1, minWidth: 140 }} placeholder="Nimi" value={f.name || ''} onChange={e => setInvite(p => ({ ...p, [c.id]: { ...f, name: e.target.value } }))} />
              <input className="kx-input kx-input-sm" style={{ flex: 1.4, minWidth: 180 }} type="email" placeholder="sähköposti@yritys.fi" value={f.email || ''} onChange={e => setInvite(p => ({ ...p, [c.id]: { ...f, email: e.target.value } }))} onKeyDown={e => e.key === 'Enter' && sendInvite(c)} />
              <button className="kx-btn-primary kx-btn-sm" disabled={f.busy} onClick={() => sendInvite(c)}>{f.busy ? 'Lähetetään…' : '✉ Kutsu käyttäjä'}</button>
            </div>
          </div>
        )
      })}

      {consultants.length > 0 && (
        <div className="kx-card">
          <div className="kx-card-title">Korpnex (konsultit)</div>
          {consultants.map(u => (
            <div key={u.id} className="kx-user-row"><div><div className="kx-user-name">{u.name || u.email}</div><div className="kx-user-sub">{u.email}</div></div></div>
          ))}
        </div>
      )}
    </div>
  )
}

export const CLIENTS_CSS = `
.kx-clients { display: flex; flex-direction: column; gap: 16px; max-width: 980px; }
.kx-chip-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
.kx-chip { display: inline-flex; align-items: center; gap: 4px; background: #eef5ff; border: 1px solid #cfe3fb; border-radius: 20px; padding: 4px 6px 4px 12px; font-size: 13px; font-weight: 600; color: #0a3d7a; }
.kx-chip button { background: none; border: none; color: #5b8cc4; font-size: 15px; cursor: pointer; padding: 0 4px; border-radius: 50%; }
.kx-chip button:hover { color: #dc2626; }
.kx-user-list { display: flex; flex-direction: column; margin-top: 6px; }
.kx-user-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f1f4f9; }
.kx-user-name { font-size: 14px; font-weight: 600; color: #0f172a; }
.kx-user-sub { font-size: 12px; color: #64748b; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.kx-client-card .kx-label { margin-top: 18px !important; }
`
