CREATE OR REPLACE FUNCTION public.dashboard_stats_live(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_specialty_ids uuid[] DEFAULT NULL::uuid[], p_status_codes integer[] DEFAULT NULL::integer[], p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text, p_origem text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET statement_timeout TO '60s'
AS $function$
-- EXECUTE: plano feito com os valores da chamada. Como LANGUAGE sql o plano era genérico e um
-- filtro de Maria Clara/Operadores em 4 dias levava 36 s (1,4 s com plano específico), um mês
-- passava de minutos e o Overview dava timeout (04/11/2026).
DECLARE v jsonb;
BEGIN
EXECUTE $q$
WITH
creators_norm AS (
  SELECT array_agg(lower(public.immutable_unaccent(TRIM(REGEXP_REPLACE(c, '\s+', ' ', 'g'))))) AS list
  FROM unnest(COALESCE($6, ARRAY[]::text[])) c
),
appts AS MATERIALIZED (
  SELECT id, patient_id, clinic_id, status, start_time, channel_id, channel_name, speciality_id, patient_date_of_birth, campaign_token,
    TRIM(REGEXP_REPLACE(COALESCE(created_by_name,''), '\s+', ' ', 'g')) AS creator_name, created_by_name_norm
  FROM "BI Appointments"
  WHERE start_time >= $1 AND start_time < $2
  AND ($3 IS NULL OR clinic_id = ANY($3))
  AND ($4 IS NULL OR speciality_id = ANY($4))
  AND ($5 IS NULL OR status = ANY($5))
  AND ($8 IS NULL OR patient_channel_name = ANY($8))
),
mc_apt_logged AS MATERIALIZED (SELECT DISTINCT appointment_id FROM "BI Appointment Logs" WHERE user_id='fs22aka-7860-431d-b312-a9a72eb7d27a' AND appointment_id IN (SELECT id FROM appts)),
appts_typed AS MATERIALIZED (
  SELECT a.*,
    CASE WHEN a.channel_id IN ('fs22aka-7860-431d-b312-a9a72eb7d27a','hs22aka-7860-434d-b312-a9a72eb7d27a') OR a.channel_name='Maria Clara IA' THEN 'Maria Clara'
         WHEN a.creator_name='' AND a.id IN (SELECT appointment_id FROM mc_apt_logged) THEN 'Maria Clara'
         WHEN a.creator_name='' THEN 'Sem criador' ELSE a.creator_name END AS creator,
    CASE WHEN a.channel_id IN ('fs22aka-7860-431d-b312-a9a72eb7d27a','hs22aka-7860-434d-b312-a9a72eb7d27a') OR a.channel_name='Maria Clara IA' THEN 'mc-channel'
         WHEN a.creator_name='' AND a.id IN (SELECT appointment_id FROM mc_apt_logged) THEN 'mc-logged'
         WHEN a.creator_name='' THEN 'sem criador' ELSE a.created_by_name_norm END AS creator_norm,
    CASE WHEN a.channel_id IN ('fs22aka-7860-431d-b312-a9a72eb7d27a','hs22aka-7860-434d-b312-a9a72eb7d27a') OR a.channel_name='Maria Clara IA' THEN 'MC'
         WHEN a.creator_name='' AND a.id IN (SELECT appointment_id FROM mc_apt_logged) THEN 'MC' ELSE 'HUM' END AS agent
  FROM appts a
),
appts_f AS MATERIALIZED (
  SELECT * FROM appts_typed
  WHERE ($6 IS NULL OR creator_norm IN (SELECT unnest(list) FROM creators_norm))
  AND ($7='ALL' OR $7='' OR agent=$7)
),
patient_set AS MATERIALIZED (SELECT DISTINCT patient_id FROM appts_f WHERE patient_id IS NOT NULL),
pays_all AS MATERIALIZED (
  SELECT id, patient_id, clinic_id, date, amount, specialty_name, specialty_id FROM "BI Payments"
  WHERE date >= $1 AND date < $2 AND deleted_at IS NULL
    -- receita = valor VENDIDO (Thauany 19/10/26): boleto da clinica conta inteiro; boleto programado so quando pago (date = dia do pagamento)
    AND NOT (btrim(COALESCE(payment_type_name,'')) ILIKE 'boleto programado' AND COALESCE(is_confirmed,false) = false)
  AND ($3 IS NULL OR clinic_id = ANY($3))
),
mc_eval_attended AS MATERIALIZED (
  SELECT DISTINCT a.patient_id, a.start_time AS attended_at
  FROM "BI Appointments" a
  WHERE a.patient_id IS NOT NULL
    AND a.status IN (7,8) AND a.speciality_id = '8409c08e-f3fa-43a0-b9bd-53128cecdbdc'
    AND ($3 IS NULL OR a.clinic_id = ANY($3))
    AND a.start_time >= $1 - INTERVAL '31 days' AND a.start_time < $2
    AND (a.channel_id IN ('fs22aka-7860-431d-b312-a9a72eb7d27a','hs22aka-7860-434d-b312-a9a72eb7d27a')
         OR a.channel_name='Maria Clara IA'
         OR EXISTS(SELECT 1 FROM "BI Appointment Logs" lg WHERE lg.appointment_id=a.id AND lg.user_id='fs22aka-7860-431d-b312-a9a72eb7d27a'))
),
pay_attribution_v4 AS MATERIALIZED (
  SELECT DISTINCT ON (p.id) p.id, p.patient_id, p.amount, p.date,
    CASE WHEN m.patient_id IS NOT NULL THEN 'MC' ELSE 'HUM' END AS attribution_agent
  FROM pays_all p
  LEFT JOIN mc_eval_attended m ON m.patient_id=p.patient_id AND m.attended_at <= p.date AND m.attended_at >= p.date - INTERVAL '30 days'
  ORDER BY p.id, m.attended_at DESC NULLS LAST
),
pays AS MATERIALIZED (
  SELECT pa.id, pa.patient_id, pa.clinic_id, pa.date, pa.amount, pa.specialty_name, pa.specialty_id
  FROM pays_all pa LEFT JOIN pay_attribution_v4 v ON v.id = pa.id
  WHERE 
    ($4 IS NULL AND $5 IS NULL AND $6 IS NULL AND $8 IS NULL AND ($7='ALL' OR $7=''))
    OR ($7='MC' AND v.attribution_agent='MC')
    OR ($7='HUM' AND v.attribution_agent='HUM')
    OR (($7='ALL' OR $7='') AND pa.patient_id IN (SELECT patient_id FROM patient_set))
),
logs AS MATERIALIZED (
  SELECT l.id, l.appointment_id, l.user_id, l.from_status, l.to_status, COALESCE(l.is_reschedule, false) AS is_reschedule FROM "BI Appointment Logs" l
  WHERE l."changeDate" >= $1 AND l."changeDate" < $2
  AND (COALESCE(l.is_reschedule,false) = true OR l.to_status = 4)
  AND l.appointment_id IN (SELECT id FROM appts_typed WHERE ($6 IS NULL OR creator_norm IN (SELECT unnest(list) FROM creators_norm)))
),
fin_mensal_data AS (SELECT TO_CHAR(date_trunc('month', date),'YYYY-MM') mes, COALESCE(SUM(amount),0)::numeric valor FROM pays GROUP BY 1)
SELECT jsonb_build_object(
  'period', jsonb_build_object('start', $1, 'end', $2, 'agent_mode', $7),
  'kpis', (SELECT jsonb_build_object(
    'pacientes_unicos', COUNT(DISTINCT patient_id) FILTER (WHERE patient_id IS NOT NULL),
    'agendamentos', COUNT(*), 'concluidos', COUNT(*) FILTER (WHERE status=8),
    'confirmacoes', COUNT(*) FILTER (WHERE status IN (4,5,6,7,8)),
    'reagendamentos', (SELECT COUNT(DISTINCT appointment_id) FROM logs WHERE is_reschedule=true),
    'receita_total', (SELECT COALESCE(SUM(amount),0)::numeric FROM pays),
    'mc_agendamentos', COUNT(*) FILTER (WHERE agent='MC'),
    'mc_concluidos', COUNT(*) FILTER (WHERE agent='MC' AND status IN (7,8)),
    'hum_agendamentos', COUNT(*) FILTER (WHERE agent='HUM'),
    'hum_concluidos', COUNT(*) FILTER (WHERE agent='HUM' AND status IN (7,8))
  ) FROM appts_f),
  'best_month', COALESCE((SELECT jsonb_build_object('mes', mes, 'valor', valor) FROM fin_mensal_data ORDER BY valor DESC LIMIT 1), jsonb_build_object('mes', NULL, 'valor', 0)),
  'fin_mensal', COALESCE((SELECT jsonb_agg(jsonb_build_object('mes', mes, 'valor', valor) ORDER BY mes) FROM fin_mensal_data), '[]'::jsonb),
  'status_mensal', COALESCE((SELECT jsonb_agg(jsonb_build_object('mes', mes, 'status', status, 'count', cnt))
    FROM (SELECT TO_CHAR(date_trunc('month', start_time),'YYYY-MM') mes, status, COUNT(*) cnt FROM appts_f GROUP BY 1,2) s), '[]'::jsonb),
  'unidades_receita', COALESCE((SELECT jsonb_agg(jsonb_build_object('clinic_id', clinic_id, 'valor', valor, 'appts', appts_cnt) ORDER BY valor DESC)
    FROM (SELECT p.clinic_id, SUM(p.amount)::numeric valor, (SELECT COUNT(*) FROM appts_f WHERE clinic_id=p.clinic_id) appts_cnt FROM pays p GROUP BY p.clinic_id) s), '[]'::jsonb),
  'specialty_receita', COALESCE((SELECT jsonb_agg(jsonb_build_object('specialty_id', specialty_id, 'specialty', specialty_name, 'valor', valor) ORDER BY valor DESC)
    FROM (SELECT specialty_id, specialty_name, SUM(amount)::numeric valor FROM pays WHERE specialty_name IS NOT NULL GROUP BY 1,2) s), '[]'::jsonb),
  'idade_buckets', COALESCE((SELECT jsonb_object_agg(bucket, cnt) FROM (
      SELECT CASE WHEN patient_date_of_birth IS NULL THEN 'sem_idade'
        WHEN AGE(patient_date_of_birth)<INTERVAL '11 years' THEN '0_10'
        WHEN AGE(patient_date_of_birth)<INTERVAL '21 years' THEN '11_20'
        WHEN AGE(patient_date_of_birth)<INTERVAL '41 years' THEN '21_40'
        WHEN AGE(patient_date_of_birth)<INTERVAL '61 years' THEN '41_60' ELSE '60_plus' END bucket,
        COUNT(DISTINCT patient_id) cnt FROM (SELECT DISTINCT patient_id, patient_date_of_birth FROM appts_f WHERE patient_id IS NOT NULL) up GROUP BY 1) b), '{}'::jsonb),
  'creators_top', COALESCE((SELECT jsonb_agg(jsonb_build_object('creator', creator_disp, 'creator_norm', creator_norm, 'count', cnt) ORDER BY cnt DESC)
    FROM (SELECT creator_norm, MAX(creator) creator_disp, COUNT(*) cnt FROM appts_f GROUP BY creator_norm) s), '[]'::jsonb),
  'mc_revenue_v4', (SELECT COALESCE(SUM(amount),0)::numeric FROM pay_attribution_v4 WHERE attribution_agent='MC'),
  'mc_revenue', (SELECT COALESCE(SUM(amount),0)::numeric FROM pay_attribution_v4 WHERE attribution_agent='MC'),
  'attribution_v4', jsonb_build_object(
    'mc_revenue',  (SELECT COALESCE(SUM(amount),0)::numeric FROM pay_attribution_v4 WHERE attribution_agent='MC'),
    'hum_revenue', (SELECT COALESCE(SUM(amount),0)::numeric FROM pay_attribution_v4 WHERE attribution_agent='HUM'),
    'mc_count',    (SELECT COUNT(*) FROM pay_attribution_v4 WHERE attribution_agent='MC'),
    'hum_count',   (SELECT COUNT(*) FROM pay_attribution_v4 WHERE attribution_agent='HUM'),
    'rule', 'MC tocou em AVALIACAO INICIAL COMPARECIDA do paciente nos <=30d antes do pgto (inclui channel_name=Maria Clara IA)'
  ),
  'acoes_agente', jsonb_build_object(
    'conf_mc',  (SELECT COUNT(*) FROM logs WHERE to_status=4 AND user_id='fs22aka-7860-431d-b312-a9a72eb7d27a'),
    'conf_hum', (SELECT COUNT(*) FROM logs WHERE to_status=4 AND user_id IS DISTINCT FROM 'fs22aka-7860-431d-b312-a9a72eb7d27a'),
    'reag_mc',  (SELECT COUNT(*) FROM logs WHERE is_reschedule=true AND user_id='fs22aka-7860-431d-b312-a9a72eb7d27a'),
    'reag_hum', (SELECT COUNT(*) FROM logs WHERE is_reschedule=true AND user_id IS DISTINCT FROM 'fs22aka-7860-431d-b312-a9a72eb7d27a')
  ),
  'campaign_count', (SELECT COUNT(*) FILTER (WHERE campaign_token IS NOT NULL AND TRIM(campaign_token) != '') FROM appts_f)
)
$q$ INTO v
USING p_start, p_end, p_clinic_ids, p_specialty_ids, p_status_codes, p_creators, p_agent_mode, p_origem;
RETURN v;
END;
$function$;
