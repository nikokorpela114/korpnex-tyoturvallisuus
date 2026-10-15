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

-- ---------------------------------------------------------------------------
-- Laskutusasiakkaat ja -työmaat (erillään turvallisuuspuolen clients/sites-
-- tauluista, jotta alihankintatyömaat eivät näy tarkastuksissa tai portaalissa).
-- ---------------------------------------------------------------------------
create table if not exists public.wl_clients (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name         text not null,
  business_id  text,            -- Y-tunnus
  address      text,            -- laskutusosoite
  einvoice     text,            -- verkkolaskuosoite / välittäjä
  email        text,
  contact      text,            -- yhteyshenkilö
  hourly_rate  numeric,         -- oletus €/h alv 0 (tyhjä = yleinen oletus)
  km_rate      numeric,         -- oletus €/km asiakkaalle
  vat_mode     text not null default 'kaannetty' check (vat_mode in ('kaannetty', 'alv')),
  notes        text,
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.wl_sites (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id    bigint not null references public.wl_clients(id) on delete restrict,
  name         text not null,
  address      text,
  km           numeric,         -- meno-paluu kotoa, oletus kirjaukselle
  kind         text not null default 'tunti' check (kind in ('tunti', 'urakka', 'konsultointi')),
  notes        text,
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists wl_sites_client_idx on public.wl_sites(client_id);

alter table public.work_entries add column if not exists site_id bigint references public.wl_sites(id) on delete set null;
alter table public.work_entries add column if not exists vat_mode text not null default 'kaannetty';
alter table public.work_entries add column if not exists start_time time;
alter table public.work_entries add column if not exists end_time time;
alter table public.work_entries add column if not exists break_minutes integer not null default 0;
alter table public.work_entries add column if not exists depart_time time;   -- lähtö kotoa (päiväraha)
alter table public.work_entries add column if not exists return_time time;   -- paluu kotiin (päiväraha)
create index if not exists work_entries_site_idx on public.work_entries(site_id);

drop trigger if exists tt_wl_clients_touch on public.wl_clients;
create trigger tt_wl_clients_touch before update on public.wl_clients
  for each row execute function public.tt_touch_updated_at();
drop trigger if exists tt_wl_sites_touch on public.wl_sites;
create trigger tt_wl_sites_touch before update on public.wl_sites
  for each row execute function public.tt_touch_updated_at();

revoke all on public.wl_clients, public.wl_sites from anon;
grant select, insert, update, delete on public.wl_clients, public.wl_sites to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter table public.wl_clients enable row level security;
alter table public.wl_sites enable row level security;

drop policy if exists "tt wl_clients own" on public.wl_clients;
create policy "tt wl_clients own" on public.wl_clients for all
  using ((select tt_is_consultant()) and user_id = (select auth.uid()))
  with check ((select tt_is_consultant()) and user_id = (select auth.uid()));

drop policy if exists "tt wl_sites own" on public.wl_sites;
create policy "tt wl_sites own" on public.wl_sites for all
  using ((select tt_is_consultant()) and user_id = (select auth.uid()))
  with check ((select tt_is_consultant()) and user_id = (select auth.uid()));
