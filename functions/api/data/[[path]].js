// Proxy seguro Supabase PostgREST.
// Apenas SELECT em tabelas allowlisted. Não expõe service_role pro cliente.
// RBAC: se o JWT tem allowed_clinic_ids, injeta filtro clinic_id automaticamente.
import { supaHeaders } from '../../_lib/supabase.js';

const ALLOWED_TABLES = new Set([
  'BI Appointments',
  'BI Appointment Logs',
  'BI Payments',
  'campaign_contacts_cache',
  'sync_state',
]);

// Tabelas que têm coluna clinic_id (pra injeção RBAC)
const TABLES_WITH_CLINIC_ID = new Set([
  'BI Appointments',
  'BI Payments',
  'campaign_contacts_cache',
  'sync_state',
]);

// 'BI Appointment Logs' não tem clinic_id direto — o filtro RBAC é feito via
// join lógico no frontend (cliente intersecta logs com appointments filtrados).

export async function onRequestGet({ params, request, env, data }) {
  const seg = (params.path || []);
  const table = decodeURIComponent(seg[0] || '');
  if (!ALLOWED_TABLES.has(table)) {
    return new Response(JSON.stringify({ error: 'table_not_allowed', table }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  const inUrl = new URL(request.url);
  const upstreamUrl = new URL(`${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`);
  // Copia query params do cliente
  for (const [k, v] of inUrl.searchParams.entries()) {
    upstreamUrl.searchParams.append(k, v);
  }

  // ── RBAC: injeta clinic_id=in.(...) se user tem restrição ──────────────
  const allowed = data?.user?.allowed_clinic_ids;
  if (Array.isArray(allowed) && allowed.length > 0 && TABLES_WITH_CLINIC_ID.has(table)) {
    // Combina com filtro existente do cliente:
    // - Se cliente já passou clinic_id=in.(X,Y), intersecta com permitidas
    // - Senão, aplica filtro de permitidas direto
    const clientClinicFilter = inUrl.searchParams.get('clinic_id');
    let finalIds = allowed;
    if (clientClinicFilter) {
      // Extrai IDs do filtro do cliente (formato: in.(uuid1,uuid2) ou eq.uuid)
      const m = /^in\.\(([^)]+)\)$/.exec(clientClinicFilter) || /^eq\.(.+)$/.exec(clientClinicFilter);
      if (m) {
        const clientIds = m[1].split(',').map(s => s.trim()).filter(Boolean);
        const allowedSet = new Set(allowed);
        finalIds = clientIds.filter(id => allowedSet.has(id));
      }
      upstreamUrl.searchParams.delete('clinic_id');
    }
    if (finalIds.length === 0) {
      // Filtro do cliente pediu clínicas que ele não tem acesso → retorna vazio
      return new Response('[]', {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    upstreamUrl.searchParams.append('clinic_id', `in.(${finalIds.join(',')})`);
  }

  const headers = supaHeaders(env);
  // Encaminha Range header (paginação PostgREST)
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  const res = await fetch(upstreamUrl.toString(), { headers });
  const body = await res.text();
  const out = new Headers();
  out.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
  const contentRange = res.headers.get('Content-Range');
  if (contentRange) out.set('Content-Range', contentRange);
  return new Response(body, { status: res.status, headers: out });
}
