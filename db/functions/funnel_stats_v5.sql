CREATE OR REPLACE FUNCTION public.funnel_stats_v5(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_min_lead_created_at timestamp with time zone DEFAULT '2026-04-06 00:00:00+00'::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '25s'
AS $function$
WITH base AS (
  SELECT a.clinic_id, a.patient_id, a.id AS appt_id, a.status, a.start_time
  FROM "BI Appointments" a
  WHERE a.subchannel_name = 'Lead Campanha'
    AND a.created_at >= p_start AND a.created_at < p_end
    AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))
  UNION
  SELECT a.clinic_id, a.patient_id, a.id, a.status, a.start_time
  FROM campaign_appt_attribution att
  JOIN "BI Appointments" a ON a.id = att.appt_id
  WHERE att.created_at >= p_start AND att.created_at < p_end
    AND (p_clinic_ids IS NULL OR att.clinic_id = ANY(p_clinic_ids))
),
elig AS (
  SELECT b.* FROM base b
  WHERE NOT EXISTS (SELECT 1 FROM "BI Appointments" x
                    WHERE x.patient_id = b.patient_id AND x.status IN (7,8,11,12)
                      AND x.start_time < b.start_time)),
agend AS (SELECT DISTINCT patient_id FROM elig),
comp  AS (SELECT DISTINCT patient_id FROM elig WHERE status = 8),
conf  AS (SELECT DISTINCT b.patient_id FROM base b
          WHERE b.status IN (7,8)
             OR EXISTS (SELECT 1 FROM "BI Appointment Logs" lg
                        WHERE lg.appointment_id = b.appt_id AND lg.to_status = 4)),
pay AS (SELECT DISTINCT p.id pay_id, p.patient_id, p.amount FROM "BI Payments" p
        WHERE p.deleted_at IS NULL AND p.date >= p_start AND p.date < p_end
          AND (p_clinic_ids IS NULL OR p.clinic_id = ANY(p_clinic_ids))
          AND p.patient_id IN (SELECT patient_id FROM agend)),
vend AS (SELECT patient_id, SUM(amount) tot FROM pay GROUP BY patient_id),
leads_periodo AS (
  SELECT DISTINCT phone_norm FROM chatwoot_leads
  WHERE 'campanha' = ANY(labels) AND phone_norm IS NOT NULL AND length(phone_norm) >= 10
    AND created_at_cw >= GREATEST(p_start, p_min_lead_created_at) AND created_at_cw < p_end
    AND (p_clinic_ids IS NULL OR ecuro_clinic_id = ANY(p_clinic_ids))),
m AS (SELECT
    (SELECT COUNT(*) FROM leads_periodo) leads,
    (SELECT COUNT(*) FROM agend) agendados,
    (SELECT COUNT(*) FROM conf)  confirmados,
    (SELECT COUNT(*) FROM comp)  compareceram,
    (SELECT COUNT(*) FROM vend WHERE tot > 0) venderam,
    (SELECT COALESCE(SUM(tot),0)::numeric FROM vend) receita)
SELECT jsonb_build_object(
  'period', jsonb_build_object('start',p_start,'end',p_end),
  'funnel', jsonb_build_object('leads',leads,'agendados',agendados,'confirmados',confirmados,
                               'compareceram',compareceram,'venderam',venderam,'receita_total',receita),
  'conversoes', jsonb_build_object(
    'lead_to_agend', CASE WHEN leads>0 THEN ROUND(100.0*agendados/leads,1) ELSE 0 END,
    'agend_to_conf', CASE WHEN agendados>0 THEN ROUND(100.0*confirmados/agendados,1) ELSE 0 END,
    'conf_to_comp',  CASE WHEN confirmados>0 THEN ROUND(100.0*compareceram/confirmados,1) ELSE 0 END,
    'comp_to_venda', CASE WHEN compareceram>0 THEN ROUND(100.0*venderam/compareceram,1) ELSE 0 END),
  'rules', jsonb_build_object(
    'janela','data em que o operador agendou (created_at)',
    'campanha','tag Chatwoot OU subchannel Lead Campanha (Ecuro)',
    'exclusao','paciente ja ATENDIDO antes (status 7,8,11,12 anterior) = cliente passante',
    'confirmados','totalidade do periodo, sem filtro de elegibilidade',
    'unidade','paciente')
) FROM m;
$function$
