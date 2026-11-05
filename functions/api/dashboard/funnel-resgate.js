// Endpoint do bloco "Ações do CRC" (Resgate, Resgate Orto, Follow-Ups, Lead Orgânico, Indicação).
// Chama crc_acoes_stats (db/functions/crc_acoes.sql, 05/11/2026) — antes era funnel_resgate_followup.
// Visão APARTADA da campanha: ação do operador do CRC no Ecuro + coluna de contatos do Chatwoot
// (tag resgate/follow_1..4). Mesmo RBAC e mesmos filtros de operador do funnel.js.
import { supaHeaders } from '../../_lib/supabase.js';
import { paraUsuario } from '../../_lib/acesso.js';

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end   = url.searchParams.get('end');
  if (!start || !end) return j(400, { error: 'missing_params' });

  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!reDate.test(start) || !reDate.test(end)) return j(400, { error: 'invalid_date_format' });

  // RBAC (idêntico ao funnel.js): intersecta o filtro do cliente com o escopo do usuário
  const allowed = data?.user?.allowed_clinic_ids;
  const clientClinicsRaw = url.searchParams.get('clinic_ids') || '';
  let clinicIdsParam = null;
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (clientClinicsRaw) {
      const clientIds = clientClinicsRaw.split(',').filter(Boolean);
      const allowedSet = new Set(allowed);
      clinicIdsParam = clientIds.filter(c => allowedSet.has(c));
      if (clinicIdsParam.length === 0) clinicIdsParam = ['__none__'];
    } else {
      clinicIdsParam = allowed;
    }
  } else if (clientClinicsRaw) {
    clinicIdsParam = clientClinicsRaw.split(',').filter(Boolean);
    if (clinicIdsParam.length === 0) clinicIdsParam = null;
  }

  const creators = url.searchParams.get('creators');
  const agentMode = url.searchParams.get('agent_mode');
  const rpcUrl = `${env.SUPABASE_URL}/rest/v1/rpc/crc_acoes_stats`;
  const body = {
    p_start: start + 'T00:00:00-03:00',
    p_end:   end   + 'T00:00:00-03:00',
    p_clinic_ids: clinicIdsParam,
    p_creators: creators ? creators.split('|').filter(Boolean) : null,  // nomes podem ter vírgula → |
    p_agent_mode: agentMode === 'MC' || agentMode === 'HUM' ? agentMode : 'ALL'
  };

  // Cache de 180s (mesmo esquema do funnel.js): a chave é o corpo da RPC, que já leva as
  // clínicas permitidas do usuário — isola por RBAC.
  const cacheUrl = new URL(url);
  cacheUrl.pathname = '/__crc_acoes_cache__';
  cacheUrl.search = '?k=' + await sha256Short(JSON.stringify(body));
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;
  let cached = null;
  try { cached = await cache.match(cacheKey); } catch (_) {}
  if (cached) {
    return new Response(paraUsuario(await cached.text(), data?.user), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'HIT' }
    });
  }

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { ...supaHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const txt = await res.text();
    if (!res.ok) return j(res.status, { error: 'rpc_error', message: txt.slice(0,300) });
    try {
      await cache.put(cacheKey, new Response(txt, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=180, s-maxage=180' }
      }));
    } catch (_) {}
    return new Response(paraUsuario(txt, data?.user), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, must-revalidate', 'X-Cache': 'MISS' }
    });
  } catch (e) {
    return j(500, { error: 'rpc_exception', message: String(e?.message||e) });
  }
}

function j(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function sha256Short(s) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(hash)).slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
