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
  // Limpa o cookie normal (SameSite=Lax) E o particionado (SameSite=None; Partitioned) usado no
  // embed do hub — senão a sessão embedada do usuário anterior vaza pro próximo no mesmo navegador.
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', clearAuthCookie());
  headers.append('Set-Cookie', 'dc_session=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
