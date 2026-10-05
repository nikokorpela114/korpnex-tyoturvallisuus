// src/photos.js — havaintojen kuvat Supabase Storageen (bucket tt-photos).
//
// Polku: <worksite_id>/<uuid>.jpg — Storage-oikeudet seuraavat työmaan
// näkyvyyttä (ks. supabase/auth_schema.sql), joten asiakas näkee vain omien
// työmaidensa kuvat. Kuvat luetaan lyhytikäisillä allekirjoitetuilla
// linkeillä, joita pidetään muistissa ettei samaa kuvaa haeta joka kerta.
import { useEffect, useState } from 'react'
import { sb } from './supabaseClient.js'

const BUCKET = 'tt-photos'
const cache = new Map() // path -> { url, exp }

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',')
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// Lataa yhden (pakatun) dataURL-kuvan ja palauttaa sen polun.
export async function uploadPhoto(worksiteId, dataUrl) {
  if (!worksiteId || !dataUrl) throw new Error('Työmaa tai kuva puuttuu')
  const path = `${worksiteId}/${newId()}.jpg`
  const { error } = await sb.storage.from(BUCKET).upload(path, dataUrlToBlob(dataUrl), {
    contentType: 'image/jpeg', upsert: false,
  })
  if (error) throw error
  cache.set(path, { url: dataUrl, exp: Date.now() + 3600e3 })
  return path
}

export async function signedUrls(paths) {
  const now = Date.now()
  const missing = [...new Set(paths.filter(Boolean))].filter(p => !(cache.get(p)?.exp > now + 60e3))
  if (missing.length) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(missing, 3600)
    ;(data || []).forEach(d => { if (d.signedUrl && d.path) cache.set(d.path, { url: d.signedUrl, exp: now + 3500e3 }) })
  }
  const out = {}
  paths.forEach(p => { if (cache.get(p)) out[p] = cache.get(p).url })
  return out
}

// React-hook: { [path]: url } annetuille poluille.
export function usePhotoUrls(paths) {
  const key = paths.filter(Boolean).join('|')
  const [urls, setUrls] = useState({})
  useEffect(() => {
    let alive = true
    if (!key) { setUrls({}); return }
    signedUrls(key.split('|')).then(u => { if (alive) setUrls(u) }).catch(() => {})
    return () => { alive = false }
  }, [key])
  return urls
}

// Hakee kuvan dataURL:ksi (PDF-raporttia varten).
export async function photoAsDataUrl(path) {
  const { data, error } = await sb.storage.from(BUCKET).download(path)
  if (error || !data) return null
  return await new Promise(resolve => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => resolve(null)
    r.readAsDataURL(data)
  })
}
