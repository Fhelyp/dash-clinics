// Endpoint de agregações server-side. Chama a função SQL `dashboard_stats`
// no Postgres (Supabase) que retorna TODAS as métricas do dashboard em ~5KB
// de JSON em vez de baixar 50k+ rows brutas.
//
// GET /api/dashboard/stats?start=2026-04-01&end=2026-05-01
//
// Respeita RBAC: se o JWT tem allowed_clinic_ids, injeta no parâmetro p_clinic_ids.
import { supaHeaders } from '../../_lib/supabase.js';

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end   = url.searchParams.get('end');

  if (!start || !end) {
    return j(400, { error: 'missing_params', message: 'start e end são obrigatórios (YYYY-MM-DD)' });
  }

  // Valida formato datas
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!reDate.test(start) || !reDate.test(end)) {
    return j(400, { error: 'invalid_date_format', message: 'Use YYYY-MM-DD' });
  }

  // Valida intervalo máximo (90 dias) — proteção contra queries pesadas
  const dStart = new Date(start + 'T00:00:00Z');
  const dEnd   = new Date(end   + 'T00:00:00Z');
  const days   = (dEnd - dStart) / (24 * 3600 * 1000);
  if (days < 0) return j(400, { error: 'invalid_range', message: 'end deve ser >= start' });
  if (days > 92) return j(400, { error: 'range_too_wide', message: 'Período máximo: 90 dias' });

  // RBAC: intersecta allowed_clinic_ids (JWT) com clinic_ids do client
  const allowed = data?.user?.allowed_clinic_ids;
  const clientClinicsRaw = url.searchParams.get('clinic_ids') || '';
  let clinicIdsParam = null;
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (clientClinicsRaw) {
      const clientIds = clientClinicsRaw.split(',').filter(Boolean);
      const allowedSet = new Set(allowed);
      clinicIdsParam = clientIds.filter(c => allowedSet.has(c));
      if (clinicIdsParam.length === 0) clinicIdsParam = ['00000000-0000-0000-0000-000000000000']; // forces empty result
    } else {
      clinicIdsParam = allowed;
    }
  } else if (clientClinicsRaw) {
    clinicIdsParam = clientClinicsRaw.split(',').filter(Boolean);
    if (clinicIdsParam.length === 0) clinicIdsParam = null;
  }

  const specialtyIds = url.searchParams.get('specialty_ids');
  const statusCodes  = url.searchParams.get('status_codes');
  const creators     = url.searchParams.get('creators');
  const agentMode    = url.searchParams.get('agent_mode') || 'ALL';

  // Chama função SQL via PostgREST RPC
  const rpcUrl = `${env.SUPABASE_URL}/rest/v1/rpc/dashboard_stats`;
  const body = {
    p_start: start + 'T00:00:00+00:00',
    p_end:   end   + 'T00:00:00+00:00',
    p_clinic_ids: clinicIdsParam,
    p_specialty_ids: specialtyIds ? specialtyIds.split(',').filter(Boolean) : null,
    p_status_codes: statusCodes ? statusCodes.split(',').map(c => parseInt(c,10)).filter(n => !isNaN(n)) : null,
    p_creators: creators ? creators.split('|').filter(Boolean) : null,  // creators podem ter vírgula no nome → use |
    p_agent_mode: agentMode || 'ALL'
  };

  let res, json;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { ...supaHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const txt = await res.text();
    if (!res.ok) {
      return j(res.status, { error: 'rpc_error', message: txt.slice(0, 300) });
    }
    json = JSON.parse(txt);
  } catch (e) {
    return j(500, { error: 'rpc_exception', message: String(e?.message || e) });
  }

  return new Response(JSON.stringify(json), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Sem cache pra evitar contaminação cross-user (RBAC). Cliente já
      // implementa debounce de 600ms que evita rebates desnecessários.
      'Cache-Control': 'no-store, must-revalidate'
    }
  });
}

function j(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
