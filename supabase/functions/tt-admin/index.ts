// supabase/functions/tt-admin/index.ts — Korpnex Työturvallisuus
//
// Käyttäjähallinta ja sähköpostit (Resend). Toiminnot (body.action):
//
//   Ilman kirjautumista:
//     forgot      { email }                    salasanan palautuslinkki
//
//   Kuka tahansa kirjautunut:
//     notify_ack  { observation_id }           asiakas kuittasi → viesti konsulteille
//
//   Vain konsultti:
//     notify_report { site, report_id }        tarkastus valmis → viesti asiakkaalle
//     list                                      kaikki käyttäjät
//     invite      { email, name, client_id, role? }  luo tunnuksen + kutsu
//     resend      { user_id }                   uusi salasanalinkki
//     remove      { user_id }                   poistaa tunnuksen
//
// Secretit: RESEND_API_KEY (pakollinen), APP_URL (oletus Netlify-osoite),
// TT_FROM_EMAIL (oletus Korpnex <tunnukset@mail.korpnex.fi>).

import { createClient } from 'npm:@supabase/supabase-js@2'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const APP_URL = (Deno.env.get('APP_URL') || 'https://korpnex-tyoturvallisuus.netlify.app').replace(/\/+$/, '')
const FROM = Deno.env.get('TT_FROM_EMAIL') || 'Korpnex <tunnukset@mail.korpnex.fi>'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function layout(title: string, inner: string) {
  return `<!DOCTYPE html><html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:24px 12px;background-color:#eef0f5;">
<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;color:#14183a;">
  <div style="background:#17275c;padding:16px 22px;color:#ffffff;font-weight:bold;letter-spacing:1px;">KORPNEX <span style="font-weight:normal;opacity:.65;letter-spacing:0;">· Työturvallisuus</span></div>
  <div style="padding:22px;">
    <h2 style="color:#17275c;margin:0 0 14px;font-size:20px;">${title}</h2>
    ${inner}
  </div>
</div></body></html>`
}

function button(href: string, label: string) {
  return `<p style="text-align:center;margin:24px 0;"><a href="${href}" style="background:#17275c;color:#ffffff !important;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:bold;font-size:14px;display:inline-block;">${label}</a></p>`
}

async function sendMail(to: string[], subject: string, html: string) {
  const key = Deno.env.get('RESEND_API_KEY')
  if (!key) throw new Error('RESEND_API_KEY-secret puuttuu.')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  })
  if (!res.ok) {
    const b = await res.json().catch(() => ({}))
    throw new Error(`Resend ${res.status}: ${b?.message || 'tuntematon virhe'}`)
  }
}

async function passwordLink(email: string) {
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery', email, options: { redirectTo: `${APP_URL}/` },
  })
  if (error) throw error
  const link = data?.properties?.action_link
  if (!link) throw new Error('Linkin luonti epäonnistui.')
  return link
}

async function sendInvite(p: { email: string; name: string | null; client_name: string | null }) {
  const link = await passwordLink(p.email)
  const html = layout('Tervetuloa Korpnexin asiakasportaaliin', `
    <p>Hei ${esc(p.name || '')},</p>
    <p>Sinulle on luotu tunnus Korpnex Työturvallisuus -portaaliin${p.client_name ? ` (<b>${esc(p.client_name)}</b>)` : ''}.
    Portaalista näet työmaidesi turvallisuushavainnot kuvineen, TR-/MVR-mittausten tulokset ja avoimet puutteet heti tarkastuksen jälkeen — ilman erillisiä PDF-raportteja.</p>
    <p style="background:#f4f5f8;border-radius:8px;padding:10px 14px;font-size:14px;"><span style="color:#6a7086;font-size:12px;font-weight:bold;">KÄYTTÄJÄTUNNUS</span><br>${esc(p.email)}</p>
    <p>Paina alla olevaa painiketta ja aseta itsellesi salasana.</p>
    ${button(link, 'Aseta salasana ja avaa portaali')}
    <p style="color:#6a7086;font-size:12.5px;line-height:1.6;">Vinkki: avaa portaali puhelimen selaimessa ja valitse "Lisää aloitusnäytölle", niin se toimii kuin sovellus.<br>
    Linkki on kertakäyttöinen ja vanhenee. Jos se ei enää toimi, valitse kirjautumissivulla "Unohditko salasanan?".</p>`)
  await sendMail([p.email], 'Tunnuksesi Korpnex Työturvallisuus -portaaliin', html)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* tyhjä */ }
  const action = String(body.action || '')

  try {
    // --- Salasanan palautus (ei vaadi kirjautumista) -----------------------
    if (action === 'forgot') {
      const email = String(body.email || '').trim().toLowerCase()
      if (email) {
        const { data: prof } = await admin.from('profiles').select('email, name').eq('email', email).maybeSingle()
        if (prof?.email) {
          const link = await passwordLink(prof.email)
          await sendMail([prof.email], 'Salasanan vaihto — Korpnex Työturvallisuus', layout('Salasanan vaihto', `
            <p>Hei ${esc(prof.name || '')},</p>
            <p>Joku (toivottavasti sinä) pyysi salasanan vaihtoa Korpnex Työturvallisuus -portaaliin.</p>
            ${button(link, 'Aseta uusi salasana')}
            <p style="color:#6a7086;font-size:12.5px;">Jos et pyytänyt tätä, voit jättää viestin huomiotta.</p>`))
        }
      }
      // Sama vastaus aina, ettei sähköpostiosoitteiden olemassaoloa voi urkkia.
      return json({ ok: true })
    }

    // --- Kirjautunut käyttäjä --------------------------------------------
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
    const { data: u, error: uErr } = await admin.auth.getUser(token)
    if (uErr || !u?.user) return json({ error: 'Kirjaudu uudelleen.' }, 401)
    const callerId = u.user.id
    const { data: me } = await admin.from('profiles').select('id, role, client_id, name, email').eq('id', callerId).maybeSingle()
    if (!me) return json({ error: 'Tunnusta ei ole liitetty portaaliin.' }, 403)

    if (action === 'notify_ack') {
      const id = Number(body.observation_id)
      const { data: o } = await admin.from('safety_observations')
        .select('id, havainto, yritys, sev, site, worksite_id, status, ack_by, ack_by_name, ack_comment, ack_photo')
        .eq('id', id).maybeSingle()
      if (!o || o.status !== 'kuitattu' || o.ack_by !== callerId) return json({ ok: true, skipped: true })
      const { data: consultants } = await admin.from('profiles').select('email').eq('role', 'konsultti')
      const to = (consultants || []).map(c => c.email).filter(Boolean) as string[]
      if (!to.length) return json({ ok: true, skipped: true })
      const html = layout('Puute kuitattu korjatuksi', `
        <p><b>${esc(o.ack_by_name)}</b> kuittasi havainnon korjatuksi. Se odottaa tarkastustasi.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0;">
          <tr><td style="padding:6px 0;color:#6a7086;width:120px;">Työmaa</td><td style="padding:6px 0;font-weight:bold;">${esc(o.site)}</td></tr>
          <tr><td style="padding:6px 0;color:#6a7086;">Havainto</td><td style="padding:6px 0;">${esc(o.havainto)}</td></tr>
          ${o.yritys ? `<tr><td style="padding:6px 0;color:#6a7086;">Yritys</td><td style="padding:6px 0;">${esc(o.yritys)}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#6a7086;">Vakavuus</td><td style="padding:6px 0;">${esc(o.sev)}</td></tr>
          ${o.ack_comment ? `<tr><td style="padding:6px 0;color:#6a7086;">Kommentti</td><td style="padding:6px 0;">${esc(o.ack_comment)}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#6a7086;">Kuva</td><td style="padding:6px 0;">${o.ack_photo ? 'Liitetty (näet sen Valvomossa)' : 'Ei kuvaa'}</td></tr>
        </table>
        ${button(`${APP_URL}/?valvomo`, 'Avaa Valvomo')}`)
      await sendMail(to, `Kuitattu: ${o.havainto || 'havainto'} (${o.site || ''})`, html)
      return json({ ok: true })
    }

    // --- Vain konsultti ---------------------------------------------------
    if (me.role !== 'konsultti') return json({ error: 'Vain Korpnex voi hallita käyttäjiä.' }, 403)

    // Tarkastuskierros valmis → ilmoitus asiakkaan käyttäjille
    if (action === 'notify_report') {
      const site = String(body.site || '')
      const reportId = String(body.report_id || '')
      const { data: ws } = await admin.from('worksites').select('id, name, client_id').eq('name', site).maybeSingle()
      if (!ws) return json({ error: 'Työmaata ei löytynyt.' }, 404)
      if (!ws.client_id) return json({ error: 'Työmaata ei ole liitetty asiakkaaseen. Liitä se Valvomossa (työmaa → Asiakas).' }, 400)
      const { data: users } = await admin.from('profiles').select('email, name').eq('client_id', ws.client_id).eq('role', 'asiakas')
      const to = (users || []).filter(u => u.email)
      if (!to.length) return json({ error: 'Asiakkaalla ei ole vielä käyttäjiä. Kutsu ne Valvomon Asiakkaat-näkymästä.' }, 400)
      const [{ data: obs }, { data: meas }, { data: openRows }] = await Promise.all([
        admin.from('safety_observations').select('havainto, sev, yritys, due_date').eq('worksite_id', ws.id).eq('report_id', reportId).eq('archived', false).order('created_at'),
        admin.from('safety_measurements').select('type, index_pct').eq('worksite_id', ws.id).eq('report_id', reportId).eq('archived', false),
        admin.from('safety_observations').select('id, status').eq('worksite_id', ws.id).eq('archived', false).in('status', ['avoin', 'kuitattu']),
      ])
      const list = obs || []
      const crit = list.filter(o => o.sev === 'Kriittinen').length
      const openCount = (openRows || []).filter(o => o.status === 'avoin').length
      const sevCol: Record<string, string> = { Kriittinen: '#dc2626', Huomio: '#d97706', Info: '#059669' }
      const idx = (meas || []).filter(m => m.index_pct != null).map(m =>
        `<td style="padding:10px 14px;background:#f4f6fa;border-radius:8px;text-align:center;"><div style="font-size:22px;font-weight:bold;color:${Number(m.index_pct) >= 90 ? '#059669' : Number(m.index_pct) >= 75 ? '#d97706' : '#dc2626'};">${esc(m.index_pct)} %</div><div style="font-size:12px;color:#64748b;">${m.type === 'mvr' ? 'MVR' : 'TR'}-indeksi</div></td>`).join('<td style="width:8px"></td>')
      const rows = list.slice(0, 10).map(o => `<tr><td style="padding:7px 0;border-bottom:1px solid #eef1f6;font-size:14px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sevCol[o.sev] || '#94a3b8'};margin-right:8px;"></span>${esc(o.havainto || '(ei kuvausta)')}${o.yritys ? `<span style="color:#64748b;"> · ${esc(o.yritys)}</span>` : ''}</td></tr>`).join('')
      const date = new Date().toLocaleDateString('fi-FI', { timeZone: 'Europe/Helsinki' })
      const html = layout(`Uusi tarkastus: ${esc(ws.name)}`, `
        <p>Korpnex teki työmaalla työturvallisuustarkastuksen ${date}${me.name ? ` (${esc(me.name)})` : ''}. Tulokset ovat nyt portaalissa.</p>
        <p style="font-size:15px;"><b>${list.length} ${list.length === 1 ? 'uusi havainto' : 'uutta havaintoa'}</b>${crit ? `, joista <b style="color:#dc2626;">${crit} kriittistä</b>` : ''}.</p>
        ${idx ? `<table style="border-collapse:separate;margin:12px 0;"><tr>${idx}</tr></table>` : ''}
        ${rows ? `<table style="width:100%;border-collapse:collapse;margin:8px 0 4px;">${rows}</table>${list.length > 10 ? `<p style="color:#64748b;font-size:13px;">+ ${list.length - 10} muuta havaintoa</p>` : ''}` : ''}
        <p style="background:#fff8e6;border-radius:8px;padding:10px 14px;font-size:14px;color:#7a5b00;">Työmaalla on nyt avoinna yhteensä <b>${openCount}</b> puutetta. Kun puute on korjattu, kuittaa se portaalissa — kuvan voi ottaa suoraan puhelimella.</p>
        ${button(APP_URL + '/', 'Avaa portaali')}`)
      let sent = 0
      for (const u of to) {
        try { await sendMail([u.email], `Uusi työturvallisuustarkastus: ${ws.name}`, html); sent++ } catch (e) { console.error('notify_report', u.email, e) }
      }
      return json({ ok: true, sent, total: to.length })
    }

    if (action === 'list') {
      const { data, error } = await admin.from('profiles')
        .select('id, email, name, role, client_id, created_at').order('email')
      if (error) throw error
      const { data: authList } = await admin.auth.admin.listUsers({ perPage: 1000 })
      const lastSeen = new Map((authList?.users || []).map(x => [x.id, x.last_sign_in_at]))
      return json({ users: (data || []).map(p => ({ ...p, last_sign_in_at: lastSeen.get(p.id) || null })) })
    }

    if (action === 'invite') {
      const email = String(body.email || '').trim().toLowerCase()
      const name = String(body.name || '').trim() || null
      const role = body.role === 'konsultti' ? 'konsultti' : 'asiakas'
      const clientId = role === 'asiakas' ? String(body.client_id || '') : null
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Tarkista sähköpostiosoite.' }, 400)
      let clientName: string | null = null
      if (role === 'asiakas') {
        const { data: c } = await admin.from('clients').select('id, name').eq('id', clientId).maybeSingle()
        if (!c) return json({ error: 'Valitse asiakasyritys.' }, 400)
        clientName = c.name
      }
      const { data: existing } = await admin.from('profiles').select('id').eq('email', email).maybeSingle()
      if (existing) return json({ error: 'Tällä sähköpostilla on jo tunnus.' }, 400)

      const randomPw = crypto.randomUUID() + crypto.randomUUID()
      const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password: randomPw, email_confirm: true })
      if (cErr) {
        const m = String(cErr.message || '').toLowerCase()
        if (m.includes('already') || m.includes('registered') || m.includes('exists')) {
          return json({ error: 'Tällä sähköpostilla on jo tunnus (ilman profiilia). Poista se Supabasen Authentication-näkymästä tai ota yhteyttä.' }, 400)
        }
        throw cErr
      }
      const newId = created.user!.id
      const { error: pErr } = await admin.from('profiles').insert([{ id: newId, email, name, role, client_id: clientId }])
      if (pErr) { await admin.auth.admin.deleteUser(newId); throw pErr }

      let emailed = true, emailError: string | null = null
      try { await sendInvite({ email, name, client_name: clientName }) }
      catch (e) { emailed = false; emailError = String((e as Error)?.message || e) }
      return json({ ok: true, id: newId, emailed, emailError })
    }

    if (action === 'resend') {
      const { data: p } = await admin.from('profiles').select('email, name, client_id').eq('id', String(body.user_id || '')).maybeSingle()
      if (!p?.email) return json({ error: 'Käyttäjää ei löytynyt.' }, 404)
      let clientName: string | null = null
      if (p.client_id) {
        const { data: c } = await admin.from('clients').select('name').eq('id', p.client_id).maybeSingle()
        clientName = c?.name || null
      }
      await sendInvite({ email: p.email, name: p.name, client_name: clientName })
      return json({ ok: true })
    }

    if (action === 'remove') {
      const id = String(body.user_id || '')
      if (!id || id === callerId) return json({ error: 'Et voi poistaa omaa tunnustasi.' }, 400)
      const { error } = await admin.auth.admin.deleteUser(id)
      if (error) throw error
      return json({ ok: true })
    }

    return json({ error: 'Tuntematon toiminto' }, 400)
  } catch (e) {
    console.error('tt-admin', action, e)
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
