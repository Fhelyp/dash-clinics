// Drill-down do bloco "Ações do CRC". Chama crc_acoes_detail(bucket, stage, ...) — mesma base do
// crc_acoes_stats, então a lista bate com o número da tabela.
import { supaHeaders } from '../../_lib/supabase.js';

const BUCKETS = new Set(['resgate', 'resgate_orto', 'follow', 'follow_campanha', 'follow_organico', 'lead_organico', 'indicacao']);
const STAGES  = new Set(['contatos', 'agendados', 'confirmados', 'compareceram', 'receita']);

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const bucket = url.searchParams.get('bucket');
  const stage  = url.searchParams.get('stage');
  const start = url.searchParams.get('start');
  const end   = url.searchParams.get('end');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  if (!start || !end || !bucket || !stage) return j(400, { error: 'missing_params' });
  if (!BUCKETS.has(bucket) || !STAGES.has(stage)) return j(400, { error: 'invalid_bucket_or_stage' });
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

  const creators = url.searchParams.get('creators');
  const agentMode = url.searchParams.get('agent_mode');
  const rpcUrl = `${env.SUPABASE_URL}/rest/v1/rpc/crc_acoes_detail`;
  const body = {
    p_bucket: bucket, p_stage: stage,
    p_start: start + 'T00:00:00-03:00', p_end: end + 'T00:00:00-03:00',
    p_clinic_ids: clinicIdsParam,
    p_creators: creators ? creators.split('|').filter(Boolean) : null,
    p_agent_mode: agentMode === 'MC' || agentMode === 'HUM' ? agentMode : 'ALL',
    p_limit: limit, p_offset: offset
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
