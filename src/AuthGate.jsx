// src/AuthGate.jsx — Korpnex Työturvallisuus: kirjautuminen
//
// Kaikki näkymät (kenttäsovellus ja Valvomo/asiakasportaali) ovat tämän
// takana. Rekisteröitymistä ei ole: Korpnex luo asiakkaan tunnukset
// Valvomon Asiakkaat-välilehdeltä ja käyttäjä saa sähköpostiin linkin,
// josta hän asettaa oman salasanansa.
//
// Käyttö:  <AuthGate>{({ session, profile, logout }) => ...}</AuthGate>
import React, { useState, useEffect, useCallback } from 'react'
import { sb } from './supabaseClient.js'

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined) // undefined = ladataan
  const [profile, setProfile] = useState(undefined)
  const [mode, setMode] = useState(() =>
    typeof window !== 'undefined' && /type=recovery/.test(window.location.hash) ? 'recovery' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const loadProfile = useCallback(async (userId) => {
    const { data } = await sb.from('profiles').select('id, email, name, role, client_id').eq('id', userId).maybeSingle()
    setProfile(data || null)
  }, [])

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      const s = data.session || null
      setSession(s)
      if (s) loadProfile(s.user.id); else setProfile(null)
    })
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setMode('recovery')
      setSession(s || null)
      if (s) loadProfile(s.user.id); else setProfile(null)
    })
    return () => sub.subscription.unsubscribe()
  }, [loadProfile])

  async function logout() {
    await sb.auth.signOut()
    setProfile(null); setSession(null); setMode('login')
  }

  async function login(e) {
    e?.preventDefault()
    setErr(''); setMsg(''); setBusy(true)
    const { error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
    setBusy(false)
    if (error) setErr(/invalid/i.test(error.message) ? 'Väärä sähköposti tai salasana.' : error.message)
  }

  async function sendReset(e) {
    e?.preventDefault()
    setErr(''); setMsg('')
    if (!email.trim()) { setErr('Kirjoita sähköpostiosoitteesi.'); return }
    setBusy(true)
    const { error } = await sb.functions.invoke('tt-admin', { body: { action: 'forgot', email: email.trim() } })
    setBusy(false)
    if (error) setErr('Lähetys epäonnistui, yritä hetken päästä uudelleen.')
    else setMsg('✓ Jos osoitteella on tunnus, sinne lähti linkki salasanan vaihtoon.')
  }

  async function saveNewPassword(e) {
    e?.preventDefault()
    setErr('')
    if (newPw.length < 8) { setErr('Salasanan pitää olla vähintään 8 merkkiä.'); return }
    if (newPw !== newPw2) { setErr('Salasanat eivät täsmää.'); return }
    setBusy(true)
    const { error } = await sb.auth.updateUser({ password: newPw })
    setBusy(false)
    if (error) { setErr(error.message); return }
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search) } catch { /* ei väliä */ }
    setNewPw(''); setNewPw2('')
    setMode('login')
    setMsg('✓ Salasana tallennettu.')
  }

  // --- Lataus ---
  if (session === undefined || (session && profile === undefined)) {
    return <Shell><div style={{ textAlign: 'center', color: '#64748b', fontSize: 14 }}>Ladataan…</div></Shell>
  }

  // --- Salasanan asetus (kutsu- tai palautuslinkistä) ---
  if (mode === 'recovery' && session) {
    return (
      <Shell>
        <form onSubmit={saveNewPassword} style={formStyle}>
          <h1 style={h1}>Aseta salasana</h1>
          <p style={pStyle}>{session.user.email}</p>
          <input style={input} type="password" autoComplete="new-password" placeholder="Uusi salasana (väh. 8 merkkiä)" value={newPw} onChange={e => setNewPw(e.target.value)} autoFocus />
          <input style={input} type="password" autoComplete="new-password" placeholder="Salasana uudelleen" value={newPw2} onChange={e => setNewPw2(e.target.value)} />
          {err && <div style={errStyle}>{err}</div>}
          <button style={primary} disabled={busy}>{busy ? 'Tallennetaan…' : 'Tallenna ja jatka'}</button>
        </form>
      </Shell>
    )
  }

  // --- Kirjautunut ---
  if (session) {
    if (!profile) {
      return (
        <Shell>
          <div style={formStyle}>
            <h1 style={h1}>Tunnusta ei ole liitetty</h1>
            <p style={pStyle}>Tunnuksella <b>{session.user.email}</b> ei ole vielä pääsyä portaaliin. Ota yhteyttä Korpnexiin.</p>
            <button style={secondary} onClick={logout}>Kirjaudu ulos</button>
          </div>
        </Shell>
      )
    }
    return <>{children({ session, profile, logout })}</>
  }

  // --- Kirjautuminen / unohtunut salasana ---
  return (
    <Shell>
      {mode === 'forgot' ? (
        <form onSubmit={sendReset} style={formStyle}>
          <h1 style={h1}>Unohtunut salasana</h1>
          <p style={pStyle}>Lähetämme sähköpostiisi linkin, jolla voit asettaa uuden salasanan.</p>
          <input style={input} type="email" autoComplete="email" placeholder="Sähköposti" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
          {err && <div style={errStyle}>{err}</div>}
          {msg && <div style={okStyle}>{msg}</div>}
          <button style={primary} disabled={busy}>{busy ? 'Lähetetään…' : 'Lähetä linkki'}</button>
          <button type="button" style={linkBtn} onClick={() => { setMode('login'); setErr(''); setMsg('') }}>← Takaisin kirjautumiseen</button>
        </form>
      ) : (
        <form onSubmit={login} style={formStyle}>
          <h1 style={h1}>Kirjaudu</h1>
          <p style={pStyle}>Työmaidesi turvallisuushavainnot, TR-/MVR-mittaukset ja avoimet puutteet yhdessä paikassa.</p>
          <input style={input} type="email" autoComplete="username" placeholder="Sähköposti" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
          <input style={input} type="password" autoComplete="current-password" placeholder="Salasana" value={password} onChange={e => setPassword(e.target.value)} />
          {err && <div style={errStyle}>{err}</div>}
          {msg && <div style={okStyle}>{msg}</div>}
          <button style={primary} disabled={busy}>{busy ? 'Kirjaudutaan…' : 'Kirjaudu'}</button>
          <button type="button" style={linkBtn} onClick={() => { setMode('forgot'); setErr(''); setMsg('') }}>Unohditko salasanan?</button>
        </form>
      )}
      <p style={{ ...pStyle, fontSize: 12, marginTop: 22, textAlign: 'center', color: 'rgba(255,255,255,.55)' }}>
        Portaali on Korpnexin työturvallisuuspalveluiden asiakkaille.<br />
        Tunnukset saat Korpnexilta · <a href="https://korpnex.fi" style={{ color: '#7cc8ff' }}>korpnex.fi</a>
      </p>
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', background: 'radial-gradient(ellipse at 80% 0%, rgba(8,120,232,.35), transparent 55%), radial-gradient(ellipse at 0% 100%, rgba(32,184,255,.12), transparent 50%), linear-gradient(170deg, #0b1730, #050a14 75%)' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 'max(env(safe-area-inset-top), 28px) 16px 28px', maxWidth: 420, width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22, justifyContent: 'center' }}>
          <img src="/korpnex-icon.png" alt="Korpnex" style={{ width: 44, height: 44, borderRadius: 11, objectFit: 'cover' }} />
          <div>
            <div style={{ fontFamily: 'Jakarta, Inter, sans-serif', fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: 4 }}>KORPNEX</div>
            <div style={{ fontSize: 12, color: '#7cc8ff', fontWeight: 600, letterSpacing: 1.2, textTransform: 'uppercase' }}>Työturvallisuus</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

const formStyle = { background: '#fff', borderRadius: 18, padding: 26, boxShadow: '0 30px 80px rgba(0,0,0,.45)', display: 'flex', flexDirection: 'column', gap: 10 }
const h1 = { fontFamily: 'Jakarta, Inter, sans-serif', fontSize: 23, fontWeight: 800, color: '#0a1428', margin: 0, letterSpacing: -0.3 }
const pStyle = { fontSize: 13.5, color: '#64748b', lineHeight: 1.55, margin: '0 0 6px' }
const input = { background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, color: '#0f172a', fontSize: 15, padding: '11px 12px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const primary = { marginTop: 6, padding: 13, background: '#0878E8', boxShadow: '0 8px 20px rgba(8,120,232,.35)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }
const secondary = { padding: 12, background: '#f1f4f9', border: '1px solid #e3e8ef', borderRadius: 8, color: '#0a1428', fontSize: 14, fontWeight: 700, cursor: 'pointer' }
const linkBtn = { background: 'none', border: 'none', color: '#0878E8', fontSize: 13, padding: 6, cursor: 'pointer' }
const errStyle = { background: 'rgba(220,38,38,0.08)', color: '#dc2626', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, padding: '9px 12px', fontSize: 13 }
const okStyle = { background: 'rgba(5,150,105,0.08)', color: '#059669', border: '1px solid rgba(5,150,105,0.3)', borderRadius: 8, padding: '9px 12px', fontSize: 13 }
