import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/types/database"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

let browserClient: SupabaseClient<Database> | undefined
let transientClientSequence = 0

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

export function createTransientSupabase() {
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Supabase public configuration is missing")
  }

  transientClientSequence += 1
  return createClient<Database>(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
      storageKey: `studytrace-transient-auth-${transientClientSequence}`,
    },
  })
}

export async function withSupabaseAuthMutationLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      "studytrace:auth-session-mutation",
      { mode: "exclusive" },
      operation,
    )
  }

  return operation()
}

export async function withAccountMergeStorageLock<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      "studytrace:account-merge-storage",
      { mode: "exclusive" },
      operation,
    )
  }

  return operation()
}
