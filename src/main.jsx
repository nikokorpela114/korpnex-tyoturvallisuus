import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Rekisteröi Service Workerin heti latauksesta lähtien, jotta sovellus ja
// PDF-vientikirjasto toimivat myös huonolla/olemattomalla kuuluvuudella
// työmaalla, kunhan sivu on ladattu kertaalleen netissä.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
