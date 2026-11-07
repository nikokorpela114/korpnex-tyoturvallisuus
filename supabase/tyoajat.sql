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

-- Päivärahojen laskutus asiakkaalta (vain jos sovittu): asiakaskohtainen oletus + merkintäkohtainen valinta
alter table public.wl_clients add column if not exists bill_per_diem boolean not null default false;
alter table public.work_entries add column if not exists per_diem_billable boolean not null default false;

-- ---------------------------------------------------------------------------
-- Ajopäiväkirja: työajot mittarilukemineen. Työpäivään liitetty ajo
-- (entry_id) päivittää työpäivän km:t; erillinen ajo (entry_id null, esim.
-- tarvikeostokset) menee suoraan omaan matkalaskuun.
-- ---------------------------------------------------------------------------
create table if not exists public.wl_trips (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  trip_date   date not null,
  start_time  time,
  end_time    time,
  odo_start   integer,      -- mittarilukema lähtiessä
  odo_end     integer,      -- mittarilukema palatessa (tyhjä = ajo käynnissä)
  km          numeric,      -- odo_end − odo_start, tai käsin ilman lukemia
  route       text,
  purpose     text,
  site_id     bigint references public.wl_sites(id) on delete set null,
  client_name text,
  entry_id    bigint references public.work_entries(id) on delete set null,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists wl_trips_user_date_idx on public.wl_trips(user_id, trip_date);
create index if not exists wl_trips_entry_idx on public.wl_trips(entry_id);

drop trigger if exists tt_wl_trips_touch on public.wl_trips;
create trigger tt_wl_trips_touch before update on public.wl_trips
  for each row execute function public.tt_touch_updated_at();

revoke all on public.wl_trips from anon;
grant select, insert, update, delete on public.wl_trips to authenticated;
grant usage, select on all sequences in schema public to authenticated;
alter table public.wl_trips enable row level security;
drop policy if exists "tt wl_trips own" on public.wl_trips;
create policy "tt wl_trips own" on public.wl_trips for all
  using ((select tt_is_consultant()) and user_id = (select auth.uid()))
  with check ((select tt_is_consultant()) and user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Päivä käynnissä (2026-10): työpäivä kirjataan napeilla lähdöstä kotiinpaluuseen.
--   status 'kaynnissa' = päivä on vielä kesken (ei näy laskuilla eikä summissa),
--   live = väliaikainen tila (esim. tauon alkuaika, kulkeeko omalla autolla).
-- Laskutustila: billing 'laskutettava' | 'ei' (ei laskuteta, esim. oma työ).
--   Laskutettu = invoiced_at asetettu; invoice_id linkittää laskuun (wl_invoices).
-- ---------------------------------------------------------------------------
alter table public.work_entries add column if not exists status text not null default 'valmis';
alter table public.work_entries add column if not exists live jsonb;
alter table public.work_entries add column if not exists billing text not null default 'laskutettava';
do $$ begin
  alter table public.work_entries add constraint work_entries_status_chk check (status in ('kaynnissa', 'valmis'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.work_entries add constraint work_entries_billing_chk check (billing in ('laskutettava', 'ei'));
exception when duplicate_object then null; end $$;
create index if not exists work_entries_status_idx on public.work_entries(user_id, status) where status = 'kaynnissa';

create table if not exists public.wl_invoices (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_name    text not null,
  client_id      bigint references public.wl_clients(id) on delete set null,
  invoice_number text,           -- esim. UKKO:n laskunumero (vapaaehtoinen)
  invoice_date   date not null default current_date,
  net            numeric not null default 0,   -- yhteensä alv 0
  vat            numeric not null default 0,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists wl_invoices_user_date_idx on public.wl_invoices(user_id, invoice_date);
alter table public.work_entries add column if not exists invoice_id bigint references public.wl_invoices(id) on delete set null;
create index if not exists work_entries_invoice_idx on public.work_entries(invoice_id);

drop trigger if exists tt_wl_invoices_touch on public.wl_invoices;
create trigger tt_wl_invoices_touch before update on public.wl_invoices
  for each row execute function public.tt_touch_updated_at();

revoke all on public.wl_invoices from anon;
grant select, insert, update, delete on public.wl_invoices to authenticated;
grant usage, select on all sequences in schema public to authenticated;
alter table public.wl_invoices enable row level security;
drop policy if exists "tt wl_invoices own" on public.wl_invoices;
create policy "tt wl_invoices own" on public.wl_invoices for all
  using ((select tt_is_consultant()) and user_id = (select auth.uid()))
  with check ((select tt_is_consultant()) and user_id = (select auth.uid()));

-- Asiakaskohtainen urakan kerroin (TES-hinta × kerroin). Tyhjä = Asetusten oletus.
alter table public.wl_clients add column if not exists multiplier numeric;

-- ---------------------------------------------------------------------------
-- 2026-11: luotettavuus
--   wl_invoices.lines  = kopio laskun riveistä ja hinnoista laskutushetkellä
--   wl_settings        = Työajat-asetukset tietokannassa (sama kaikilla laitteilla,
--                        mm. vuosikohtaiset verovapaat korvaukset yearRates)
--   tt_rate_limits     = tt-admin-funktion käyttörajat (vain service role)
--   wl_mark_invoiced / wl_cancel_invoice = laskutus yhtenä toimintona (kaikki tai ei mitään)
-- ---------------------------------------------------------------------------
alter table public.wl_invoices add column if not exists lines jsonb;

create table if not exists public.wl_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
revoke all on public.wl_settings from anon;
grant select, insert, update on public.wl_settings to authenticated;
alter table public.wl_settings enable row level security;
drop policy if exists "tt wl_settings own" on public.wl_settings;
create policy "tt wl_settings own" on public.wl_settings for all
  using ((select tt_is_consultant()) and user_id = (select auth.uid()))
  with check ((select tt_is_consultant()) and user_id = (select auth.uid()));

create table if not exists public.tt_rate_limits (
  key        text primary key,
  hits       integer not null default 0,
  window_at  timestamptz not null default now()
);
alter table public.tt_rate_limits enable row level security;
revoke all on public.tt_rate_limits from anon, authenticated;

create or replace function public.wl_mark_invoiced(
  p_ids bigint[], p_client_name text, p_client_id bigint, p_number text,
  p_date date, p_net numeric, p_vat numeric, p_lines jsonb
) returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint; n integer;
begin
  if not tt_is_consultant() then raise exception 'Ei oikeutta'; end if;
  if coalesce(cardinality(p_ids), 0) = 0 then raise exception 'Ei laskutettavia päiviä'; end if;
  insert into wl_invoices (client_name, client_id, invoice_number, invoice_date, net, vat, lines)
  values (p_client_name, p_client_id, nullif(trim(coalesce(p_number, '')), ''), p_date, p_net, p_vat, p_lines)
  returning id into v_id;
  update work_entries
     set invoiced_at = (p_date::timestamp + interval '12 hours') at time zone 'Europe/Helsinki',
         invoice_id = v_id
   where id = any(p_ids) and invoiced_at is null and not archived;
  get diagnostics n = row_count;
  if n <> cardinality(p_ids) then
    raise exception 'Osa päivistä on jo laskutettu tai poistettu. Päivitä sivu ja yritä uudelleen.';
  end if;
  return v_id;
end $$;

create or replace function public.wl_cancel_invoice(p_invoice_id bigint, p_ids bigint[])
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not tt_is_consultant() then raise exception 'Ei oikeutta'; end if;
  update work_entries set invoiced_at = null, invoice_id = null where id = any(p_ids);
  if p_invoice_id is not null
     and not exists (select 1 from work_entries where invoice_id = p_invoice_id) then
    delete from wl_invoices where id = p_invoice_id;
  end if;
end $$;

revoke all on function public.wl_mark_invoiced(bigint[], text, bigint, text, date, numeric, numeric, jsonb) from public, anon;
revoke all on function public.wl_cancel_invoice(bigint, bigint[]) from public, anon;
grant execute on function public.wl_mark_invoiced(bigint[], text, bigint, text, date, numeric, numeric, jsonb) to authenticated;
grant execute on function public.wl_cancel_invoice(bigint, bigint[]) to authenticated;
