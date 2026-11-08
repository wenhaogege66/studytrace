import "server-only"

import { createClient } from "@supabase/supabase-js"

import type { Database } from "@/types/database"

export function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error("SERVER_DATABASE_NOT_CONFIGURED")
  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
