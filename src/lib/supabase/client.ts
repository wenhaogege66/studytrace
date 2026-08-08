import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/types/database"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

let browserClient: SupabaseClient<Database> | undefined

export function hasSupabaseConfig() {
  return Boolean(supabaseUrl && publishableKey)
}

export function getSupabase() {
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Supabase public configuration is missing")
  }

  browserClient ??= createClient<Database>(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
    },
  })

  return browserClient
}
