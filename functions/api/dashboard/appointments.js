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
  const creatorsRaw = url.searchParams.get('creators') || '';

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
  qs.set('select', 'id,patient_id,patient_name,clinic_id,doctor_name,start_time,scheduled_start_time,status,speciality_id,channel_id,created_by_name,phone,type,campaign_token');
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

  // Filtro de creators usando coluna geradora `created_by_name_norm`
  // (lower + trim + colapsa espaços + remove acentos). Resolve casos:
  //   "Pedro Leão" == "Pedro Leao", "Gleyce  Marques" == "Gleyce Marques", " Giovana" trim, etc.
  if (creatorsRaw) {
    const norm = (s) => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'')
      .toLowerCase().replace(/\s+/g,' ').trim();
    const list = creatorsRaw.split('|').map(s => norm(s)).filter(Boolean);
    if (list.length === 1) {
      qs.append('created_by_name_norm', `eq.${list[0]}`);
    } else if (list.length > 1) {
      const safe = list.map(s => `"${s.replace(/"/g, '\\"')}"`).join(',');
      qs.append('created_by_name_norm', `in.(${safe})`);
    }
  }

  // Search: usa colunas geradas (patient_name_norm, phone_norm) pra ser
  //  - acento-insensitive (idecácio == idecacio)
  //  - tolerante a 9º dígito do celular BR (1198765432X bate com 11987654321 e 1187654321)
  //  - tolerante a chars especiais no telefone (apenas dígitos contam)
  if (search) {
    const digits = search.replace(/\D/g, '');
    // Normalize nome: lower + remove diacríticos (NFD → strip combining marks U+0300..U+036F)
    const nameNorm = search.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[(),*]/g, ' ').trim();

    // Variantes de telefone: gera tanto a versão com 9 quanto sem 9
    // (heurística BR mobile: DDD = 2 dig, 9 opcional, 8 dig)
    const phoneVariants = new Set();
    if (digits.length >= 4) {
      phoneVariants.add(digits);
      // 10 dígitos: DDD (2) + 8 dig — adiciona variante com 9 (DDD + 9 + 8)
      if (digits.length === 10) phoneVariants.add(digits.slice(0,2) + '9' + digits.slice(2));
      // 11 dígitos com 9 no terceiro char: DDD + 9 + 8 — adiciona sem 9
      if (digits.length === 11 && digits[2] === '9') phoneVariants.add(digits.slice(0,2) + digits.slice(3));
      // 13 dígitos (CC + DDD + 9 + 8): adiciona sem CC e sem 9
      if (digits.length === 13 && digits.slice(0,2) === '55' && digits[4] === '9') {
        phoneVariants.add(digits.slice(2)); // CC stripped
        phoneVariants.add(digits.slice(2,4) + digits.slice(5)); // CC + sem 9
      }
      // 12 dígitos (CC + DDD + 8): adiciona sem CC + adiciona com 9
      if (digits.length === 12 && digits.slice(0,2) === '55') {
        phoneVariants.add(digits.slice(2));
        phoneVariants.add(digits.slice(2,4) + '9' + digits.slice(4));
      }
    }

    if (phoneVariants.size > 0 || nameNorm) {
      const orParts = [];
      if (nameNorm) orParts.push(`patient_name_norm.ilike.*${nameNorm}*`);
      for (const v of phoneVariants) orParts.push(`phone_norm.ilike.*${v}*`);
      // PostgREST OR clause aceita 1+ cláusulas
      if (orParts.length > 0) qs.append('or', `(${orParts.join(',')})`);
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
