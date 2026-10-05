import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import Dashboard from './Dashboard.jsx'
import AuthGate from './AuthGate.jsx'
import './index.css'

// Rekisteröi Service Workerin heti latauksesta lähtien, jotta sovellus ja
// PDF-vientikirjasto toimivat myös huonolla/olemattomalla kuuluvuudella
// työmaalla, kunhan sivu on ladattu kertaalleen netissä.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

// Reititys roolin mukaan:
//   konsultti  → kenttäsovellus (puhelin), ?valvomo → Valvomo
//   asiakas    → aina asiakasportaali (Valvomo luku- ja kuittaustilassa)
const wantsValvomo = new URLSearchParams(window.location.search).has('valvomo')

ReactDOM.createRoot(document.getElementById('root')).render(
  <AuthGate>
    {({ profile, logout }) =>
      profile.role === 'konsultti' && !wantsValvomo
        ? <App profile={profile} logout={logout} />
        : <Dashboard profile={profile} logout={logout} />}
  </AuthGate>
)
