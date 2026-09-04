// src/supabaseClient.js
//
// Korpnex Työturvallisuus -- Supabase-projekti (eu-west-1, Ireland).
// Publishable key on turvallinen selaimessa (RLS + policyt hoitavat rajaukset,
// ks. supabase/schema.sql) -- jos joskus perustat kokonaan uuden projektin
// tälle sovellukselle, päivitä molemmat rivit Project Settings -> API:sta.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://cehvvgwnfdvxocsqohux.supabase.co'
const SUPABASE_KEY = 'sb_publishable_hYQ8YBZSd37LPVSSbhL9tg_iBDqOD3_'

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
