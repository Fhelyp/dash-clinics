// Drill-down do Funil v2: lista contatos com filtros, busca e paginação.
// Params:
//   stage   = leads|agendados|confirmados|compareceram|venderam
//   start, end (obrigatórios)
//   min_lead_created_at (default 2026-04-06)
//   clinic_ids (CSV)
//   limit (default 100, max 500)
//   offset (default 0)
//   search (nome ou telefone)
//   origem (CSV de patient_channel_name pra filtrar)
import { supaHeaders } from '../../_lib/supabase.js';

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const stage = url.searchParams.get('stage') || 'leads';
  const start = url.searchParams.get('start');
  const end   = url.searchParams.get('end');
  if (!start || !end) return j(400, { error: 'missing_params' });
  const minLead = url.searchParams.get('min_lead_created_at') || '2026-04-06';
  const limit = Math.min(500, Math.max(10, parseInt(url.searchParams.get('limit') || '100', 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const search = url.searchParams.get('search') || null;
  const origemRaw = url.searchParams.get('origem') || '';
  const origemArr = origemRaw ? origemRaw.split(',').filter(Boolean) : null;

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

  const rpcUrl = `${env.SUPABASE_URL}/rest/v1/rpc/funnel_detail`;
  const body = {
    p_stage: stage,
    p_start: start + 'T00:00:00+00:00',
    p_end:   end   + 'T00:00:00+00:00',
    p_clinic_ids: clinicIdsParam,
    p_min_lead_created_at: minLead + 'T00:00:00+00:00',
    p_limit: limit,
    p_offset: offset,
    p_search: search,
    p_origem_channels: origemArr
  };

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { ...supaHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const txt = await res.text();
    if (!res.ok) return j(res.status, { error: 'rpc_error', message: txt.slice(0,300) });
    return new Response(txt, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return j(500, { error: 'rpc_exception', message: String(e?.message||e) });
  }
}

function j(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
