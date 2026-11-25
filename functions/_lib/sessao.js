// Sessão revogável (pendência de 05/11/2026): o logout grava auth_sessions.revoked_at, mas o token
// (JWT, 12 h) continuava valendo até expirar porque ninguém consultava esse campo.
//
// Regras:
//  - Só bloqueia se EXISTE linha da sessão com revoked_at preenchido. Sessão sem linha (insert falhou,
//    login sem auth_users) segue valendo, como antes.
//  - Falha ao consultar (Supabase lento ou fora) NÃO derruba ninguém: vale o comportamento anterior.
//  - Cache curto por token no Cache API da Cloudflare: no máximo 1 consulta por minuto por sessão em
//    cada data center (o dash dispara ~6 APIs em paralelo a cada carga). Índice único em token_hash.
//  - O logout apaga a entrada do cache, então no mesmo data center a revogação vale na hora; nos
//    outros, em até CACHE_S segundos.
import { sha256Hex } from './auth.js';

export const CACHE_S = 60;
const TIMEOUT_MS = 1500;

function chaveCache(hash) {
  return new Request(`https://sessao.dash-clinics.internal/${hash}`);
}

function cacheDisponivel() {
  return typeof caches !== 'undefined' && caches?.default ? caches.default : null;
}

export async function sessaoRevogada(env, token) {
  if (!token || !env?.SUPABASE_URL || !env?.SUPABASE_SERVICE_ROLE) return false;
  const hash = await sha256Hex(token);
  const cache = cacheDisponivel();
  const chave = chaveCache(hash);
  if (cache) {
    try {
      const hit = await cache.match(chave);
      if (hit) return (await hit.text()) === '1';
    } catch { /* sem cache: consulta */ }
  }
  let revogada;
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/auth_sessions?token_hash=eq.${hash}`
      + '&revoked_at=not.is.null&select=token_hash&limit=1';
    const init = {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}` },
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(url, init);
    if (!res.ok) return false;
    const rows = await res.json();
    if (!Array.isArray(rows)) return false; // resposta inesperada: não decide nem guarda
    revogada = rows.some((r) => r && r.token_hash === hash);
  } catch {
    return false;
  }
  if (cache) {
    try {
      await cache.put(chave, new Response(revogada ? '1' : '0', {
        headers: { 'Cache-Control': `max-age=${revogada ? 12 * 3600 : CACHE_S}` },
      }));
    } catch { /* ok */ }
  }
  return revogada;
}

// Chamado no logout: a próxima requisição no mesmo data center já consulta o banco.
export async function esquecerSessao(token) {
  const cache = cacheDisponivel();
  if (!token || !cache) return;
  try { await cache.delete(chaveCache(await sha256Hex(token))); } catch { /* ok */ }
}
