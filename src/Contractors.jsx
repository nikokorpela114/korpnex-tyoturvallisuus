// src/Contractors.jsx — Valvomon "Urakoitsijat"-välilehti.
//
// Pitkällä työmaalla (esim. 10 kk, kierros joka viikko) näkee yhdellä
// silmäyksellä, millä urakoitsijalla havaintoja on eniten, kuinka moni on
// vielä auki, kuinka nopeasti ne korjataan ja mikä aihe toistuu.
// Näkyy sekä Korpnexille että asiakkaalle. Konsultti voi lisäksi yhdistää
// saman urakoitsijan eri kirjoitusasut yhdeksi (esim. "Teline oy" → "Teline Oy").
import React, { useMemo, useState } from 'react'
import { sb } from './supabaseClient.js'
import { contractorStats, fmtDays, weekStart, isoWeek } from './shared.js'
import { ObsCard } from './ObsReview.jsx'

const PERIODS = [['viikko', 'Tämä viikko'], ['kk', '30 päivää'], ['koko', 'Koko työmaa']]
const PALETTE = ['#0878E8', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4', '#94a3b8']

export default function ContractorsPanel({ obs, isC, worksiteId, urls, onOpenPhoto, onChanged, showToast }) {
  const [period, setPeriod] = useState('koko')
  const [sort, setSort] = useState('total')
  const [open, setOpen] = useState(null)

  const filtered = useMemo(() => {
    if (period === 'koko') return obs
    const from = period === 'viikko' ? weekStart(Date.now()) : Date.now() - 30 * 864e5
    return obs.filter(o => new Date(o.created_at).getTime() >= from)
  }, [obs, period])

  const rows = useMemo(() => {
    const r = contractorStats(filtered)
    const key = { total: x => x.total, avoin: x => x.avoin + x.kuitattu, kriittinen: x => x.Kriittinen, fix: x => -(x.avgFix ?? 1e9) }[sort]
    return r.sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name))
  }, [filtered, sort])

  const names = rows.map(r => r.name).filter(n => n !== 'Ei merkitty')

  async function merge(from, to) {
    if (!to || from === to) return
    if (!window.confirm(`Yhdistetäänkö "${from}" → "${to}"?\n\nKaikki tämän työmaan havainnot, joissa urakoitsijana on "${from}", siirretään nimelle "${to}".`)) return
    const { error } = await sb.from('safety_observations').update({ yritys: to }).eq('worksite_id', worksiteId).eq('yritys', from)
    if (error) { showToast?.('⚠ Yhdistäminen epäonnistui'); return }
    await sb.from('subcontractors').update({ archived: true }).eq('worksite_id', worksiteId).eq('name', from)
    showToast?.(`✓ "${from}" yhdistetty → "${to}"`)
    onChanged?.()
  }

  const maxTotal = Math.max(1, ...rows.map(r => r.total))

  return (
    <div className="kx-contractors">
      <div className="kx-ct-toolbar">
        <div className="kx-btn-choice-row">
          {PERIODS.map(([k, l]) => (
            <button key={k} className={`kx-choice-btn ${period === k ? 'active' : ''}`} onClick={() => setPeriod(k)}>{l}</button>
          ))}
        </div>
        <label className="kx-ct-sort">
          Järjestä:
          <select className="kx-input kx-input-sm" value={sort} onChange={e => setSort(e.target.value)}>
            <option value="total">Eniten havaintoja</option>
            <option value="avoin">Eniten avoimia</option>
            <option value="kriittinen">Eniten kriittisiä</option>
            <option value="fix">Hitain korjausaika</option>
          </select>
        </label>
      </div>

      <WeeklyChart obs={obs} />

      {rows.length === 0 ? (
        <div className="kx-empty-note">Ei havaintoja valitulla aikavälillä.</div>
      ) : (
        <div className="kx-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="kx-table-wrap">
            <table className="kx-ct-table">
              <thead>
                <tr>
                  <th>Urakoitsija</th>
                  <th>Havainnot</th>
                  <th>Kriittiset</th>
                  <th>Avoinna</th>
                  <th>Myöhässä</th>
                  <th>Korj.aika</th>
                  <th>Yleisin aihe</th>
                  <th>12 vk</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const isOpen = open === r.name
                  const openNow = r.avoin + r.kuitattu
                  return (
                    <React.Fragment key={r.name}>
                      <tr className={`kx-ct-row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : r.name)}>
                        <td>
                          <div className="kx-ct-name"><span className="kx-ct-caret">{isOpen ? '▾' : '▸'}</span>{r.name}</div>
                          <div className="kx-ct-bar"><i style={{ width: `${(r.total / maxTotal) * 100}%` }} /></div>
                        </td>
                        <td className="num strong">{r.total}</td>
                        <td className="num" style={{ color: r.Kriittinen ? '#dc2626' : '#cbd3df' }}>{r.Kriittinen}</td>
                        <td className="num" style={{ color: openNow ? '#d97706' : '#cbd3df' }}>{openNow}{r.kuitattu ? <small> ({r.kuitattu} kuit.)</small> : null}</td>
                        <td className="num" style={{ color: r.myohassa ? '#dc2626' : '#cbd3df' }}>{r.myohassa}</td>
                        <td className="num">{r.avgFix == null ? '–' : `${fmtDays(r.avgFix)} pv`}</td>
                        <td>{r.topLuokat[0] ? <span className="kx-ct-topic">{r.topLuokat[0][0]} <b>{Math.round(r.topLuokat[0][1] / r.total * 100)} %</b></span> : <span style={{ color: '#cbd3df' }}>–</span>}</td>
                        <td><Spark values={r.weekly} /></td>
                      </tr>
                      {isOpen && (
                        <tr className="kx-ct-detail">
                          <td colSpan={8}>
                            <div className="kx-ct-detail-head">
                              <div className="kx-summary-badges" style={{ margin: 0 }}>
                                <span className="kx-badge" style={{ color: '#dc2626' }}>Kriittinen {r.Kriittinen}</span>
                                <span className="kx-badge" style={{ color: '#d97706' }}>Huomio {r.Huomio}</span>
                                <span className="kx-badge" style={{ color: '#059669' }}>Info {r.Info}</span>
                                <span className="kx-badge">Korjattu {r.korjattu} / {r.total}</span>
                                {r.topLuokat.slice(0, 4).map(([l, n]) => <span key={l} className="kx-badge" style={{ background: '#eef5ff', color: '#0a5bb5' }}>{l} {n}</span>)}
                              </div>
                              {isC && r.name !== 'Ei merkitty' && names.length > 1 && (
                                <select className="kx-input kx-input-sm" style={{ width: 'auto' }} value="" onClick={e => e.stopPropagation()} onChange={e => merge(r.name, e.target.value)}>
                                  <option value="">Yhdistä toiseen nimeen…</option>
                                  {names.filter(n => n !== r.name).map(n => <option key={n} value={n}>→ {n}</option>)}
                                </select>
                              )}
                            </div>
                            <div className="kx-obs-grid">
                              {r.obs.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(o => (
                                <ObsCard key={o.id} o={o} urls={urls} onOpenPhoto={onOpenPhoto} />
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="kx-hint">Avaa urakoitsijan rivi nähdäksesi sen havainnot kuvineen — kätevä esimerkiksi viikkopalaverissa.</div>
    </div>
  )
}

function Spark({ values }) {
  const max = Math.max(1, ...values)
  const W = 64, H = 24, bw = W / values.length
  return (
    <svg width={W} height={H} className="kx-spark">
      {values.map((v, i) => (
        <rect key={i} x={i * bw + 1} y={H - (v / max) * (H - 2) - 1} width={bw - 2} height={Math.max(1, (v / max) * (H - 2))} rx="1.5"
          fill={i === values.length - 1 ? '#0878E8' : v ? '#9cc7f5' : '#e3e8ef'}><title>{v}</title></rect>
      ))}
    </svg>
  )
}

// Havainnot viikoittain, pinottuna urakoitsijoittain (5 suurinta + muut).
function WeeklyChart({ obs }) {
  const data = useMemo(() => {
    if (!obs.length) return null
    const first = weekStart(Math.min(...obs.map(o => new Date(o.created_at).getTime())))
    const last = weekStart(Date.now())
    const nWeeks = Math.min(52, Math.round((last - first) / (7 * 864e5)) + 1)
    const start = last - (nWeeks - 1) * 7 * 864e5
    const totals = {}
    obs.forEach(o => { const n = (o.yritys || '').trim() || 'Ei merkitty'; totals[n] = (totals[n] || 0) + 1 })
    const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0])
    const keys = Object.keys(totals).length > top.length ? [...top, 'Muut'] : top
    const weeks = Array.from({ length: nWeeks }, (_, i) => ({ t: start + i * 7 * 864e5, v: {} }))
    obs.forEach(o => {
      const i = Math.round((weekStart(o.created_at) - start) / (7 * 864e5))
      if (i < 0 || i >= nWeeks) return
      const n = (o.yritys || '').trim() || 'Ei merkitty'
      const k = top.includes(n) ? n : 'Muut'
      weeks[i].v[k] = (weeks[i].v[k] || 0) + 1
    })
    return { weeks, keys }
  }, [obs])
  if (!data || data.weeks.length < 2) return null
  const { weeks, keys } = data
  const max = Math.max(1, ...weeks.map(w => Object.values(w.v).reduce((a, b) => a + b, 0)))
  const H = 150, bw = 100 / weeks.length
  const step = Math.ceil(weeks.length / 12)
  return (
    <div className="kx-card">
      <div className="kx-measure-summary-head">
        <div className="kx-card-title" style={{ marginBottom: 0 }}>Havainnot viikoittain</div>
        <div className="kx-trend-legend">{keys.map((k, i) => <span key={k}><i style={{ background: PALETTE[i % PALETTE.length] }} />{k}</span>)}</div>
      </div>
      <div className="kx-wk-chart" style={{ height: H }}>
        {weeks.map((w, i) => {
          const tot = Object.values(w.v).reduce((a, b) => a + b, 0)
          return (
            <div key={w.t} className="kx-wk-col" style={{ width: `${bw}%` }} title={`Vko ${isoWeek(w.t)}: ${tot} havaintoa`}>
              <div className="kx-wk-stack" style={{ height: `${(tot / max) * 100}%` }}>
                {keys.map((k, ki) => w.v[k] ? <div key={k} style={{ flex: w.v[k], background: PALETTE[ki % PALETTE.length] }} /> : null)}
              </div>
              <span className="kx-wk-label">{i % step === 0 ? isoWeek(w.t) : ''}</span>
            </div>
          )
        })}
      </div>
      <div className="kx-hint" style={{ textAlign: 'right', marginTop: 4 }}>viikko</div>
    </div>
  )
}

export const CONTRACTORS_CSS = `
.kx-contractors { display: flex; flex-direction: column; gap: 16px; }
.kx-ct-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.kx-ct-sort { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #64748b; font-weight: 600; }
.kx-ct-sort select { width: auto; }
.kx-ct-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.kx-ct-table th { text-align: right; font-size: 10.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .4px; padding: 12px 10px; border-bottom: 1px solid #e3e8ef; white-space: nowrap; background: #fafbfd; }
.kx-ct-table th:first-child, .kx-ct-table th:nth-child(7), .kx-ct-table th:nth-child(8) { text-align: left; }
.kx-ct-table td { padding: 12px 10px; border-bottom: 1px solid #f1f4f9; vertical-align: middle; }
.kx-ct-table td.num { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.kx-ct-table td.strong { font-weight: 800; color: #0a1428; font-size: 15px; }
.kx-ct-table td small { font-weight: 500; color: #94a3b8; font-size: 11px; }
.kx-ct-row { cursor: pointer; transition: background .12s; }
.kx-ct-row:hover, .kx-ct-row.open { background: #f8fafc; }
.kx-ct-name { font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.kx-ct-caret { color: #94a3b8; font-size: 11px; width: 10px; }
.kx-ct-bar { height: 4px; background: #eef1f6; border-radius: 4px; margin-top: 6px; min-width: 90px; }
.kx-ct-bar i { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, #0878E8, #20B8FF); }
.kx-ct-topic { font-size: 12.5px; color: #334155; display: inline-block; max-width: 170px; line-height: 1.35; }
.kx-ct-topic b { color: #0a5bb5; font-weight: 700; }
.kx-ct-detail > td { background: #f8fafc; padding: 16px; }
.kx-ct-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.kx-spark { display: block; }
.kx-wk-chart { display: flex; align-items: stretch; gap: 0; margin-top: 14px; padding-bottom: 18px; border-bottom: 1px solid #e3e8ef; }
.kx-wk-col { position: relative; display: flex; flex-direction: column; justify-content: flex-end; padding: 0 2px; }
.kx-wk-stack { display: flex; flex-direction: column-reverse; border-radius: 4px 4px 0 0; overflow: hidden; min-height: 0; }
.kx-wk-stack > div { min-height: 2px; }
.kx-wk-label { position: absolute; bottom: -18px; left: 0; right: 0; text-align: center; font-size: 10.5px; color: #94a3b8; }
`
