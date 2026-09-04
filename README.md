# Korpnex Työturvallisuus

Uusi, Wisol QC:stä erillinen sovellus työturvallisuuskierroksia varten. Sama
periaate kuin QC-sovelluksessa (offline-luonnos, pilvitallennus, PDF-vienti),
mutta:

- Ei karttaa / DXF:ää.
- Kiinteän vikalistan sijaan vapaa **Havainto**-teksti (esim. "Suojalasit
  puuttuvat") + **Yritys**-kenttä (kuka aliurakoitsija/yritys kyseessä).
- **TR-mittaus** ja **MVR-mittaus** omina välilehtinään: 7 (TR) / 5 (MVR)
  lakisääteistä havaintoluokkaa, "tukkimiehen kirjanpito" -painikkeet
  (Oikein/Väärin) jokaiselle luokalle, ja indeksi (%) lasketaan automaattisesti
  kaavalla oikein / (oikein + väärin) × 100 — sekä luokittain että koko
  mittaukselle. Perustuu Valtioneuvoston asetukseen rakennustyön
  turvallisuudesta (205/2009) ja työturvallisuuslakiin (738/2002).

## Käyttöönotto

1. **Supabase**: luo uusi projekti osoitteessa supabase.com/dashboard, aja
   `supabase/schema.sql` SQL-editorissa, kopioi Project URL + anon key
   tiedostoon `src/supabaseClient.js`.
2. **GitHub**: luo uusi repo (esim. `korpnex-tyoturvallisuus`), lisää nämä
   tiedostot samalla tavalla kuin Wisol QC:hen (GitHub-web-editorilla puhelimesta,
   koko tiedosto kerrallaan).
3. **Netlify**: yhdistä repo Netlifyyn (sama tili kuin Wisol QC:llä käy),
   build command `npm install && npm run build`, publish `dist` (jo valmiina
   `netlify.toml`:ssa).

## Rajattu ensimmäinen versio (v1) — ei vielä mukana

Näitä ei rakennettu tähän ensimmäiseen versioon, koska niistä ei ollut vielä
puhetta — helppo lisätä seuraavaksi kun perustoiminnot on testattu kentällä:

- Kirjautuminen / useampi käyttäjä samassa raportissa
- Aiempien raporttien selailu sovelluksesta (data on jo Supabasessa, mutta
  näkymää sille ei vielä ole)
- PDF englanniksi
- Asentaja-/valvomonäkymät, push-ilmoitukset (näitä ei tässä sovelluksessa
  luultavasti edes tarvita, koska kyse on yhden tarkastajan kierroksesta)
