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

## Työajat (oma laskutus)

**Työajat** on oma osionsa osoitteessa `/?tyoajat` (vain konsultille, ei koskaan
asiakasportaalissa). Osioiden välillä liikutaan yläpalkin painikkeilla
📋 Tarkastus · ⏱ Työajat · 🖥 Valvomo. Välilehdet: Kirjaukset, Laskutus
(laskurivit, UKKO-matkalasku, Excel), Asiakkaat & työmaat ja Asetukset:
työpäivien kirjaus (tuntityö, urakka TES-hinta × kerroin, konsultointi),
kilometrit ja päivärahat. Kuukausinäkymä kokoaa:

- **laskurivit asiakkaittain** UKKO:hon kopioitavaksi (rakentamispalvelu alv 0 /
  käännetty verovelvollisuus, konsultointi alv 25,5 %) + "Merkitse laskutetuksi"
- **oman matkalaskun** (verovapaat km-korvaukset ja päivärahat)
- Excel (CSV) -viennin

**Asiakkaat & työmaat** (taulut `wl_clients`, `wl_sites`, erillään turvallisuus-
puolen asiakkaista): työmaan valinta täyttää asiakkaan Y-tunnuksen/osoitteen,
hinnat, km:t ja ALV-käsittelyn. Työaika kirjataan alku–loppu-kellonajoilla
(tunnit pyöristetään 15 min tarkkuudella, ruokatauko −30 min napista) ja
lähtö/paluu kotiin -ajoista sovellus ehdottaa päivärahan.

**Ajopäiväkirja** (taulu `wl_trips`, välilehti 🚗 Ajot): 🚗 Lähden ajoon → mittarilukema,
🏁 Ajo päättyi → loppulukema, km lasketaan ja liitetään saman päivän työpäivään.
Erilliset ajot (esim. tarvikeostokset) menevät omaan matkalaskuun. Lukemien väli
näytetään yksityisajona. Excel-raportissa oma Ajopäiväkirja-välilehti.

Kenttäsovelluksen valikosta: 🚗 Lähden ajoon / ⏱ Kirjaa työpäivä / 🧾 Työajat & laskutus.
Käyttöönotto: aja `supabase/tyoajat.sql` SQL Editorissa. Oletushinnat
(30 €/h, kerroin 1,75, 0,55 €/km, päivärahat 25 / 54 €) muutetaan näkymän
alareunasta, ja ne tallentuvat laitteelle.
