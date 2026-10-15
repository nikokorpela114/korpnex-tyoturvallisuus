// src/WorkApp.jsx — Työajat omana osionaan (/?tyoajat, vain konsultti).
//
// Erillinen sivu omalla yläpalkillaan, jotta työaikojen kirjaus ja laskutus
// eivät sekoitu tarkastuksiin tai Valvomoon. Osioiden välillä liikutaan
// yläpalkin ModuleNav-painikkeilla (Tarkastus · Työajat · Valvomo).
import React, { useRef, useState } from 'react'
import WorkLog, { WORKLOG_CSS } from './WorkLog.jsx'
import ModuleNav from './ModuleNav.jsx'
import { DASHBOARD_CSS } from './Dashboard.jsx'

export default function WorkApp({ profile, logout }) {
  const [toast, setToast] = useState('')
  const timer = useRef(null)
  function showToast(msg) {
    setToast(msg)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 2600)
  }
  return (
    <div className="kx-dashboard">
      <style>{DASHBOARD_CSS + WORKLOG_CSS + WORKAPP_CSS}</style>
      <header className="kx-wa-top">
        <div className="kx-wa-brand">
          <img src="/korpnex-icon.png" alt="" className="kx-wa-logo" />
          <span className="kx-brand-name">KORPNEX</span>
          <span className="kx-wa-title">Työajat</span>
        </div>
        <ModuleNav current="tyoajat" compact style={{ flex: '1 1 300px', maxWidth: 420 }} />
        <button className="kx-btn-ghost kx-btn-sm kx-btn-onbrand kx-wa-logout" onClick={logout} title={profile?.email}>Kirjaudu ulos</button>
      </header>
      <div className="kx-shell kx-shell-single">
        <main className="kx-main">
          <WorkLog showToast={showToast} />
        </main>
      </div>
      {toast && <div className="kx-toast">{toast}</div>}
    </div>
  )
}

const WORKAPP_CSS = `
.kx-wa-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: max(env(safe-area-inset-top), 12px) 24px 12px; background: linear-gradient(180deg, #0a1428 0%, #0c1830 100%); position: sticky; top: 0; z-index: 30; }
.kx-wa-brand { display: flex; align-items: center; gap: 9px; margin-right: auto; }
.kx-wa-logo { width: 32px; height: 32px; border-radius: 10px; object-fit: cover; display: block; }
.kx-wa-title { font-size: 13px; font-weight: 700; color: #7dd3fc; background: rgba(125,211,252,.12); border: 1px solid rgba(125,211,252,.25); padding: 3px 9px; border-radius: 7px; }
@media (max-width: 640px) {
  .kx-wa-top { padding: max(env(safe-area-inset-top), 10px) 14px 10px; gap: 10px; }
  .kx-wa-top nav { order: 3; flex-basis: 100% !important; max-width: none !important; }
  .kx-wa-logout { padding: 6px 10px; }
}
`
