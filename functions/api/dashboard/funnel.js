// Endpoint do Funil de Vendas. Chama funnel_stats_v7 (regras de 27/10/2026, docs/DECISOES_2026-10-27.md).
// Cruza chatwoot_leads (campanha/anúncio) × BI Appointments × BI Payments.
// view = 'comissao' (cada etapa no período em que aconteceu) | 'safra' (leads que caíram no período).
// creators (nomes separados por |) e agent_mode (MC|HUM) seguem os filtros de operador do dash.
import { supaHeaders } from '../../_lib/supabase.js';

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end   = url.searchParams.get('end');
  if (!start || !end) return j(400, { error: 'missing_params' });

  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!reDate.test(start) || !reDate.test(end)) return j(400, { error: 'invalid_date_format' });

  // RBAC
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

  const rpcUrl = `${env.SUPABASE_URL}/rest/v1/rpc/funnel_stats_v7`;
  const body = {
    p_start: start + 'T00:00:00-03:00',
    p_end:   end   + 'T00:00:00-03:00',
    p_clinic_ids: clinicIdsParam,
    p_view: view,
    p_creators: creators ? creators.split('|').filter(Boolean) : null,  // nomes podem ter vírgula → |
    p_agent_mode: agentMode === 'MC' || agentMode === 'HUM' ? agentMode : 'ALL'
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
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, must-revalidate' }
    });
  } catch (e) {
    return j(500, { error: 'rpc_exception', message: String(e?.message||e) });
  }
}

function j(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
