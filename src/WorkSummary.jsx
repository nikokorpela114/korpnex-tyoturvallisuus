// src/WorkSummary.jsx — Työajat: jakson tuntiyhteenveto (viikko / kuukausi / vuosi).
//
// Palkit: viikko → päivät, kuukausi → viikot, vuosi → kuukaudet. Palkin
// napautus avaa tarkemman jakson (kuukauden viikko, vuoden kuukausi).
// Matka-aika näytetään tiedoksi (ei laskuteta).
import React from 'react'
import { summarizePeriod, fmtNum, fmtEur } from './worklog.js'

export default function WorkSummary({ entries, settings, mode, anchor, onDrill }) {
  const s = summarizePeriod(entries, settings, mode, anchor)
  const max = Math.max(1, ...s.rows.map(r => r.hours + r.travelH))
  const unit = { week: 'päivittäin', month: 'viikoittain', year: 'kuukausittain' }[mode]
  return (
    <>
      <div className="kx-wl-stats">
        <div><b>{fmtNum(s.total.hours)} h</b><span>työtunteja · {s.total.days} pv</span></div>
        <div><b>{fmtNum(s.total.travelH)} h</b><span>matka-aikaa (tiedoksi)</span></div>
        <div><b>{fmtNum(s.total.km)} km</b><span>ajoa</span></div>
        <div><b>{fmtEur(s.total.eur)}</b><span>laskutettavaa alv 0</span></div>
      </div>
      <div className="kx-card">
        <div className="kx-wl-invoice-head" style={{ marginBottom: 8 }}>
          <div>
            <div className="kx-card-title" style={{ margin: 0 }}>Tunnit {unit}</div>
            <div className="kx-main-sub">
              <span className="kx-sum-key kx-sum-key-work" /> työ <span className="kx-sum-key kx-sum-key-travel" /> matka
              {s.total.unbilled > 0 && <> · <span className="kx-wl-due">{fmtEur(s.total.unbilled)} laskuttamatta</span></>}
              {s.total.billed > 0 && <> · laskutettu {fmtEur(s.total.billed)}</>}
            </div>
          </div>
        </div>
        <div className={`kx-sum-bars kx-sum-${mode}`}>
          {s.rows.map(r => {
            const clickable = mode !== 'week' && r.anchor
            const Tag = clickable ? 'button' : 'div'
            return (
              <Tag key={r.key} className="kx-sum-bar" onClick={clickable ? () => onDrill(r.anchor) : undefined}
                title={`${r.label} ${r.sub}: ${fmtNum(r.hours)} h työtä, ${fmtNum(r.travelH)} h matkaa, ${fmtNum(r.km)} km, ${fmtEur(r.eur)}`}>
                <div className="kx-sum-val">{r.hours ? fmtNum(r.hours, 1) : ''}</div>
                <div className="kx-sum-track">
                  <div className="kx-sum-fill-travel" style={{ height: `${(r.travelH / max) * 100}%` }} />
                  <div className="kx-sum-fill" style={{ height: `${(r.hours / max) * 100}%` }} />
                </div>
                <div className="kx-sum-label">{r.label}</div>
                {r.sub && <div className="kx-sum-sub">{r.sub}</div>}
              </Tag>
            )
          })}
        </div>
        {s.byClient.length > 0 && (
          <div className="kx-table-wrap" style={{ marginTop: 14 }}>
            <table className="kx-wl-table">
              <thead><tr><th>Asiakas</th><th className="num">Päiviä</th><th className="num">Tunnit</th><th className="num">Km</th><th className="num">Laskutettavaa</th><th className="num">Laskuttamatta</th></tr></thead>
              <tbody>
                {s.byClient.map(c => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td className="num">{c.days}</td>
                    <td className="num">{fmtNum(c.hours)} h</td>
                    <td className="num">{c.km ? fmtNum(c.km) : ''}</td>
                    <td className="num">{fmtEur(c.eur)}</td>
                    <td className="num">{c.unbilled ? <span className="kx-wl-due">{fmtEur(c.unbilled)}</span> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="kx-hint">Urakkapäivien tunnit lasketaan kellonajoista. Matka-aika = kotoa lähtö → kotiinpaluu miinus työmailla oloaika, ei laskuteta.</div>
      </div>
    </>
  )
}

export const SUMMARY_CSS = `
.kx-sum-bars { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 6px; align-items: end; }
.kx-sum-bar { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; background: none; border: none; padding: 4px 0; font-family: inherit; border-radius: 8px; }
button.kx-sum-bar { cursor: pointer; }
button.kx-sum-bar:hover { background: #f4f6fa; }
button.kx-sum-bar:focus-visible { outline: 2px solid #0878E8; outline-offset: 1px; }
.kx-sum-val { font-size: 11.5px; font-weight: 700; color: #0a1428; font-variant-numeric: tabular-nums; min-height: 15px; }
.kx-sum-track { position: relative; width: 100%; max-width: 44px; height: 120px; background: #f4f6fa; border-radius: 7px; display: flex; flex-direction: column-reverse; overflow: hidden; }
.kx-sum-fill { background: #0878E8; width: 100%; }
.kx-sum-fill-travel { background: #93c5fd; width: 100%; order: 2; }
.kx-sum-fill { order: 1; }
.kx-sum-label { font-size: 12px; font-weight: 700; color: #334155; text-transform: capitalize; white-space: nowrap; }
.kx-sum-sub { font-size: 10.5px; color: #94a3b8; white-space: nowrap; }
.kx-sum-key { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin: 0 3px 0 6px; vertical-align: -1px; }
.kx-sum-key-work { background: #0878E8; margin-left: 0; }
.kx-sum-key-travel { background: #93c5fd; }
@media (max-width: 640px) {
  .kx-sum-year .kx-sum-label { font-size: 10.5px; }
  .kx-sum-month .kx-sum-sub { display: none; }
  .kx-sum-track { height: 96px; }
}
`
