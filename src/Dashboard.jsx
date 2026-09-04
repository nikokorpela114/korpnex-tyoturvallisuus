import React, { useState, useEffect, useCallback } from 'react'
import { sb } from './supabaseClient.js'
import {
  TR_CATEGORIES, MVR_CATEGORIES, emptyCounts, categoryPct, overallIndex, indexColor,
  buildReportPDF,
} from './shared.js'

// Valvomo (?valvomo) — kooste kaikista työmaista: jokaiselle työmaalle oma
// välilehti, ja sieltä näkee aina tuoreimman TR-/MVR-mittauksen tuloksen
// sekä kaikki havainnot riippumatta siltä miltä laitteelta/tarkastajalta ne
// on kirjattu. "Vie PDF-raportti" kokoaa juuri sillä hetkellä työmaalta
// löytyvän datan yhdeksi lähetysvalmiiksi raportiksi — sama PDF-pohja kuin
// kenttäsovelluksessa (ks. shared.js:n buildReportPDF).
//
// HUOM: valokuvat eivät synkronoidu pilveen (ks. App.jsx:n kommentti) —
// tämä näkymä ja sen PDF-vienti eivät siis koskaan sisällä kuvia, vain
// tekstimuotoiset havainnot ja mittaustulokset.
export default function Dashboard() {
  const [worksites, setWorksites] = useState([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [obs, setObs] = useState([])
  const [trLatest, setTrLatest] = useState(null)
  const [mvrLatest, setMvrLatest] = useState(null)
  const [errMsg, setErrMsg] = useState('')

  const [pdfMode, setPdfMode] = useState(false)
  const [pdfBlob, setPdfBlob] = useState(null)
  const [pdfName, setPdfName] = useState('')
  const [pdfDownloaded, setPdfDownloaded] = useState(false)

  useEffect(() => {
    sb.from('worksites').select('*').order('name').then(({ data, error }) => {
      if (!error && data) {
        setWorksites(data)
        if (!selected && data.length) setSelected(data[0].name)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSite = useCallback(async (siteName) => {
    if (!siteName) return
    setLoading(true)
    setErrMsg('')
    try {
      const [obsRes, trRes, mvrRes] = await Promise.all([
        sb.from('safety_observations').select('*').eq('site', siteName).order('created_at', { ascending: false }),
        sb.from('safety_measurements').select('*').eq('site', siteName).eq('type', 'tr').order('created_at', { ascending: false }).limit(1),
        sb.from('safety_measurements').select('*').eq('site', siteName).eq('type', 'mvr').order('created_at', { ascending: false }).limit(1),
      ])
      if (obsRes.error || trRes.error || mvrRes.error) throw (obsRes.error || trRes.error || mvrRes.error)
      setObs(obsRes.data || [])
      setTrLatest(trRes.data?.[0] || null)
      setMvrLatest(mvrRes.data?.[0] || null)
    } catch (e) {
      console.error('Valvomo load failed:', e)
      setErrMsg('⚠ Tietojen haku epäonnistui — tarkista yhteys ja päivitä.')
    }
    setLoading(false)
  }, [])

  useEffect(() => { if (selected) loadSite(selected) }, [selected, loadSite])

  const distinctInspectors = [...new Set(obs.map(o => o.inspector).filter(Boolean))].join(', ')

  async function exportPDF() {
    const trTotal = trLatest ? overallIndex(trLatest.counts, TR_CATEGORIES).total : 0
    const mvrTotal = mvrLatest ? overallIndex(mvrLatest.counts, MVR_CATEGORIES).total : 0
    if (obs.length === 0 && !trTotal && !mvrTotal) {
      alert('Tällä työmaalla ei ole vielä sisältöä raporttiin.')
      return
    }
    const pdfObs = obs.map(o => ({
      havainto: o.havainto, yritys: o.yritys, sev: o.sev, note: o.note,
      createdAt: o.created_at, photos: [],
    }))
    const { blob, filename } = await buildReportPDF({
      site: selected,
      inspector: distinctInspectors,
      trCounts: trLatest?.counts || emptyCounts(TR_CATEGORIES),
      mvrCounts: mvrLatest?.counts || emptyCounts(MVR_CATEGORIES),
      obs: pdfObs,
    })
    setPdfBlob(blob); setPdfName(filename); setPdfDownloaded(false); setPdfMode(true)
  }

  const shareSupported = typeof navigator !== 'undefined' && !!navigator.share && !!navigator.canShare
  async function sharePDF() {
    if (!pdfBlob) return
    const file = new File([pdfBlob], pdfName, { type: 'application/pdf' })
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: pdfName }) } catch {}
    } else {
      const url = URL.createObjectURL(pdfBlob)
      const a = document.createElement('a'); a.href = url; a.download = pdfName
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 3000)
      setPdfDownloaded(true)
    }
  }

  const sevColor = { Kriittinen: '#d63030', Huomio: '#d07800', Info: '#1a8a50' }
  const sevBg = { Kriittinen: 'rgba(214,48,48,0.1)', Huomio: 'rgba(245,168,0,0.12)', Info: 'rgba(26,138,80,0.1)' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 640, margin: '0 auto' }}>
      {/* Topbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 10px', background: '#17275c', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: '#223a8c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: '#c7cbd6', fontSize: 15 }}>K</div>
          <span style={{ fontSize: 17, fontWeight: 800, color: 'white', letterSpacing: 0.5 }}>KORPNEX</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontWeight: 500, marginLeft: 2 }}>· Valvomo</span>
        </div>
        <button onClick={() => selected && loadSite(selected)} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', fontSize: 11, fontWeight: 700, padding: '6px 10px', borderRadius: 20 }}>
          🔄 Päivitä
        </button>
      </div>

      {/* Työmaa-välilehdet */}
      <div style={{ display: 'flex', gap: 6, padding: '10px 12px', background: '#fff', borderBottom: '1px solid #d3d6e0', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {worksites.length === 0 && (
          <span style={{ fontSize: 13, color: '#6a7086', padding: '6px 4px' }}>Ei vielä yhtään työmaata — lisää työmaa kenttäsovelluksesta.</span>
        )}
        {worksites.map(w => (
          <button key={w.id} onClick={() => setSelected(w.name)} style={{
            flexShrink: 0, padding: '9px 16px', borderRadius: 20, fontSize: 13, fontWeight: 700,
            border: `1px solid ${selected === w.name ? '#17275c' : '#d3d6e0'}`,
            background: selected === w.name ? '#17275c' : '#fff',
            color: selected === w.name ? '#fff' : '#6a7086',
          }}>{w.name}</button>
        ))}
      </div>

      {/* Sisältö */}
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 90, background: '#eef0f5' }}>
        {!selected ? (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: '#6a7086' }}>
            <p style={{ fontSize: 14 }}>Valitse työmaa yltä.</p>
          </div>
        ) : (
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {loading && <div style={{ textAlign: 'center', color: '#6a7086', fontSize: 13 }}>Ladataan…</div>}
            {errMsg && <div style={{ textAlign: 'center', color: '#d63030', fontSize: 13 }}>{errMsg}</div>}

            {!loading && (
              <>
                <MeasurementSummary title="TR-mittaus" categories={TR_CATEGORIES} row={trLatest} />
                <MeasurementSummary title="MVR-mittaus" categories={MVR_CATEGORIES} row={mvrLatest} />

                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#17275c', margin: '4px 0 10px' }}>
                    Havainnot {obs.length ? `(${obs.length})` : ''}
                  </div>
                  {obs.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '24px', color: '#6a7086', background: '#fff', borderRadius: 12, border: '1px solid #d3d6e0' }}>
                      <p style={{ fontSize: 13 }}>Ei havaintoja tällä työmaalla vielä.</p>
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {obs.map(o => (
                      <div key={o.id} style={{ background: '#fff', border: '1px solid #d3d6e0', borderRadius: 12, padding: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#14183a' }}>{o.havainto || '(ei kuvausta)'}</div>
                          <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span>
                        </div>
                        <div style={{ fontSize: 11.5, color: '#6a7086', display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: o.note ? 6 : 0 }}>
                          {o.yritys && <span>🏢 {o.yritys}</span>}
                          {o.inspector && <span>👤 {o.inspector}</span>}
                          {o.created_at && <span>🕒 {new Date(o.created_at).toLocaleString('fi-FI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
                        </div>
                        {o.note && <div style={{ fontSize: 13, color: '#3a3f5c', lineHeight: 1.5 }}>{o.note}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      {selected && (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 640, margin: '0 auto', background: '#f4f5f8', borderTop: '1px solid #d3d6e0', zIndex: 20 }}>
          <div style={{ padding: '10px 16px env(safe-area-inset-bottom, 14px)', display: 'flex', gap: 10 }}>
            <button onClick={exportPDF} style={{ flex: 1, padding: 13, background: '#17275c', border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              📄 Vie PDF-raportti — {selected}
            </button>
          </div>
        </div>
      )}

      {/* PDF overlay */}
      {pdfMode && (
        <div style={{ position: 'fixed', inset: 0, background: '#f4f5f8', zIndex: 100, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 12px', background: '#17275c' }}>
            <button onClick={() => setPdfMode(false)} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: '50%', fontSize: 18 }}>✕</button>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>PDF valmis</span>
            <button onClick={sharePDF} style={{ background: '#c7cbd6', border: 'none', color: '#17275c', fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8 }}>
              {shareSupported ? '⬆ Jaa' : '⬇ Lataa PDF'}
            </button>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32 }}>
            <div style={{ fontSize: 64 }}>{pdfDownloaded ? '✅' : '📄'}</div>
            {shareSupported ? (
              <p style={{ fontSize: 14, color: '#6a7086', textAlign: 'center', lineHeight: 1.6 }}>
                Paina <strong style={{ color: '#14183a' }}>Jaa ⬆</strong> avataksesi jakovalikon — esim. sähköpostiin tai WhatsAppiin.
              </p>
            ) : pdfDownloaded ? (
              <p style={{ fontSize: 14, color: '#1a8a50', textAlign: 'center', lineHeight: 1.6, fontWeight: 600 }}>
                PDF ladattu koneen Lataukset-kansioon.<br />
                <span style={{ color: '#6a7086', fontWeight: 400 }}>({pdfName})</span>
              </p>
            ) : (
              <p style={{ fontSize: 14, color: '#6a7086', textAlign: 'center', lineHeight: 1.6 }}>
                Paina <strong style={{ color: '#14183a' }}>Lataa PDF</strong> tallentaaksesi tiedoston koneelle.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Yhden mittauksen (tuorein TR tai MVR) tiivistelmä: kokonaisindeksi +
// luokittainen erittely, täysin luku-tilassa (ei painikkeita, toisin kuin
// kenttäsovelluksen MeasurementTab).
function MeasurementSummary({ title, categories, row }) {
  const counts = row?.counts || emptyCounts(categories)
  const { total, pct } = overallIndex(counts, categories)
  const color = indexColor(pct)
  return (
    <div style={{ background: '#fff', border: '1px solid #d3d6e0', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#17275c' }}>{title}</div>
          <div style={{ fontSize: 11.5, color: '#6a7086', marginTop: 2 }}>
            {total ? `Viimeisin mittaus ${row.created_at ? new Date(row.created_at).toLocaleDateString('fi-FI') : ''}` : 'Ei vielä mittausta'}
          </div>
        </div>
        <div style={{ fontSize: 26, fontWeight: 800, color }}>{pct == null ? '–' : `${pct}%`}</div>
      </div>
      {total > 0 && (
        <div style={{ borderTop: '1px solid #eef0f5', padding: '8px 14px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {categories.map(c => {
            const cnt = counts[c.key] || { oikein: 0, vaarin: 0 }
            const cpct = categoryPct(cnt)
            return (
              <div key={c.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#3a3f5c' }}>{c.label}</span>
                <span style={{ color: '#9aa2c0' }}>
                  <span style={{ color: '#1a8a50' }}>{cnt.oikein}</span> / <span style={{ color: '#d63030' }}>{cnt.vaarin}</span>
                  {'  '}<strong style={{ color: indexColor(cpct) }}>{cpct == null ? '–' : `${cpct}%`}</strong>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
