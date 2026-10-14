-- supabase/tyoajat.sql — Korpnex Työturvallisuus: Työajat (oma laskutus)
--
-- Konsultin omat työpäivät laskutusta varten: tuntityö, urakka (TES-hinta ×
-- kerroin), konsultointi, kilometrit ja päivärahat. Näkyy VAIN kirjautuneelle
-- konsultille itselleen (user_id = auth.uid()) — ei koskaan asiakasportaalissa.
--
-- Aja auth_schema.sql:n jälkeen (Supabase → SQL Editor → Run).
-- Turvallinen ajaa uudelleen.

create table if not exists public.work_entries (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  work_date     date not null,
  client_name   text not null,              -- laskutettava asiakas, esim. "Zaumax Oy"
  site          text,                       -- työmaa / kohde, esim. "Kauhajoki"
  kind          text not null default 'tunti' check (kind in ('tunti', 'urakka', 'konsultointi')),
  hours         numeric not null default 0, -- tuntityö / konsultointi
  hourly_rate   numeric not null default 0, -- €/h alv 0
  lines         jsonb not null default '[]'::jsonb, -- urakka: [{ "tyolaji", "maara", "yksikko", "tes" }]
  multiplier    numeric not null default 1.75,      -- urakka: laskutushinta = TES-hinta × kerroin
  km            numeric not null default 0,         -- ajetut km omalla autolla
  km_billable   boolean not null default true,      -- laskutetaanko km asiakkaalta
  km_rate       numeric not null default 0.55,      -- €/km asiakkaalle
  travel_hours  numeric not null default 0,         -- matka-aika
  travel_rate   numeric not null default 0,         -- €/h matka-ajasta (0 = ei laskuteta)
  per_diem      text not null default 'ei' check (per_diem in ('ei', 'osa', 'koko')), -- oma matkalasku
  notes         text,
  invoiced_at   timestamptz,                -- merkitty laskutetuksi
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Materiaalit: [{ "nimi", "maara", "yksikko", "hinta" }], hinta = €/yks asiakkaalle (0 = vain seuranta)
alter table public.work_entries add column if not exists materials jsonb not null default '[]'::jsonb;

create index if not exists work_entries_user_date_idx on public.work_entries(user_id, work_date);

create or replace function public.tt_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists tt_work_entries_touch on public.work_entries;
create trigger tt_work_entries_touch before update on public.work_entries
  for each row execute function public.tt_touch_updated_at();

revoke all on public.work_entries from anon;
grant select, insert, update, delete on public.work_entries to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter table public.work_entries enable row level security;

drop policy if exists "tt work_entries own" on public.work_entries;
create policy "tt work_entries own" on public.work_entries for all
  using ((select tt_is_consultant()) and user_id = (select auth.uid()))
  with check ((select tt_is_consultant()) and user_id = (select auth.uid()));

revoke execute on function public.tt_touch_updated_at() from public, anon, authenticated;
