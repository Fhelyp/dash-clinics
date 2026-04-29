// Proxy seguro Supabase PostgREST.
// Apenas SELECT em tabelas allowlisted. Não expõe service_role pro cliente.
import { supaHeaders } from '../../_lib/supabase.js';

const ALLOWED_TABLES = new Set([
  'BI Appointments',
  'BI Appointment Logs',
  'BI Payments',
  'campaign_contacts_cache',
  'sync_state',
]);

export async function onRequestGet({ params, request, env }) {
  const seg = (params.path || []);
  const table = decodeURIComponent(seg[0] || '');
  if (!ALLOWED_TABLES.has(table)) {
    return new Response(JSON.stringify({ error: 'table_not_allowed', table }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }
  const inUrl = new URL(request.url);
  const qs = inUrl.search; // preserva ?select=&filter=&order=&limit= etc
  const upstream = `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}${qs}`;
  const headers = supaHeaders(env);
  // Encaminha Range header (paginação PostgREST)
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  const res = await fetch(upstream, { headers });
  const body = await res.text();
  const out = new Headers();
  out.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
  const contentRange = res.headers.get('Content-Range');
  if (contentRange) out.set('Content-Range', contentRange);
  return new Response(body, { status: res.status, headers: out });
}
