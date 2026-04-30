// Endpoint de listas para popular dropdowns do dashboard.
// Retorna clinics + specialties + statuses em uma única chamada.
// Cache: 5min (mudam raramente).
import { supaHeaders } from '../../_lib/supabase.js';

// Status: 1-12 conforme taxonomia Ecuro
const STATUS_LIST = [
  { id: 1,  name: 'À Confirmar' },
  { id: 2,  name: 'Não Respondido' },
  { id: 3,  name: 'Reagendado' },
  { id: 4,  name: 'Confirmado' },
  { id: 5,  name: 'Cancelado' },
  { id: 6,  name: 'Check-in' },
  { id: 7,  name: 'Atendido' },
  { id: 8,  name: 'Concluído' },
  { id: 9,  name: 'Não Resolvido' },
  { id: 10, name: 'Aprovação' },
  { id: 11, name: 'Aguardando Retorno' },
  { id: 12, name: 'Retorno Criado' },
];

export async function onRequestGet({ env, data }) {
  const allowed = data?.user?.allowed_clinic_ids;

  // 1. Clínicas: lê unitConfigs (read-only) — só Ecuro_clinicId + Unidade
  let clinicsUrl = `${env.SUPABASE_URL}/rest/v1/unitConfigs?select=Ecuro_clinicId,Unidade&Ecuro_clinicId=not.is.null&order=Unidade.asc`;
  if (Array.isArray(allowed) && allowed.length > 0) {
    clinicsUrl += `&Ecuro_clinicId=in.(${allowed.join(',')})`;
  }

  // 2. Especialidades: distinct de BI Appointments
  // (lookup não fica caro porque há índice em speciality_id e a tabela tem ~50k rows)
  // Vou usar a função aggregate via PostgREST GET
  // Fallback simples: lista de specialty_name distintas via Payments (mais informativa)
  const specsUrl = `${env.SUPABASE_URL}/rest/v1/BI%20Payments?select=specialty_id,specialty_name&specialty_name=not.is.null&order=specialty_name.asc&limit=1000`;

  try {
    const [clinicsRes, specsRes] = await Promise.all([
      fetch(clinicsUrl, { headers: supaHeaders(env) }),
      fetch(specsUrl, { headers: supaHeaders(env) }),
    ]);
    const clinicsRaw = clinicsRes.ok ? await clinicsRes.json() : [];
    const specsRaw   = specsRes.ok   ? await specsRes.json()   : [];

    const clinics = clinicsRaw.map(c => ({ id: c.Ecuro_clinicId, name: c.Unidade }));

    // Dedup specialties por id
    const specMap = new Map();
    for (const s of specsRaw) {
      if (s.specialty_id && !specMap.has(s.specialty_id)) {
        specMap.set(s.specialty_id, { id: s.specialty_id, name: s.specialty_name });
      }
    }
    const specialties = [...specMap.values()].sort((a,b) => a.name.localeCompare(b.name));

    return new Response(JSON.stringify({
      clinics,
      specialties,
      statuses: STATUS_LIST
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300'  // 5min cache
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'lookup_failed', message: String(e?.message||e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
