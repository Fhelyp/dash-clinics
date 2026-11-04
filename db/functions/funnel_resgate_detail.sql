CREATE OR REPLACE FUNCTION public.funnel_resgate_detail(p_bucket text, p_stage text, p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '30s'
AS $function$
-- Drill do bloco Resgate & Follow-up. Mesmas regras de funnel_resgate_followup:
--   agendados/confirmados/compareceram = uma linha por agendamento do periodo;
--   "pago" de cada agendamento = pagamentos do periodo cuja ultima consulta atendida antes deles
--     e ESTE agendamento (nao repete o mesmo pagamento em varias linhas, respeita a unidade);
--   receita = uma linha por paciente com os pagamentos do periodo atribuidos a acao.
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
  WHERE p_stage = 'contatos'
    AND cl.labels && tags.list AND cl.phone_norm IS NOT NULL AND length(cl.phone_norm) >= 10
    AND cl.created_at_cw >= p_start AND cl.created_at_cw < p_end
    AND (p_clinic_ids IS NULL OR cl.ecuro_clinic_id = ANY(p_clinic_ids))
  ORDER BY cl.phone_norm, cl.created_at_cw DESC),
-- pagamentos do período com a consulta atendida que veio logo antes de cada um
pay AS MATERIALIZED (
  SELECT p.patient_id, p.amount, p.date, ult.id AS ult_appt_id, ult.subchannel_name AS ult_sub,
         ult.start_time AS ult_start, ult.patient_name, ult.phone_norm
  FROM "BI Payments" p
  CROSS JOIN LATERAL (SELECT x.id, x.subchannel_name, x.start_time, x.patient_name, x.phone_norm
                      FROM "BI Appointments" x
                      WHERE x.patient_id = p.patient_id AND x.attended_time IS NOT NULL AND x.start_time <= p.date
                      ORDER BY x.start_time DESC LIMIT 1) ult
  WHERE p_stage <> 'contatos'
    AND p.deleted_at IS NULL AND p.date >= p_start AND p.date < p_end
    AND NOT (btrim(COALESCE(p.payment_type_name,'')) ILIKE 'boleto programado' AND COALESCE(p.is_confirmed,false) = false)
    AND (p_clinic_ids IS NULL OR p.clinic_id = ANY(p_clinic_ids))
    AND ult.subchannel_name = ANY((SELECT list FROM subs)::text[])),
-- agendamentos do Ecuro (col2+)
ag AS (
  SELECT a.patient_name AS nome, a.phone_norm AS telefone,
         to_char(a.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS data,
         CASE WHEN a.attended_time IS NOT NULL THEN 'compareceu'
              ELSE CASE a.status WHEN 8 THEN 'concluído' WHEN 7 THEN 'atendido' WHEN 4 THEN 'confirmado'
                     WHEN 11 THEN 'aguard. retorno' WHEN 12 THEN 'retorno criado' WHEN 5 THEN 'cancelado'
                     WHEN 1 THEN 'à confirmar' ELSE a.status::text END END AS status,
         COALESCE((SELECT SUM(py.amount) FROM pay py WHERE py.ult_appt_id = a.id), 0)::numeric AS pago,
         a.patient_id, a.id appt_id, a.status status_code, a.attended_time
  FROM "BI Appointments" a CROSS JOIN subs
  WHERE p_stage IN ('agendados','confirmados','compareceram')
    AND a.channel_name='CRC' AND a.subchannel_name = ANY(subs.list)
    AND a.created_at >= p_start AND a.created_at < p_end
    AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))),
-- receita: um paciente por linha
rec AS (
  SELECT MAX(py.patient_name) AS nome, MAX(py.phone_norm) AS telefone,
         to_char(MAX(py.date) AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS data,
         to_char(MAX(py.ult_start) AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS status,
         SUM(py.amount)::numeric AS pago, py.patient_id
  FROM pay py
  WHERE p_stage = 'receita'
  GROUP BY py.patient_id),
filtered AS (
  SELECT nome,telefone,data,status,pago,patient_id FROM contatos
  UNION ALL
  SELECT nome,telefone,data,status,pago,patient_id FROM ag
  WHERE CASE p_stage
     WHEN 'agendados' THEN true
     WHEN 'confirmados' THEN status_code IN (7,8) OR attended_time IS NOT NULL
                             OR EXISTS (SELECT 1 FROM "BI Appointment Logs" lg WHERE lg.appointment_id=ag.appt_id AND lg.to_status=4)
     WHEN 'compareceram' THEN attended_time IS NOT NULL
     ELSE false END
  UNION ALL
  SELECT nome,telefone,data,status,pago,patient_id FROM rec)
SELECT jsonb_build_object('bucket',p_bucket,'stage',p_stage,
  'count',(SELECT COUNT(*) FROM filtered),
  'total_pago',(SELECT COALESCE(SUM(pago),0) FROM filtered),
  'rows', COALESCE((SELECT jsonb_agg(row_to_json(r)) FROM (
    SELECT nome,telefone,data,status,pago,patient_id FROM filtered
    ORDER BY pago DESC, nome LIMIT p_limit OFFSET p_offset) r),'[]'::jsonb));
$function$;
