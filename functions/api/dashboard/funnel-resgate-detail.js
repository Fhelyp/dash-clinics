// Drill-down do funil de Resgate/Follow-up. Chama funnel_resgate_detail(bucket, stage, ...).
import { supaHeaders } from '../../_lib/supabase.js';

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const bucket = url.searchParams.get('bucket');   // resgate | follow
  const stage  = url.searchParams.get('stage');    // contatos | agendados | confirmados | compareceram
  const start = url.searchParams.get('start');
  const end   = url.searchParams.get('end');
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (!start || !end || !bucket || !stage) return j(400, { error: 'missing_params' });
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!reDate.test(start) || !reDate.test(end)) return j(400, { error: 'invalid_date_format' });

  // RBAC (idêntico ao funnel.js)
  const allowed = data?.user?.allowed_clinic_ids;
  const clientClinicsRaw = url.searchParams.get('clinic_ids') || '';
  let clinicIdsParam = null;
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (clientClinicsRaw) {
      const clientIds = clientClinicsRaw.split(',').filter(Boolean);
      const allowedSet = new Set(allowed);
      clinicIdsParam = clientIds.filter(c => allowedSet.has(c));
      if (clinicIdsParam.length === 0) clinicIdsParam = ['__none__'];
    } else { clinicIdsParam = allowed; }
  } else if (clientClinicsRaw) {
    clinicIdsParam = clientClinicsRaw.split(',').filter(Boolean);
    if (clinicIdsParam.length === 0) clinicIdsParam = null;
  }

  const rpcUrl = `${env.SUPABASE_URL}/rest/v1/rpc/funnel_resgate_detail`;
  const body = {
    p_bucket: bucket, p_stage: stage,
    p_start: start + 'T00:00:00-03:00', p_end: end + 'T00:00:00-03:00',
    p_clinic_ids: clinicIdsParam, p_limit: limit, p_offset: offset
  };
  try {
    const res = await fetch(rpcUrl, { method: 'POST',
      headers: { ...supaHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const txt = await res.text();
    if (!res.ok) return j(res.status, { error: 'rpc_error', message: txt.slice(0,300) });
    return new Response(txt, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) { return j(500, { error: 'rpc_exception', message: String(e?.message||e) }); }
}
function j(status, body) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
