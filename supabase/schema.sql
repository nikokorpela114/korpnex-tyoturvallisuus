-- Korpnex Työturvallisuus -- Supabase-skeema
-- Aja tämä kokonaisuudessaan uudessa Supabase-projektissa:
-- Dashboard -> SQL Editor -> New query -> liitä koko tiedosto -> Run

create table if not exists safety_observations (
  id bigint generated always as identity primary key,
  report_id text,              -- yhdistää havainnot samaan tarkastuskierrokseen (yksi PDF-raportti)
  local_id bigint,             -- laitteen oma id (offline-synkkauksen dedup)
  site text,                   -- Työmaa / kohde
  inspector text,              -- Tarkastaja
  havainto text,                -- vapaa teksti, esim. "Suojalasit puuttuvat"
  yritys text,                  -- mikä yritys / aliurakoitsija kyseessä
  sev text,                     -- Kriittinen / Huomio / Info
  note text,                    -- lisätieto
  status text default 'avoin',
  created_at timestamptz default now()
);

create table if not exists safety_measurements (
  id bigint generated always as identity primary key,
  report_id text,               -- yhdistää mittauksen samaan tarkastuskierrokseen
  type text not null,           -- 'tr' tai 'mvr'
  site text,
  inspector text,
  counts jsonb not null,        -- { "tyoskentely": { "oikein": 5, "vaarin": 1 }, ... }
  index_pct numeric,            -- laskettu kokonaisindeksi (oikein / (oikein+väärin) * 100)
  created_at timestamptz default now()
);

-- Sallitaan anon-roolille (sovelluksen käyttämä avain) tarvittavat oikeudet.
-- HUOM: pelkkä RLS-policy ei riitä ilman näitä GRANT-lauseita.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on safety_observations to anon, authenticated, service_role;
grant select, insert, update, delete on safety_measurements to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;

alter table safety_observations enable row level security;
alter table safety_measurements enable row level security;

-- Yksinkertaiset avoimet policyt käynnistykseen (sovellus ei vielä käytä
-- käyttäjätunnistusta) -- voidaan tiukentaa myöhemmin kun kirjautuminen lisätään.
-- (Postgresin CREATE POLICY ei tue IF NOT EXISTS -- pudotetaan ensin pois jos
-- skeema ajetaan vahingossa toiseen kertaan, ettei Run kaadu virheeseen.)
drop policy if exists "allow all safety_observations" on safety_observations;
create policy "allow all safety_observations" on safety_observations
  for all using (true) with check (true);
drop policy if exists "allow all safety_measurements" on safety_measurements;
create policy "allow all safety_measurements" on safety_measurements
  for all using (true) with check (true);
