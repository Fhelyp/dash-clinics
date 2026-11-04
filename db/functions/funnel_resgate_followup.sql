CREATE OR REPLACE FUNCTION public.funnel_resgate_followup(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '30s'
AS $function$
-- Visao APARTADA do funil de marketing: acao do operador de CRC (resgate/follow-up).
-- COL1 (contatos_cw) = contatos do Chatwoot com tag resgate/follow_1..4, contados pela
--   DATA DE CRIACAO do contato (created_at_cw), igual a coluna de leads do funil de campanha.
--   (10/07: decidido "data da criacao, pra seguir a mesma regra". Nota: created_at_cw e a
--    criacao do CONTATO, nao a data em que a tag foi aplicada — mesma limitacao do funil de leads.)
-- COL2+ = agendamentos do Ecuro (channel_name='CRC' + subchannel), pela data do agendamento.
--   Compareceram = comparecimento registrado (attended_time), mesma regra do funil de campanha.
-- RECEITA (27/10, confirmada com a Thauany em 04/11): pagamento do periodo vai para a acao da
--   ULTIMA consulta atendida do paciente antes dele — depois de Follow-Up conta como Follow-Up,
--   depois de Resgate como Resgate. E o espelho da regra que tira essa venda da campanha
--   (funnel_v7_rows, CTE pg): cada pagamento conta em um lugar so.
WITH bk(bucket, sub) AS (
  VALUES ('resgate', 'Resgate'), ('follow_campanha', 'Follow-Up - Campanha'), ('follow_organico', 'Follow-Up - Orgânico')),
acao AS (
  SELECT a.id appt_id, a.clinic_id, a.patient_id, a.status, a.attended_time, bk.bucket
  FROM "BI Appointments" a
  JOIN bk ON bk.sub = a.subchannel_name
  WHERE a.channel_name = 'CRC'
    AND a.created_at >= p_start AND a.created_at < p_end
    AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))),
conf AS (
  SELECT ac.appt_id FROM acao ac
  WHERE ac.status IN (7,8) OR ac.attended_time IS NOT NULL
     OR EXISTS (SELECT 1 FROM "BI Appointment Logs" lg
                WHERE lg.appointment_id = ac.appt_id AND lg.to_status = 4)),
pay AS (
  SELECT bk.bucket, p.amount
  FROM "BI Payments" p
  CROSS JOIN LATERAL (SELECT x.subchannel_name FROM "BI Appointments" x
                      WHERE x.patient_id = p.patient_id AND x.attended_time IS NOT NULL AND x.start_time <= p.date
                      ORDER BY x.start_time DESC LIMIT 1) ult
  JOIN bk ON bk.sub = ult.subchannel_name
  WHERE p.deleted_at IS NULL AND p.date >= p_start AND p.date < p_end
    AND NOT (btrim(COALESCE(p.payment_type_name,'')) ILIKE 'boleto programado' AND COALESCE(p.is_confirmed,false) = false)
    AND (p_clinic_ids IS NULL OR p.clinic_id = ANY(p_clinic_ids))),
agg AS (
  SELECT ac.bucket,
         COUNT(*) agendados,
         COUNT(*) FILTER (WHERE ac.appt_id IN (SELECT appt_id FROM conf)) confirmados,
         COUNT(*) FILTER (WHERE ac.attended_time IS NOT NULL) compareceram,
         COUNT(DISTINCT ac.patient_id) pacientes
  FROM acao ac GROUP BY ac.bucket),
rev AS (SELECT bucket, COALESCE(SUM(amount),0)::numeric receita, COUNT(*) pagamentos FROM pay GROUP BY bucket),
-- COL1: contatos do Chatwoot criados no periodo, com tag resgate ou follow_1..4
cw AS (
  SELECT
    COUNT(DISTINCT phone_norm) FILTER (WHERE 'resgate' = ANY(labels)) AS resgate,
    COUNT(DISTINCT phone_norm) FILTER (WHERE labels && ARRAY['follow_1','follow_2','follow_3','follow_4']) AS follow
  FROM chatwoot_leads
  WHERE created_at_cw >= p_start AND created_at_cw < p_end
    AND phone_norm IS NOT NULL AND length(phone_norm) >= 10
    AND (p_clinic_ids IS NULL OR ecuro_clinic_id = ANY(p_clinic_ids)))
SELECT jsonb_build_object(
  'period', jsonb_build_object('start',p_start,'end',p_end),
  'contatos_cw', (SELECT jsonb_build_object('resgate', resgate, 'follow', follow) FROM cw),
  'buckets', jsonb_object_agg(bk.bucket, jsonb_build_object(
      'agendados', COALESCE(agg.agendados,0), 'confirmados', COALESCE(agg.confirmados,0),
      'compareceram', COALESCE(agg.compareceram,0), 'pacientes', COALESCE(agg.pacientes,0),
      'receita', COALESCE(rev.receita,0), 'pagamentos', COALESCE(rev.pagamentos,0))),
  'rules', jsonb_build_object(
    'col1','contatos Chatwoot com tag resgate/follow_1..4, pela data de criacao do contato (created_at_cw)',
    'col2','agendamentos Ecuro (CRC + subchannel), pela data do agendamento (created_at)',
    'compareceram','comparecimento registrado no Ecuro (attended_time)',
    'receita','pagamento do periodo vai para a acao da ultima consulta atendida antes dele (Follow-Up -> Follow-Up, Resgate -> Resgate); a mesma venda sai do funil de campanha',
    'carencia','nao se aplica')
) FROM bk LEFT JOIN agg ON agg.bucket = bk.bucket LEFT JOIN rev ON rev.bucket = bk.bucket;
$function$;
