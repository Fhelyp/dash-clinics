CREATE OR REPLACE FUNCTION public.funnel_detail(p_stage text, p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_min_lead_created_at timestamp with time zone DEFAULT '2026-04-06 00:00:00+00'::timestamp with time zone, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_origem_channels text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET statement_timeout TO '25s'
AS $function$
DECLARE v_result jsonb;
BEGIN
  WITH
  chegada_ec AS (SELECT patient_id, MIN(created_at) AS chegada
                 FROM "BI Appointments" WHERE subchannel_name = 'Lead Campanha' GROUP BY 1),
  cand AS MATERIALIZED (
    SELECT a.id AS appt_id FROM "BI Appointments" a
    WHERE a.subchannel_name = 'Lead Campanha'
      AND a.created_at >= p_start AND a.created_at < p_end
      AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))
    UNION
    SELECT att.appt_id FROM campaign_appt_attribution att
    WHERE att.created_at >= p_start AND att.created_at < p_end
      AND (p_clinic_ids IS NULL OR att.clinic_id = ANY(p_clinic_ids))
  ),
  -- 1a consulta de campanha de cada paciente (base da elegibilidade v6)
  prim AS (SELECT a.patient_id, MIN(a.start_time) AS t0
           FROM cand JOIN "BI Appointments" a ON a.id = cand.appt_id GROUP BY 1),
  pac_ok AS (
    SELECT p.patient_id FROM prim p
    WHERE NOT EXISTS (SELECT 1 FROM "BI Appointments" x
                      WHERE x.patient_id = p.patient_id
                        AND x.attended_time IS NOT NULL
                        AND x.start_time < p.t0)),
  appt AS (
    SELECT a.clinic_id, a.patient_id, a.id AS appt_id, a.status, a.start_time,
           a.attended_time, a.confirmed_time,
           a.phone_norm, a.patient_name, a.patient_channel_name,
           (att.appt_id IS NOT NULL) AS via_cw,
           (a.subchannel_name = 'Lead Campanha') AS via_ec,
           att.lead_phone, att.lead_name, att.cw_contact_id, att.account_id, att.lead_created_at,
           ce.chegada,
           (o.patient_id IS NOT NULL) AS elegivel
    FROM cand
    JOIN "BI Appointments" a ON a.id = cand.appt_id
    LEFT JOIN campaign_appt_attribution att ON att.appt_id = a.id
    LEFT JOIN chegada_ec ce ON ce.patient_id = a.patient_id
    LEFT JOIN pac_ok o ON o.patient_id = a.patient_id),
  pac AS MATERIALIZED (
    SELECT ap.clinic_id, ap.patient_id,
      bool_or(ap.via_cw) via_cw, bool_or(ap.via_ec) via_ec,
      bool_or(ap.elegivel) agendou,
      bool_or(ap.confirmed_time IS NOT NULL OR ap.status IN (7,8)
              OR EXISTS (SELECT 1 FROM "BI Appointment Logs" lg
                         WHERE lg.appointment_id = ap.appt_id AND lg.to_status = 4)) confirmou,
      bool_or(ap.elegivel AND ap.attended_time IS NOT NULL) compareceu,
      COALESCE(MAX(ap.lead_phone), MAX(ap.phone_norm)) phone_norm,
      -- FIX 2: nome do PACIENTE (Ecuro) primeiro; o do lead do Chatwoot so no fallback
      COALESCE(MAX(ap.patient_name), MAX(ap.lead_name)) lead_name,
      MAX(ap.cw_contact_id) cw_contact_id, MAX(ap.account_id) account_id,
      COALESCE(MIN(ap.lead_created_at), MIN(ap.chegada)) lead_created_at,
      array_agg(DISTINCT ap.patient_channel_name) FILTER (WHERE ap.patient_channel_name IS NOT NULL) origens
    FROM appt ap GROUP BY 1,2),
  pg AS (
    SELECT pc.patient_id, COALESCE(SUM(p.amount),0)::numeric total_pago, COUNT(p.id)::int n_pgto
    FROM pac pc
    LEFT JOIN "BI Payments" p ON p.patient_id = pc.patient_id AND p.deleted_at IS NULL
      AND p.date >= p_start AND p.date < p_end
      AND (p_clinic_ids IS NULL OR p.clinic_id = ANY(p_clinic_ids))
    GROUP BY 1),
  base AS (
    SELECT cl.phone_norm, cl.ecuro_clinic_id AS lead_clinic_id, cl.account_id, cl.id AS cw_contact_id,
           cl.name AS lead_name, cl.created_at_cw AS lead_created_at,
           NULL::uuid[] AS patient_ids, ARRAY[]::text[] AS patient_channel_names,
           false confirmou, false compareceu, false agendou, 0::numeric total_pago, 0::int n_pgto
    FROM (SELECT DISTINCT ON (phone_norm) * FROM chatwoot_leads
          WHERE 'campanha' = ANY(labels) AND phone_norm IS NOT NULL AND length(phone_norm) >= 10
            AND created_at_cw >= GREATEST(p_start, p_min_lead_created_at) AND created_at_cw < p_end
            AND (p_clinic_ids IS NULL OR ecuro_clinic_id = ANY(p_clinic_ids))
          ORDER BY phone_norm, created_at_cw DESC) cl
    WHERE p_stage = 'leads'
    UNION ALL
    SELECT pc.phone_norm, pc.clinic_id, pc.account_id, pc.cw_contact_id, pc.lead_name, pc.lead_created_at,
           ARRAY[pc.patient_id]::uuid[], COALESCE(pc.origens, ARRAY[]::text[]),
           pc.confirmou, pc.compareceu, pc.agendou, COALESCE(g.total_pago,0), COALESCE(g.n_pgto,0)
    FROM pac pc LEFT JOIN pg g ON g.patient_id = pc.patient_id
    WHERE p_stage <> 'leads'),
  filtered AS MATERIALIZED (
    SELECT * FROM base
    WHERE CASE p_stage
        WHEN 'leads'        THEN true
        WHEN 'agendados'    THEN agendou
        WHEN 'confirmados'  THEN confirmou
        WHEN 'compareceram' THEN compareceu
        WHEN 'venderam'     THEN agendou AND total_pago > 0
        ELSE false END
      AND (p_search IS NULL OR p_search = '' OR
           lower(public.immutable_unaccent(lead_name)) ILIKE '%'||lower(public.immutable_unaccent(p_search))||'%' OR
           phone_norm ILIKE '%'||regexp_replace(p_search,'[^0-9]','','g')||'%')
      AND (p_origem_channels IS NULL OR patient_channel_names && p_origem_channels))
  SELECT jsonb_build_object('stage', p_stage, 'count', (SELECT COUNT(*) FROM filtered),
    'limit', p_limit, 'offset', p_offset,
    'rows', COALESCE((SELECT jsonb_agg(row_to_json(r)) FROM (
       SELECT phone_norm, lead_clinic_id, account_id, cw_contact_id, lead_name, lead_created_at,
              patient_ids, patient_channel_names, confirmou, compareceu, total_pago, n_pgto
       FROM filtered ORDER BY CASE WHEN p_stage='venderam' THEN total_pago ELSE 0 END DESC, lead_created_at DESC
       LIMIT p_limit OFFSET p_offset) r), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END $function$
