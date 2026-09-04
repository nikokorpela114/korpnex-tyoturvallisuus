// src/supabaseClient.js
//
// TÄYTÄ NÄMÄ ennen käyttöönottoa:
// 1. Luo uusi projekti osoitteessa https://supabase.com/dashboard (ilmainen taso riittää).
// 2. Aja tälle projektille supabase/schema.sql (SQL Editor -> New query -> liitä koko
//    tiedoston sisältö -> Run).
// 3. Kopioi Project Settings -> API -> "Project URL" ja "anon public" -avain tähän.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://TAYTA-PROJEKTIN-URL.supabase.co'
const SUPABASE_KEY = 'TAYTA-ANON-PUBLIC-AVAIN'

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
