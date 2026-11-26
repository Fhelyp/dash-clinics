import { clearAuthCookie, readCookie, sha256Hex } from '../_lib/auth.js';
import { supaUpdate } from '../_lib/supabase.js';
import { esquecerSessao } from '../_lib/sessao.js';

export async function onRequestPost({ request, env }) {
  // Cookie OU Bearer: o embed no Safari não manda o cookie de terceiro e usa o token do
  // localStorage no header; sem isto o logout do embed não revogava a sessão (25/11/2026).
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.indexOf('Bearer ') === 0 ? authHeader.slice(7).trim() : null;
  const tokens = [...new Set([readCookie(request, 'dc_session'), bearer].filter(Boolean))];
  for (const token of tokens) {
    try {
      const tokenHash = await sha256Hex(token);
      await supaUpdate(env, 'auth_sessions', `token_hash=eq.${tokenHash}`, { revoked_at: new Date().toISOString() });
    } catch (_) { /* swallow */ }
    await esquecerSessao(token);
  }
  // Limpa o cookie normal (SameSite=Lax) E o particionado (SameSite=None; Partitioned) usado no
  // embed do hub — senão a sessão embedada do usuário anterior vaza pro próximo no mesmo navegador.
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', clearAuthCookie());
  headers.append('Set-Cookie', 'dc_session=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
