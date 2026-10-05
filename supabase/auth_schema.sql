-- supabase/auth_schema.sql — Korpnex Työturvallisuus: kirjautuminen,
-- asiakasyritykset, asiakasportaali ja puutteiden kuittausketju.
--
-- Aja KOKONAISUUDESSAAN schema.sql:n jälkeen (Supabase → SQL Editor → Run).
-- Turvallinen ajaa uudelleen.
--
-- ROOLIT (profiles.role)
--   konsultti  Korpnex (Niko). Näkee ja muokkaa kaikkea, luo asiakkaat
--              ja kutsuu asiakkaiden käyttäjät.
--   asiakas    Asiakasyrityksen käyttäjä. Näkee VAIN oman yrityksensä
--              työmaat (worksites.client_id) ja niiden havainnot, mittaukset
--              ja aliurakoitsijat. Ei voi muokata mitään suoraan — ainoa
--              kirjoitusoikeus on havainnon kuittaus korjatuksi
--              (tt_ack_observation) ja kuittauskuvan lataus.
--
-- HAVAINNON TILAT (safety_observations.status)
--   avoin     → konsultti merkitsi poikkeaman
--   kuitattu  → asiakas kuittasi korjatuksi, odottaa konsultin tarkastusta
--   korjattu  → konsultti varmisti korjauksen (jälkikuva)
--   (konsultti voi palauttaa kuitatun takaisin avoimeksi kommentin kanssa)
--
-- Kuvat tallennetaan Storageen (bucket tt-photos), polku
-- <worksite_id>/<uuid>.jpg — näkyvyys seuraa työmaan näkyvyyttä.

-- 1) Asiakasyritykset ja profiilit ------------------------------------------
create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  y_tunnus   text,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text,
  role       text not null default 'asiakas' check (role in ('konsultti', 'asiakas')),
  client_id  uuid references public.clients(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists profiles_client_idx on public.profiles(client_id);

-- 2) Työmaa ↔ asiakas, ja tunniste (worksite_id) kaikille riveille -----------
alter table public.worksites add column if not exists client_id uuid references public.clients(id) on delete set null;
create index if not exists worksites_client_idx on public.worksites(client_id);

alter table public.safety_observations  add column if not exists worksite_id bigint references public.worksites(id) on delete set null;
alter table public.safety_measurements  add column if not exists worksite_id bigint references public.worksites(id) on delete set null;
alter table public.subcontractors       add column if not exists worksite_id bigint references public.worksites(id) on delete set null;
create index if not exists safety_observations_ws_idx on public.safety_observations(worksite_id);
create index if not exists safety_measurements_ws_idx on public.safety_measurements(worksite_id);
create index if not exists subcontractors_ws_idx      on public.subcontractors(worksite_id);

-- Havaintojen kuvat ja kuittausketju
alter table public.safety_observations
  add column if not exists photos         jsonb not null default '[]'::jsonb,  -- [{ "path": "12/uuid.jpg" }]
  add column if not exists due_date       date,
  add column if not exists ack_at         timestamptz,
  add column if not exists ack_by         uuid,
  add column if not exists ack_by_name    text,
  add column if not exists ack_comment    text,
  add column if not exists ack_photo      text,
  add column if not exists fixed_at       timestamptz,
  add column if not exists fixed_by_name  text,
  add column if not exists fix_photo      text,
  add column if not exists reopen_comment text;

update public.safety_observations set status = 'avoin' where status is null;

-- Vanhojen rivien worksite_id nimen perusteella
update public.safety_observations o set worksite_id = w.id from public.worksites w where o.worksite_id is null and o.site = w.name;
update public.safety_measurements o set worksite_id = w.id from public.worksites w where o.worksite_id is null and o.site = w.name;
update public.subcontractors      o set worksite_id = w.id from public.worksites w where o.worksite_id is null and o.site = w.name;

-- Trigger täyttää worksite_id:n automaattisesti työmaan nimestä (site), joten
-- sovelluksen ei tarvitse lähettää sitä.
create or replace function public.tt_set_worksite_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.site is not null and (
       new.worksite_id is null
       or (tg_op = 'UPDATE' and new.site is distinct from old.site and new.worksite_id is not distinct from old.worksite_id)
     ) then
    select id into new.worksite_id from worksites where name = new.site limit 1;
  end if;
  return new;
end $$;

drop trigger if exists tt_obs_ws on public.safety_observations;
create trigger tt_obs_ws before insert or update of site, worksite_id on public.safety_observations
  for each row execute function public.tt_set_worksite_id();
drop trigger if exists tt_meas_ws on public.safety_measurements;
create trigger tt_meas_ws before insert or update of site, worksite_id on public.safety_measurements
  for each row execute function public.tt_set_worksite_id();
drop trigger if exists tt_sub_ws on public.subcontractors;
create trigger tt_sub_ws before insert or update of site, worksite_id on public.subcontractors
  for each row execute function public.tt_set_worksite_id();

-- Työmaan nimen muutos päivittää kaikkien rivien nimitekstin (ennen tätä
-- vanhat havainnot "irtosivat" työmaasta nimeä vaihdettaessa).
create or replace function public.tt_worksite_rename()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.name is distinct from old.name then
    update safety_observations set site = new.name where worksite_id = new.id;
    update safety_measurements set site = new.name where worksite_id = new.id;
    update subcontractors      set site = new.name where worksite_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists tt_worksite_rename on public.worksites;
create trigger tt_worksite_rename after update of name on public.worksites
  for each row execute function public.tt_worksite_rename();

-- 3) Apufunktiot oikeuksille -------------------------------------------------
create or replace function public.tt_is_consultant()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'konsultti')
$$;

create or replace function public.tt_my_client()
returns uuid language sql stable security definer set search_path = public as $$
  select client_id from profiles where id = auth.uid() and role = 'asiakas'
$$;

-- Näkyykö työmaa kirjautuneelle käyttäjälle?
create or replace function public.tt_site_visible(p_worksite_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select tt_is_consultant() or exists (
    select 1 from worksites w
    where w.id = p_worksite_id and not w.archived
      and w.client_id is not null and w.client_id = tt_my_client()
  )
$$;

-- 4) Oikeudet: anon (kirjautumaton) ei näe enää mitään ----------------------
revoke all on public.safety_observations, public.safety_measurements, public.worksites, public.subcontractors from anon;
grant select, insert, update, delete on public.safety_observations, public.safety_measurements,
  public.worksites, public.subcontractors, public.clients, public.profiles to authenticated;
grant usage, select on all sequences in schema public to authenticated;
-- Edge Function (tt-admin) käyttää service_role-avainta — uusissa
-- Supabase-projekteissa uudet taulut eivät saa oikeuksia automaattisesti.
grant all on public.profiles, public.clients to service_role;
grant usage, select on all sequences in schema public to service_role;

alter table public.clients  enable row level security;
alter table public.profiles enable row level security;
alter table public.worksites enable row level security;
alter table public.subcontractors enable row level security;
alter table public.safety_observations enable row level security;
alter table public.safety_measurements enable row level security;

drop policy if exists "allow all worksites" on public.worksites;
drop policy if exists "allow all subcontractors" on public.subcontractors;
drop policy if exists "allow all safety_observations" on public.safety_observations;
drop policy if exists "allow all safety_measurements" on public.safety_measurements;

-- clients
drop policy if exists "tt clients select" on public.clients;
create policy "tt clients select" on public.clients for select
  using ((select tt_is_consultant()) or id = (select tt_my_client()));
drop policy if exists "tt clients write" on public.clients;
create policy "tt clients write" on public.clients for all
  using ((select tt_is_consultant())) with check ((select tt_is_consultant()));

-- profiles (luonti/poisto tapahtuu tt-admin -Edge Functionissa service-avaimella)
drop policy if exists "tt profiles select" on public.profiles;
create policy "tt profiles select" on public.profiles for select
  using (id = (select auth.uid()) or (select tt_is_consultant())
         or (client_id is not null and client_id = (select tt_my_client())));
drop policy if exists "tt profiles consultant update" on public.profiles;
create policy "tt profiles consultant update" on public.profiles for update
  using ((select tt_is_consultant())) with check ((select tt_is_consultant()));

-- worksites
drop policy if exists "tt worksites select" on public.worksites;
create policy "tt worksites select" on public.worksites for select
  using ((select tt_is_consultant())
         or (not archived and client_id is not null and client_id = (select tt_my_client())));
drop policy if exists "tt worksites write" on public.worksites;
create policy "tt worksites write" on public.worksites for all
  using ((select tt_is_consultant())) with check ((select tt_is_consultant()));

-- havainnot, mittaukset, aliurakoitsijat: luku työmaan mukaan, kirjoitus konsultille
do $$
declare t text;
begin
  foreach t in array array['safety_observations', 'safety_measurements', 'subcontractors'] loop
    execute format('drop policy if exists "tt %s select" on public.%I', t, t);
    execute format('create policy "tt %s select" on public.%I for select using ((select tt_is_consultant()) or (not coalesce(archived, false) and tt_site_visible(worksite_id)))', t, t);
    execute format('drop policy if exists "tt %s write" on public.%I', t, t);
    execute format('create policy "tt %s write" on public.%I for all using ((select tt_is_consultant())) with check ((select tt_is_consultant()))', t, t);
  end loop;
end $$;

-- 5) Asiakkaan kuittaus ------------------------------------------------------
-- Asiakas ei voi päivittää havaintoja suoraan; tämä funktio sallii VAIN
-- avoimen havainnon merkitsemisen kuitatuksi (kommentti + valinnainen kuva).
create or replace function public.tt_ack_observation(p_id bigint, p_comment text default null, p_photo text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o  safety_observations;
  me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null then raise exception 'Ei kirjautunut'; end if;
  select * into o from safety_observations where id = p_id;
  if o.id is null or o.archived or not tt_site_visible(o.worksite_id) then
    raise exception 'Havaintoa ei löytynyt';
  end if;
  if o.status <> 'avoin' then raise exception 'Havainto on jo kuitattu tai korjattu'; end if;
  if p_photo is not null and p_photo not like (o.worksite_id::text || '/%') then
    raise exception 'Virheellinen kuva';
  end if;
  update safety_observations set
    status = 'kuitattu', ack_at = now(), ack_by = me.id,
    ack_by_name = coalesce(nullif(me.name, ''), me.email),
    ack_comment = nullif(trim(coalesce(p_comment, '')), ''),
    ack_photo = p_photo
  where id = p_id;
end $$;
revoke all on function public.tt_ack_observation(bigint, text, text) from public, anon;
grant execute on function public.tt_ack_observation(bigint, text, text) to authenticated;

-- 6) Kuvat (Storage) ---------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tt-photos', 'tt-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create or replace function public.tt_photo_site(p_name text)
returns bigint language sql immutable as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9]+$' then split_part(p_name, '/', 1)::bigint end
$$;

drop policy if exists "tt photos select" on storage.objects;
create policy "tt photos select" on storage.objects for select to authenticated
  using (bucket_id = 'tt-photos' and public.tt_site_visible(public.tt_photo_site(name)));
drop policy if exists "tt photos insert" on storage.objects;
create policy "tt photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'tt-photos' and public.tt_site_visible(public.tt_photo_site(name)));
drop policy if exists "tt photos delete" on storage.objects;
create policy "tt photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'tt-photos' and public.tt_is_consultant());

-- 7) Apufunktiot vain kirjautuneille, triggerifunktiot ei suoraan kutsuttaviksi
revoke execute on function public.tt_is_consultant(), public.tt_my_client(), public.tt_site_visible(bigint) from public, anon;
grant execute on function public.tt_is_consultant(), public.tt_my_client(), public.tt_site_visible(bigint) to authenticated;
revoke execute on function public.tt_set_worksite_id(), public.tt_worksite_rename() from public, anon, authenticated;
alter function public.tt_photo_site(text) set search_path = public;

-- 8) Havainnon luokka (putoamissuojaus, sähkö, ...) -------------------------
alter table public.safety_observations add column if not exists luokka text;
