// Endpoint paginado para tabelas (Auditoria).
// Retorna appointments individuais COM filtros + busca + paginação.
// Não baixa em massa — só a página atual.
import { supaHeaders } from '../../_lib/supabase.js';

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const start    = url.searchParams.get('start');
  const end      = url.searchParams.get('end');
  const search   = (url.searchParams.get('search') || '').trim();
  const page     = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pp       = Math.min(100, Math.max(10, parseInt(url.searchParams.get('pp') || '25', 10)));
  const sortBy   = url.searchParams.get('sort_by') || 'start_time';
  const sortOrd  = url.searchParams.get('sort_order') === 'asc' ? 'asc' : 'desc';
  const onlyStatus = url.searchParams.get('only_status'); // ex: '4' ou '3' pra confirmações/reagendamentos
  const clinicIdsRaw = url.searchParams.get('clinic_ids') || '';
  const specialtyIdsRaw = url.searchParams.get('specialty_ids') || '';
  const statusCodesRaw = url.searchParams.get('status_codes') || '';

  if (!start || !end) {
    return j(400, { error: 'missing_params', message: 'start e end obrigatórios' });
  }

  // RBAC: intersecta clinic_ids do client com allowed_clinic_ids do JWT
  const allowed = data?.user?.allowed_clinic_ids;
  let finalClinicIds = clinicIdsRaw ? clinicIdsRaw.split(',').filter(Boolean) : null;
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (finalClinicIds) {
      const allowedSet = new Set(allowed);
      finalClinicIds = finalClinicIds.filter(c => allowedSet.has(c));
      if (finalClinicIds.length === 0) {
        return new Response(JSON.stringify({ data: [], pagination: { page, pp, total: 0, total_pages: 0 } }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }
    } else {
      finalClinicIds = allowed;
    }
  }

  // Monta query PostgREST
  const qs = new URLSearchParams();
  qs.set('select', 'id,patient_id,patient_name,clinic_id,doctor_name,start_time,scheduled_start_time,status,speciality_id,channel_id,created_by_name,phone');
  qs.append('start_time', `gte.${start}T00:00:00+00:00`);
  qs.append('start_time', `lt.${end}T00:00:00+00:00`);

  if (finalClinicIds && finalClinicIds.length > 0) {
    qs.append('clinic_id', `in.(${finalClinicIds.join(',')})`);
  }
  if (specialtyIdsRaw) {
    const ids = specialtyIdsRaw.split(',').filter(Boolean);
    if (ids.length > 0) qs.append('speciality_id', `in.(${ids.join(',')})`);
  }
  if (statusCodesRaw) {
    const codes = statusCodesRaw.split(',').map(c => parseInt(c,10)).filter(n => !isNaN(n));
    if (codes.length > 0) qs.append('status', `in.(${codes.join(',')})`);
  }
  if (onlyStatus) {
    qs.append('status', `eq.${parseInt(onlyStatus,10)}`);
  }

  // Search: nome (com acentos) OU telefone.
  // IMPORTANTE: NÃO usar encodeURIComponent aqui — URLSearchParams.append já encoda.
  // Escape de chars especiais do PostgREST OR syntax: () , *
  if (search) {
    const digits = search.replace(/\D/g, '');
    // Limpa caracteres especiais que quebrariam o OR clause do PostgREST
    const safeSearch = search.replace(/[(),*]/g, ' ').trim();
    if (digits.length >= 4) {
      qs.append('or', `(patient_name.ilike.*${safeSearch}*,phone.ilike.*${digits}*)`);
    } else if (safeSearch) {
      qs.append('patient_name', `ilike.*${safeSearch}*`);
    }
  }

  // Ordenação
  const sortMap = { datetime: 'start_time', patient_name: 'patient_name', clinic_id: 'clinic_id', status: 'status' };
  const sortCol = sortMap[sortBy] || 'start_time';
  qs.set('order', `${sortCol}.${sortOrd}`);

  // Paginação via Range
  const from = (page - 1) * pp;
  const to   = from + pp - 1;

  const upstreamUrl = `${env.SUPABASE_URL}/rest/v1/BI%20Appointments?${qs.toString()}`;
  try {
    const res = await fetch(upstreamUrl, {
      headers: { ...supaHeaders(env), 'Range-Unit': 'items', Range: `${from}-${to}`, Prefer: 'count=exact' }
    });
    if (!res.ok && res.status !== 206) {
      return j(res.status, { error: 'query_failed', message: (await res.text()).slice(0,300) });
    }
    const rows = await res.json();
    const cr = res.headers.get('Content-Range') || '';
    const m = /\/(\d+)$/.exec(cr);
    const total = m ? parseInt(m[1], 10) : rows.length;
    return new Response(JSON.stringify({
      data: rows,
      pagination: {
        page, pp, total,
        total_pages: Math.max(1, Math.ceil(total / pp))
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return j(500, { error: 'fetch_failed', message: String(e?.message||e) });
  }
}

function j(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
