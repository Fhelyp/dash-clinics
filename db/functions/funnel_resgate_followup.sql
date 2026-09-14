CREATE OR REPLACE FUNCTION public.funnel_resgate_followup(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '20s'
AS $function$
-- Visao APARTADA do funil de marketing: acao do operador de CRC (resgate/follow-up).
-- COL1 (contatos_cw) = contatos do Chatwoot com tag resgate/follow_1..4, contados pela
--   DATA DE CRIACAO do contato (created_at_cw), igual a coluna de leads do funil de campanha.
--   (10/07: decidido "data da criacao, pra seguir a mesma regra". Nota: created_at_cw e a
--    criacao do CONTATO, nao a data em que a tag foi aplicada — mesma limitacao do funil de leads.)
-- COL2+ = agendamentos do Ecuro (channel_name='CRC' + subchannel), pela data do agendamento.
WITH acao AS (
  SELECT a.id appt_id, a.clinic_id, a.patient_id, a.status,
         CASE a.subchannel_name
           WHEN 'Resgate' THEN 'resgate'
           WHEN 'Follow-Up - Campanha' THEN 'follow_campanha'
           WHEN 'Follow-Up - Orgânico' THEN 'follow_organico'
         END AS bucket
  FROM "BI Appointments" a
  WHERE a.channel_name = 'CRC'
    AND a.subchannel_name IN ('Resgate','Follow-Up - Campanha','Follow-Up - Orgânico')
    AND a.created_at >= p_start AND a.created_at < p_end
    AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))),
conf AS (
  SELECT ac.appt_id FROM acao ac
  WHERE ac.status IN (7,8)
     OR EXISTS (SELECT 1 FROM "BI Appointment Logs" lg
                WHERE lg.appointment_id = ac.appt_id AND lg.to_status = 4)),
pay AS (
  SELECT DISTINCT ac.bucket, p.id pay_id, p.amount
  FROM acao ac
  JOIN "BI Payments" p ON p.patient_id = ac.patient_id AND p.clinic_id = ac.clinic_id
   AND p.deleted_at IS NULL AND p.date >= p_start AND p.date < p_end),
agg AS (
  SELECT ac.bucket,
         COUNT(*) agendados,
         COUNT(*) FILTER (WHERE ac.appt_id IN (SELECT appt_id FROM conf)) confirmados,
         COUNT(*) FILTER (WHERE ac.status = 8) compareceram,
         COUNT(DISTINCT ac.patient_id) pacientes
  FROM acao ac GROUP BY ac.bucket),
rev AS (SELECT bucket, COALESCE(SUM(amount),0)::numeric receita FROM pay GROUP BY bucket),
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
  'buckets', COALESCE(jsonb_object_agg(agg.bucket, jsonb_build_object(
      'agendados', agg.agendados, 'confirmados', agg.confirmados,
      'compareceram', agg.compareceram, 'pacientes', agg.pacientes,
      'receita', COALESCE(rev.receita,0))), '{}'::jsonb),
  'rules', jsonb_build_object(
    'col1','contatos Chatwoot com tag resgate/follow_1..4, pela data de criacao do contato (created_at_cw)',
    'col2','agendamentos Ecuro (CRC + subchannel), pela data do agendamento (created_at)',
    'carencia','nao se aplica',
    'aviso','paciente em mais de um bucket conta nos dois; nao somar receitas cegamente')
) FROM agg LEFT JOIN rev ON rev.bucket = agg.bucket;
$function$
