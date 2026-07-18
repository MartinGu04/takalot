// Shared browser Supabase client. Auth (Google OAuth session) and the data
// layer (SupabaseRepository) must use the SAME client so every PostgREST/RPC
// request carries the signed-in user's JWT -- RLS and the SECURITY DEFINER
// RPCs authorize from that token, not from anything the client claims.
//
// Only the public anon key is ever used here. Service-role keys, database
// passwords, and OAuth client secrets have no place in client code; the
// mode resolver (appMode.ts) actively refuses server-shaped secrets.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getAppMode } from '../appMode';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  const mode = getAppMode();
  if (mode.kind !== 'supabase') {
    throw new Error('Supabase client requested outside supabase mode');
  }
  client = createClient(mode.url, mode.anonKey, {
    auth: {
      // PKCE keeps the OAuth code exchange bound to this browser session.
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      // Completes the OAuth redirect automatically on any page load.
      detectSessionInUrl: true,
    },
  });
  return client;
}
