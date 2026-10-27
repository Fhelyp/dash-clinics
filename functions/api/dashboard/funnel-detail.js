// Drill-down do Funil (v7, regras de 27/10/2026): lista contatos com filtros, busca e paginação.
// Mesmos filtros do funil: view (comissao|safra), creators (|) e agent_mode (MC|HUM).
// Params:
//   stage   = leads|agendados|confirmados|compareceram|venderam
//   start, end (obrigatórios)
//   clinic_ids (CSV)
//   limit (default 100, max 500)
//   offset (default 0)
//   search (nome ou telefone)
//   origem (CSV de canais da consulta de campanha, ex.: CRC, Maria Clara IA, Fachada)
import { supaHeaders } from '../../_lib/supabase.js';

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const stage = url.searchParams.get('stage') || 'leads';
  const start = url.searchParams.get('start');
  const end   = url.searchParams.get('end');
  if (!start || !end) return j(400, { error: 'missing_params' });
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

  const view = url.searchParams.get('view') === 'safra' ? 'safra' : 'comissao';
  const creators = url.searchParams.get('creators');
  const agentMode = url.searchParams.get('agent_mode');

  const rpcUrl = `${env.SUPABASE_URL}/rest/v1/rpc/funnel_detail_v7`;
  const body = {
    p_stage: stage,
    p_start: start + 'T00:00:00-03:00',
    p_end:   end   + 'T00:00:00-03:00',
    p_clinic_ids: clinicIdsParam,
    p_view: view,
    p_creators: creators ? creators.split('|').filter(Boolean) : null,
    p_agent_mode: agentMode === 'MC' || agentMode === 'HUM' ? agentMode : 'ALL',
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
