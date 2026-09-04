// src/shared.js — yhteiset vakiot ja apufunktiot.

// TR-mittari: talonrakennustyömaan viikoittainen turvallisuusmittaus.
// Perustuu Valtioneuvoston asetukseen rakennustyön turvallisuudesta
// (205/2009) ja työturvallisuuslakiin (738/2002) — yhteisellä rakennus-
// työmaalla vaadittu viikoittainen kunnostapitotarkastus voidaan tehdä
// TR-mittarilla, kun sitä käytetään säännöllisesti koko työn ajan.
// 7 vakioitua havaintoluokkaa (Rakennusteollisuus RT / Työterveyslaitos).
export const TR_CATEGORIES = [
  { key: 'tyoskentely', label: 'Työskentely', desc: 'Työtavat, henkilökohtaisten suojainten käyttö, työasennot, riskinotto' },
  { key: 'telineet', label: 'Telineet, kulkusillat ja tikkaat', desc: 'Telineiden, kulkusiltojen ja tikkaiden kunto ja turvallinen käyttö' },
  { key: 'koneet', label: 'Koneet ja välineet', desc: 'Koneiden ja käsityövälineiden kunto ja turvallinen käyttö' },
  { key: 'putoamissuojaus', label: 'Putoamissuojaus', desc: 'Kaiteet, suojakaiteet, putoamissuojaimet, aukkojen ja reunojen suojaus' },
  { key: 'sahko', label: 'Sähkö ja valaistus', desc: 'Sähkökeskukset, -johdot, -laitteet ja työkohteen valaistus' },
  { key: 'jarjestys', label: 'Järjestys ja jätehuolto', desc: 'Työmaan yleisjärjestys, kulkutiet, jätehuolto' },
  { key: 'poly', label: 'Pölyisyys', desc: 'Pölyntorjunta ja pölyisyyden hallinta' },
]
export const TR_LEGAL_NOTE =
  'TR-mittaus perustuu Valtioneuvoston asetukseen rakennustyön turvallisuudesta (205/2009) ja työturvallisuuslakiin (738/2002). ' +
  'Säännöllisesti tehtynä TR-mittaus täyttää yhteisen rakennustyömaan viikoittaisen kunnossapitotarkastuksen vaatimuksen.'

// MVR-mittari: maa- ja vesirakennustyömaan viikoittainen turvallisuusmittaus.
// Sama lakiperusta kuin TR-mittarilla, sovellettuna infratyömaan omiin
// riskeihin. 5 vakioitua havaintoluokkaa (Rakennusteollisuus RT).
export const MVR_CATEGORIES = [
  { key: 'tyoskentely_koneet', label: 'Työskentely ja koneenkäyttö', desc: 'Työmenetelmien turvallisuus, suojainten käyttö, koneiden käyttötavat' },
  { key: 'kalusto', label: 'Kalusto', desc: 'Koneiden, laitteiden ja kaluston kunto sekä sähköturvallisuus ja valaistus' },
  { key: 'suojaukset', label: 'Suojaukset ja varoalueet', desc: 'Putoamissuojaus, kaivantojen tuenta, koneiden vaara-alueiden merkintä' },
  { key: 'kulkuvaylat', label: 'Ajo- ja kulkuväylät', desc: 'Työmaaliikenne, kulkuväylien kunto ja merkintä, opasteet' },
  { key: 'jarjestys_varastointi', label: 'Järjestys ja varastointi', desc: 'Yleisjärjestys, jätehuolto, materiaalien ja vaarallisten aineiden varastointi' },
]
export const MVR_LEGAL_NOTE =
  'MVR-mittaus perustuu Valtioneuvoston asetukseen rakennustyön turvallisuudesta (205/2009) ja työturvallisuuslakiin (738/2002), ' +
  'sovellettuna maa- ja vesirakennustyömaan olosuhteisiin. Säännöllisesti tehtynä MVR-mittaus täyttää yhteisen työmaan viikoittaisen ' +
  'kunnossapitotarkastuksen vaatimuksen.'

// Tyhjä laskuri jokaiselle luokka-avaimelle: { [key]: { oikein, vaarin } }
export function emptyCounts(categories) {
  const o = {}
  categories.forEach(c => { o[c.key] = { oikein: 0, vaarin: 0 } })
  return o
}

// Yhden luokan tulos prosentteina (null jos ei yhtään havaintoa vielä)
export function categoryPct(counts) {
  const total = (counts?.oikein || 0) + (counts?.vaarin || 0)
  if (!total) return null
  return Math.round(((counts.oikein / total) * 1000)) / 10
}

// Koko mittauksen kokonaisindeksi (oikein / (oikein+väärin) * 100) ja
// havaintojen kokonaismäärä kaikista luokista yhteensä.
export function overallIndex(countsObj, categories) {
  let oikein = 0, vaarin = 0
  categories.forEach(c => {
    oikein += countsObj[c.key]?.oikein || 0
    vaarin += countsObj[c.key]?.vaarin || 0
  })
  const total = oikein + vaarin
  return { oikein, vaarin, total, pct: total ? Math.round((oikein / total) * 1000) / 10 : null }
}

export function indexColor(pct) {
  if (pct == null) return '#9aa2c0'
  if (pct >= 90) return '#1a8a50'
  if (pct >= 75) return '#d07800'
  return '#d63030'
}

export const SEV_LABELS = ['Kriittinen', 'Huomio', 'Info']

// Downscale + re-encode an image file straight away. Raw phone photos can be
// several MB — compressing keeps PDF exports light and fast.
export function compressImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height)
          width = Math.round(width * scale); height = Math.round(height * scale)
        }
        const c = document.createElement('canvas')
        c.width = width; c.height = height
        c.getContext('2d').drawImage(img, 0, 0, width, height)
        resolve(c.toDataURL('image/jpeg', quality))
      }
      img.onerror = () => resolve(e.target.result)
      img.src = e.target.result
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}
