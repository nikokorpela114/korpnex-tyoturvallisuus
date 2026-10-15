// src/WorkRegistry.jsx — Työajat: laskutusasiakkaat ja -työmaat.
//
// Erillään turvallisuuspuolen Asiakkaat/Työmaat-osioista (taulut wl_clients,
// wl_sites). Kun työpäivälle valitaan työmaa, asiakas, hinnat, km ja
// ALV-käsittely täyttyvät näistä automaattisesti.
import React, { useEffect, useState } from 'react'
import { sb } from './supabaseClient.js'
import { KIND_LABELS, VAT_MODE_LABELS, num, fmtEur, fmtNum, clientInfoLines } from './worklog.js'

const str = v => (v === null || v === undefined ? '' : String(v).replace('.', ','))
const numOrNull = v => (String(v ?? '').trim() === '' ? null : num(v))

// --- Asiakaslomake ------------------------------------------------------------
export function ClientModal({ client, onClose, onSaved, showToast, settings }) {
  const [d, setD] = useState(() => ({
    name: client?.name || '', business_id: client?.business_id || '', address: client?.address || '',
    einvoice: client?.einvoice || '', email: client?.email || '', contact: client?.contact || '',
    hourly_rate: str(client?.hourly_rate), km_rate: str(client?.km_rate),
    vat_mode: client?.vat_mode || 'kaannetty', notes: client?.notes || '',
    bill_per_diem: !!client?.bill_per_diem,
  }))
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setD(x => ({ ...x, [k]: v }))

  async function save() {
    if (!d.name.trim()) { showToast('⚠ Kirjoita asiakkaan nimi'); return }
    const row = {
      name: d.name.trim(), business_id: d.business_id.trim() || null, address: d.address.trim() || null,
      einvoice: d.einvoice.trim() || null, email: d.email.trim() || null, contact: d.contact.trim() || null,
      hourly_rate: numOrNull(d.hourly_rate), km_rate: numOrNull(d.km_rate), vat_mode: d.vat_mode,
      notes: d.notes.trim() || null, bill_per_diem: d.bill_per_diem,
    }
    setSaving(true)
    const res = client?.id
      ? await sb.from('wl_clients').update(row).eq('id', client.id).select()
      : await sb.from('wl_clients').insert([row]).select()
    setSaving(false)
    if (res.error) { console.error('wl_clients save failed:', res.error); showToast('⚠ Tallennus epäonnistui'); return }
    showToast(client?.id ? '✓ Asiakas päivitetty' : '✓ Asiakas lisätty')
    onSaved(res.data?.[0])
  }

  async function archive() {
    if (!window.confirm(`Arkistoidaanko asiakas ${client.name}? Vanhat kirjaukset säilyvät.`)) return
    const { error } = await sb.from('wl_clients').update({ archived: true }).eq('id', client.id)
    if (error) { showToast('⚠ Arkistointi epäonnistui'); return }
    await sb.from('wl_sites').update({ archived: true }).eq('client_id', client.id)
    showToast('🗄 Asiakas arkistoitu'); onSaved(null)
  }

  return (
    <div className="kx-wl-overlay" onClick={() => !saving && onClose()}>
      <div className="kx-wl-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={client?.id ? 'Muokkaa asiakasta' : 'Uusi asiakas'}>
        <div className="kx-wl-modal-head">
          <div className="kx-modal-title">{client?.id ? 'Muokkaa asiakasta' : 'Uusi asiakas'}</div>
          <button className="kx-icon-btn" onClick={onClose} aria-label="Sulje">✕</button>
        </div>
        <div className="kx-wl-grid">
          <label className="kx-wl-field kx-wl-wide"><span>Nimi</span>
            <input className="kx-input" placeholder="esim. Zaumax Oy" value={d.name} onChange={e => set('name', e.target.value)} autoFocus /></label>
          <label className="kx-wl-field"><span>Y-tunnus</span>
            <input className="kx-input" placeholder="1234567-8" value={d.business_id} onChange={e => set('business_id', e.target.value)} /></label>
          <label className="kx-wl-field"><span>Yhteyshenkilö</span>
            <input className="kx-input" placeholder="esim. Jaakko" value={d.contact} onChange={e => set('contact', e.target.value)} /></label>
          <label className="kx-wl-field kx-wl-wide"><span>Laskutusosoite</span>
            <textarea className="kx-input" rows={2} placeholder={'Katuosoite 1\n60100 Seinäjoki'} value={d.address} onChange={e => set('address', e.target.value)} /></label>
          <label className="kx-wl-field"><span>Verkkolaskuosoite</span>
            <input className="kx-input" placeholder="OVT / välittäjä" value={d.einvoice} onChange={e => set('einvoice', e.target.value)} /></label>
          <label className="kx-wl-field"><span>Laskutussähköposti</span>
            <input className="kx-input" type="email" inputMode="email" value={d.email} onChange={e => set('email', e.target.value)} /></label>
          <label className="kx-wl-field"><span>Tuntihinta € (alv 0)</span>
            <input className="kx-input" inputMode="decimal" placeholder={str(settings.hourlyRate)} value={d.hourly_rate} onChange={e => set('hourly_rate', e.target.value)} /></label>
          <label className="kx-wl-field"><span>Km-hinta €</span>
            <input className="kx-input" inputMode="decimal" placeholder={str(settings.kmRate)} value={d.km_rate} onChange={e => set('km_rate', e.target.value)} /></label>
          <label className="kx-wl-field kx-wl-wide"><span>ALV-käsittely</span>
            <select className="kx-input" value={d.vat_mode} onChange={e => set('vat_mode', e.target.value)}>
              {Object.entries(VAT_MODE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select></label>
          <label className="kx-checkbox-row kx-wl-wide" style={{ margin: 0 }}>
            <input type="checkbox" checked={d.bill_per_diem} onChange={e => set('bill_per_diem', e.target.checked)} />
            Päivärahat laskutetaan tältä asiakkaalta (sovittu)
          </label>
          <div className="kx-hint kx-wl-wide">Käännetty ALV, kun asiakas myy itse rakentamispalveluja (esim. urakoitsija). Konsultointi laskutetaan aina alv 25,5 %.</div>
          <label className="kx-wl-field kx-wl-wide"><span>Muistiinpano</span>
            <input className="kx-input" value={d.notes} onChange={e => set('notes', e.target.value)} /></label>
        </div>
        <div className="kx-modal-actions">
          {client?.id && <button className="kx-btn-ghost" style={{ marginRight: 'auto', color: '#b91c1c' }} onClick={archive}>🗄 Arkistoi</button>}
          <button className="kx-btn-ghost" disabled={saving} onClick={onClose}>Peruuta</button>
          <button className="kx-btn-primary" disabled={saving} onClick={save}>{saving ? 'Tallennetaan…' : 'Tallenna'}</button>
        </div>
      </div>
    </div>
  )
}

// --- Työmaalomake -------------------------------------------------------------
export function SiteModal({ site, clients, defaultClientId, onClose, onSaved, onNewClient, showToast }) {
  const [d, setD] = useState(() => ({
    name: site?.name || '', address: site?.address || '', km: str(site?.km),
    kind: site?.kind || 'tunti', notes: site?.notes || '',
    client_id: site?.client_id || defaultClientId || clients[0]?.id || '',
  }))
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setD(x => ({ ...x, [k]: v }))
  // Juuri lisätty asiakas valitaan automaattisesti
  useEffect(() => { if (defaultClientId) setD(x => ({ ...x, client_id: defaultClientId })) }, [defaultClientId])
  useEffect(() => { if (!d.client_id && clients[0]) setD(x => ({ ...x, client_id: clients[0].id })) }, [clients, d.client_id])

  async function save() {
    if (!d.name.trim()) { showToast('⚠ Kirjoita työmaan nimi'); return }
    if (!d.client_id) { showToast('⚠ Valitse asiakas'); return }
    const row = {
      name: d.name.trim(), address: d.address.trim() || null, km: numOrNull(d.km),
      kind: d.kind, notes: d.notes.trim() || null, client_id: Number(d.client_id),
    }
    setSaving(true)
    const res = site?.id
      ? await sb.from('wl_sites').update(row).eq('id', site.id).select()
      : await sb.from('wl_sites').insert([row]).select()
    setSaving(false)
    if (res.error) { console.error('wl_sites save failed:', res.error); showToast('⚠ Tallennus epäonnistui'); return }
    showToast(site?.id ? '✓ Työmaa päivitetty' : '✓ Työmaa lisätty')
    onSaved(res.data?.[0])
  }

  async function archive() {
    if (!window.confirm(`Arkistoidaanko työmaa ${site.name}? Vanhat kirjaukset säilyvät.`)) return
    const { error } = await sb.from('wl_sites').update({ archived: true }).eq('id', site.id)
    if (error) { showToast('⚠ Arkistointi epäonnistui'); return }
    showToast('🗄 Työmaa arkistoitu'); onSaved(null)
  }

  return (
    <div className="kx-wl-overlay" onClick={() => !saving && onClose()}>
      <div className="kx-wl-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={site?.id ? 'Muokkaa työmaata' : 'Uusi työmaa'}>
        <div className="kx-wl-modal-head">
          <div className="kx-modal-title">{site?.id ? 'Muokkaa työmaata' : 'Uusi työmaa'}</div>
          <button className="kx-icon-btn" onClick={onClose} aria-label="Sulje">✕</button>
        </div>
        <div className="kx-wl-grid">
          <label className="kx-wl-field kx-wl-wide"><span>Työmaan nimi</span>
            <input className="kx-input" placeholder="esim. Kauhajoen Atria laajennus" value={d.name} onChange={e => set('name', e.target.value)} autoFocus /></label>
          <label className="kx-wl-field kx-wl-wide"><span>Asiakas</span>
            {clients.length ? (
              <div className="kx-wl-inline-row">
                <select className="kx-input" value={d.client_id} onChange={e => set('client_id', e.target.value)}>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {onNewClient && <button className="kx-btn-ghost kx-btn-sm" onClick={onNewClient}>＋ Uusi</button>}
              </div>
            ) : (
              <button className="kx-btn-ghost" onClick={onNewClient}>＋ Lisää ensin asiakas</button>
            )}</label>
          <label className="kx-wl-field kx-wl-wide"><span>Osoite</span>
            <input className="kx-input" placeholder="esim. Atriantie 1, Kauhajoki" value={d.address} onChange={e => set('address', e.target.value)} /></label>
          <label className="kx-wl-field"><span>Km kotoa (meno-paluu)</span>
            <input className="kx-input" inputMode="decimal" placeholder="esim. 116" value={d.km} onChange={e => set('km', e.target.value)} /></label>
          <label className="kx-wl-field"><span>Oletustyyppi</span>
            <select className="kx-input" value={d.kind} onChange={e => set('kind', e.target.value)}>
              {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select></label>
          <label className="kx-wl-field kx-wl-wide"><span>Muistiinpano</span>
            <input className="kx-input" placeholder="esim. avain työmaatoimistosta" value={d.notes} onChange={e => set('notes', e.target.value)} /></label>
        </div>
        <div className="kx-modal-actions">
          {site?.id && <button className="kx-btn-ghost" style={{ marginRight: 'auto', color: '#b91c1c' }} onClick={archive}>🗄 Arkistoi</button>}
          <button className="kx-btn-ghost" disabled={saving} onClick={onClose}>Peruuta</button>
          <button className="kx-btn-primary" disabled={saving} onClick={save}>{saving ? 'Tallennetaan…' : 'Tallenna'}</button>
        </div>
      </div>
    </div>
  )
}

// --- Rekisterinäkymä ----------------------------------------------------------
export default function WorkRegistry({ clients, sites, onEditClient, onEditSite }) {
  const active = clients.filter(c => !c.archived)
  if (!active.length) {
    return (
      <div className="kx-empty-note">
        Ei vielä asiakkaita. Lisää asiakas ja sen työmaat, niin työpäivän kirjauksessa riittää valita työmaa.<br />
        <button className="kx-btn-primary" style={{ marginTop: 12 }} onClick={() => onEditClient({})}>＋ Lisää asiakas</button>
      </div>
    )
  }
  return (
    <>
      <div className="kx-wl-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="kx-btn-primary kx-btn-sm" onClick={() => onEditClient({})}>＋ Asiakas</button>
      </div>
      {active.map(c => {
        const own = sites.filter(s => s.client_id === c.id && !s.archived)
        const info = clientInfoLines(c)
        return (
          <div key={c.id} className="kx-card">
            <div className="kx-wl-invoice-head">
              <div style={{ minWidth: 0 }}>
                <div className="kx-card-title" style={{ margin: 0 }}>{c.name}</div>
                <div className="kx-main-sub">
                  {info.length ? info.join(' · ') : <span className="kx-wl-due">Y-tunnus ja laskutusosoite puuttuvat</span>}
                </div>
                <div className="kx-wl-period" style={{ marginTop: 4 }}>
                  {c.hourly_rate != null ? `${fmtEur(c.hourly_rate)}/h` : 'Oletustuntihinta'}
                  {c.km_rate != null && ` · ${fmtEur(c.km_rate)}/km`}
                  {` · ${c.vat_mode === 'alv' ? 'ALV 25,5 %' : 'käännetty ALV'}`}
                  {c.bill_per_diem && ' · päivärahat laskutetaan'}
                  {c.contact && ` · ${c.contact}`}
                </div>
              </div>
              <div className="kx-wl-actions">
                <button className="kx-btn-ghost kx-btn-sm" onClick={() => onEditClient(c)}>✏️ Muokkaa</button>
                <button className="kx-btn-ghost kx-btn-sm" onClick={() => onEditSite({ client_id: c.id })}>＋ Työmaa</button>
              </div>
            </div>
            {own.length === 0 ? (
              <div className="kx-wl-period">Ei työmaita.</div>
            ) : (
              <div className="kx-wl-list">
                {own.map(s => (
                  <div key={s.id} className="kx-wl-row">
                    <button className="kx-wl-row-main" onClick={() => onEditSite(s)}>
                      <div className="kx-wl-row-body">
                        <div className="kx-wl-row-title">🏗 {s.name}</div>
                        <div className="kx-wl-row-sub">
                          <span className={`kx-wl-kind kx-wl-kind-${s.kind}`}>{KIND_LABELS[s.kind]}</span>
                          {[s.address, s.km != null && `${fmtNum(num(s.km))} km meno-paluu`].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </button>
                    <button className="kx-btn-ghost kx-btn-sm kx-wl-edit" onClick={() => onEditSite(s)} aria-label="Muokkaa työmaata">✏️</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
