// src/ModuleNav.jsx — konsultin osioiden vaihtaja (Tarkastus · Työajat · Valvomo).
// Sama painikerivi kaikissa kolmessa osiossa, jotta siirtyminen on yhden
// napautuksen päässä eikä mikään osio "hyppää" toiseen kesken työn.
import React from 'react'

const ITEMS = [
  { key: 'tarkastus', href: '/', icon: '📋', label: 'Tarkastus' },
  { key: 'tyoajat', href: '/?tyoajat', icon: '⏱', label: 'Työajat' },
  { key: 'valvomo', href: '/?valvomo', icon: '🖥', label: 'Valvomo' },
]

export default function ModuleNav({ current, compact = false, style, className }) {
  return (
    <nav aria-label="Osiot" className={className} style={{
      display: 'flex', gap: 3, padding: 3, borderRadius: 11,
      background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.10)', ...style,
    }}>
      {ITEMS.map(it => {
        const active = it.key === current
        return (
          <a key={it.key} href={active ? undefined : it.href} aria-current={active ? 'page' : undefined}
            style={{
              flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: compact ? '7px 8px' : '8px 14px', borderRadius: 8, textDecoration: 'none', whiteSpace: 'nowrap',
              fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13, fontWeight: 700,
              background: active ? '#fff' : 'transparent', color: active ? '#0a1428' : 'rgba(255,255,255,.78)',
              boxShadow: active ? '0 1px 3px rgba(0,0,0,.25)' : 'none', cursor: active ? 'default' : 'pointer',
            }}>
            <span aria-hidden="true">{it.icon}</span>{it.label}
          </a>
        )
      })}
    </nav>
  )
}
