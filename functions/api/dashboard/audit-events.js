// Endpoint para tabelas de Auditoria — Confirmações e Reagendamentos.
// Retorna LOGS (não appointments) com dados do appointment "embedados" via PostgREST resource embedding.
// Agora a fonte de verdade é "quem fez a ação", não "qual o status atual".
//
// Query params:
//   start, end (datas obrigatórias — filtra changeDate)
//   type=confirmation | reschedule  (mapeia pra to_status 4 ou 3)
//   page, pp, sort_order
//   clinic_ids (filtra appointment.clinic_id via embed)
//   creators   (filtra appointment.created_by_name via embed — opcional)
//   user_ids   (filtra log.user_id — quem fez a ação)
//   is_mc      ('true' | 'false') — atalho: filtra user_id = MC ou != MC
import { supaHeaders } from '../../_lib/supabase.js';

const MC_USER_ID = 'fs22aka-7860-431d-b312-a9a72eb7d27a';

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end   = url.searchParams.get('end');
  const type  = url.searchParams.get('type') || 'confirmation';
  const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pp    = Math.min(100, Math.max(10, parseInt(url.searchParams.get('pp') || '25', 10)));
  const sortOrd = url.searchParams.get('sort_order') === 'asc' ? 'asc' : 'desc';
  const clinicIdsRaw = url.searchParams.get('clinic_ids') || '';
  const creatorsRaw  = url.searchParams.get('creators') || '';
  const userIdsRaw   = url.searchParams.get('user_ids') || '';
  const isMcParam    = url.searchParams.get('is_mc');

  if (!start || !end) return j(400, { error: 'missing_params' });

  const toStatus = type === 'reschedule' ? 3 : 4;

  // RBAC
  const allowed = data?.user?.allowed_clinic_ids;
  let finalClinicIds = clinicIdsRaw ? clinicIdsRaw.split(',').filter(Boolean) : null;
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (finalClinicIds) {
      const allowedSet = new Set(allowed);
      finalClinicIds = finalClinicIds.filter(c => allowedSet.has(c));
      if (finalClinicIds.length === 0) {
        return new Response(JSON.stringify({ data: [], pagination: { page, pp, total: 0, total_pages: 0 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    } else {
      finalClinicIds = allowed;
    }
  }

  const qs = new URLSearchParams();
  // Embed: pega appointment relacionado pra mostrar paciente/clínica.
  // Sintaxe PostgREST: select=...,appointment:BI Appointments(...)
  qs.set('select', 'id,appointment_id,user_id,from_status,to_status,changeDate,appointment:BI Appointments!inner(id,patient_id,patient_name,clinic_id,start_time,scheduled_start_time,doctor_name,speciality_id,phone,created_by_name,status,type,campaign_token)');
  qs.append('to_status', `eq.${toStatus}`);
  qs.append('changeDate', `gte.${start}T00:00:00+00:00`);
  qs.append('changeDate', `lt.${end}T00:00:00+00:00`);

  if (finalClinicIds && finalClinicIds.length > 0) {
    qs.append('appointment.clinic_id', `in.(${finalClinicIds.join(',')})`);
  }

  if (creatorsRaw) {
    const list = creatorsRaw.split('|').map(s => s.trim()).filter(Boolean);
    if (list.length === 1) {
      qs.append('appointment.created_by_name', `ilike.${list[0]}`);
    } else if (list.length > 1) {
      const safe = list.map(s => `"${s.replace(/"/g, '\\"')}"`).join(',');
      qs.append('appointment.created_by_name', `in.(${safe})`);
    }
  }

  if (userIdsRaw) {
    const ids = userIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 1) qs.append('user_id', `eq.${ids[0]}`);
    else if (ids.length > 1) qs.append('user_id', `in.(${ids.join(',')})`);
  } else if (isMcParam === 'true') {
    qs.append('user_id', `eq.${MC_USER_ID}`);
  } else if (isMcParam === 'false') {
    qs.append('user_id', `neq.${MC_USER_ID}`);
  }

  qs.set('order', `changeDate.${sortOrd}`);

  const from = (page - 1) * pp;
  const to   = from + pp - 1;
  const upstreamUrl = `${env.SUPABASE_URL}/rest/v1/BI%20Appointment%20Logs?${qs.toString()}`;

  try {
    const res = await fetch(upstreamUrl, {
      headers: { ...supaHeaders(env), 'Range-Unit': 'items', Range: `${from}-${to}`, Prefer: 'count=exact' }
    });
    if (!res.ok && res.status !== 206) {
      return j(res.status, { error: 'query_failed', message: (await res.text()).slice(0, 300) });
    }
    const rows = await res.json();
    const cr = res.headers.get('Content-Range') || '';
    const m = /\/(\d+)$/.exec(cr);
    const total = m ? parseInt(m[1], 10) : rows.length;

    // Achata pra UI: cada row vira { ...log, ...appt }
    const flat = rows.map(r => {
      const a = r.appointment || {};
      return {
        log_id: r.id,
        appointment_id: r.appointment_id,
        user_id: r.user_id,
        is_mc: r.user_id === MC_USER_ID,
        from_status: r.from_status,
        to_status: r.to_status,
        action_at: r.changeDate,
        patient_id: a.patient_id,
        patient_name: a.patient_name,
        clinic_id: a.clinic_id,
        start_time: a.start_time,
        scheduled_start_time: a.scheduled_start_time,
        doctor_name: a.doctor_name,
        speciality_id: a.speciality_id,
        phone: a.phone,
        created_by_name: a.created_by_name,
        type: a.type,
        campaign_token: a.campaign_token
      };
    });

    return new Response(JSON.stringify({
      data: flat,
      pagination: { page, pp, total, total_pages: Math.max(1, Math.ceil(total / pp)) }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return j(500, { error: 'fetch_failed', message: String(e?.message || e) });
  }
}

function j(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
