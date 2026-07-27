CREATE OR REPLACE FUNCTION public.funnel_resgate_detail(p_bucket text, p_stage text, p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '20s'
AS $function$
WITH subs AS (SELECT CASE WHEN p_bucket='resgate' THEN ARRAY['Resgate']
                          WHEN p_bucket='follow_campanha' THEN ARRAY['Follow-Up - Campanha']
                          WHEN p_bucket='follow_organico' THEN ARRAY['Follow-Up - Orgânico']
                          ELSE ARRAY['Follow-Up - Campanha','Follow-Up - Orgânico'] END AS list),
tags AS (SELECT CASE WHEN p_bucket='resgate' THEN ARRAY['resgate']
                     ELSE ARRAY['follow_1','follow_2','follow_3','follow_4'] END AS list),
-- COL1: contatos do Chatwoot com a tag, criados no período
contatos AS (
  SELECT DISTINCT ON (cl.phone_norm) cl.name AS nome, cl.phone_norm AS telefone,
         to_char(cl.created_at_cw AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS data,
         NULL::text AS status, 0::numeric AS pago, NULL::uuid AS patient_id
  FROM chatwoot_leads cl CROSS JOIN tags
  WHERE cl.labels && tags.list AND cl.phone_norm IS NOT NULL AND length(cl.phone_norm) >= 10
    AND cl.created_at_cw >= p_start AND cl.created_at_cw < p_end
    AND (p_clinic_ids IS NULL OR cl.ecuro_clinic_id = ANY(p_clinic_ids))
  ORDER BY cl.phone_norm, cl.created_at_cw DESC),
-- agendamentos do Ecuro (col2+)
ag AS (
  SELECT a.patient_name AS nome, a.phone_norm AS telefone,
         to_char(a.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS data,
         CASE a.status WHEN 8 THEN 'concluído' WHEN 7 THEN 'atendido' WHEN 4 THEN 'confirmado'
              WHEN 11 THEN 'aguard. retorno' WHEN 12 THEN 'retorno criado' WHEN 5 THEN 'cancelado'
              WHEN 1 THEN 'à confirmar' ELSE a.status::text END AS status,
         COALESCE((SELECT SUM(p.amount) FROM "BI Payments" p WHERE p.patient_id=a.patient_id
                   AND p.deleted_at IS NULL AND p.date>=p_start AND p.date<p_end),0)::numeric AS pago,
         a.patient_id, a.id appt_id, a.status status_code
  FROM "BI Appointments" a CROSS JOIN subs
  WHERE a.channel_name='CRC' AND a.subchannel_name = ANY(subs.list)
    AND a.created_at >= p_start AND a.created_at < p_end
    AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))),
filtered AS (
  SELECT nome,telefone,data,status,pago,patient_id FROM contatos WHERE p_stage='contatos'
  UNION ALL
  SELECT nome,telefone,data,status,pago,patient_id FROM ag
  WHERE p_stage <> 'contatos' AND CASE p_stage
     WHEN 'agendados' THEN true
     WHEN 'confirmados' THEN status_code IN (7,8) OR EXISTS (SELECT 1 FROM "BI Appointment Logs" lg WHERE lg.appointment_id=ag.appt_id AND lg.to_status=4)
     WHEN 'compareceram' THEN status_code = 8
     ELSE false END)
SELECT jsonb_build_object('bucket',p_bucket,'stage',p_stage,
  'count',(SELECT COUNT(*) FROM filtered),
  'rows', COALESCE((SELECT jsonb_agg(row_to_json(r)) FROM (
    SELECT nome,telefone,data,status,pago,patient_id FROM filtered
    ORDER BY pago DESC, nome LIMIT p_limit OFFSET p_offset) r),'[]'::jsonb));
$function$
