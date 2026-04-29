import { clearAuthCookie, readCookie, sha256Hex } from '../_lib/auth.js';
import { supaUpdate } from '../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  const token = readCookie(request, 'dc_session');
  if (token) {
    try {
      const tokenHash = await sha256Hex(token);
      await supaUpdate(env, 'auth_sessions', `token_hash=eq.${tokenHash}`, { revoked_at: new Date().toISOString() });
    } catch (_) { /* swallow */ }
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearAuthCookie() }
  });
}
