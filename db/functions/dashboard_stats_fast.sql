CREATE OR REPLACE FUNCTION public.dashboard_stats_fast(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '15s'
AS $function$
WITH roll AS (
  SELECT * FROM dashboard_daily_rollup
  WHERE day >= (p_start AT TIME ZONE 'UTC')::date AND day < (p_end AT TIME ZONE 'UTC')::date
    AND (p_clinic_ids IS NULL OR clinic_id = ANY(p_clinic_ids))
),
cov AS (SELECT min(day) mn, max(day) mx FROM dashboard_daily_rollup),
pac AS (SELECT count(DISTINCT pid) c FROM roll, unnest(patient_ids) pid),
reag AS (SELECT count(DISTINCT aid) c FROM roll, unnest(reag_appt_ids) aid),
mes_fin AS (SELECT to_char(day,'YYYY-MM') mes, SUM(receita_total) valor FROM roll GROUP BY 1)
SELECT jsonb_build_object(
  'period', jsonb_build_object('start', p_start, 'end', p_end, 'agent_mode', 'ALL'),
  'source', 'rollup',
  '_covered', (SELECT (p_start AT TIME ZONE 'UTC')::date >= mn AND (p_end AT TIME ZONE 'UTC')::date <= mx+1 FROM cov),
  'kpis', jsonb_build_object(
    'pacientes_unicos', (SELECT c FROM pac),
    'agendamentos', COALESCE((SELECT SUM(agendamentos) FROM roll),0),
    'concluidos', COALESCE((SELECT SUM(concluidos) FROM roll),0),
    'confirmacoes', COALESCE((SELECT SUM(confirmacoes) FROM roll),0),
    'reagendamentos', (SELECT c FROM reag),
    'receita_total', COALESCE((SELECT SUM(receita_total) FROM roll),0)::numeric,
    'mc_agendamentos', COALESCE((SELECT SUM(mc_agendamentos) FROM roll),0),
    'mc_concluidos', COALESCE((SELECT SUM(mc_concluidos) FROM roll),0),
    'hum_agendamentos', COALESCE((SELECT SUM(hum_agendamentos) FROM roll),0),
    'hum_concluidos', COALESCE((SELECT SUM(hum_concluidos) FROM roll),0)
  ),
  'best_month', COALESCE((SELECT jsonb_build_object('mes',mes,'valor',valor) FROM mes_fin ORDER BY valor DESC LIMIT 1), jsonb_build_object('mes',NULL,'valor',0)),
  'fin_mensal', COALESCE((SELECT jsonb_agg(jsonb_build_object('mes',mes,'valor',valor) ORDER BY mes) FROM mes_fin), '[]'::jsonb),
  'status_mensal', COALESCE((SELECT jsonb_agg(jsonb_build_object('mes',mes,'status',st,'count',cnt))
    FROM (SELECT to_char(day,'YYYY-MM') mes, (kv.key)::int st, SUM((kv.value)::int) cnt FROM roll, jsonb_each(status_counts) kv GROUP BY 1,2) s), '[]'::jsonb),
  'unidades_receita', COALESCE((SELECT jsonb_agg(jsonb_build_object('clinic_id',clinic_id,'valor',valor,'appts',appts) ORDER BY valor DESC)
    FROM (SELECT clinic_id, SUM(receita_total) valor, SUM(agendamentos) appts FROM roll GROUP BY clinic_id HAVING SUM(receita_total)>0) s), '[]'::jsonb),
  'specialty_receita', COALESCE((SELECT jsonb_agg(jsonb_build_object('specialty_id',sid,'specialty',nome,'valor',valor) ORDER BY valor DESC)
    FROM (SELECT kv.key sid, MAX(kv.value->>'nome') nome, SUM((kv.value->>'valor')::numeric) valor FROM roll, jsonb_each(receita_por_especialidade) kv GROUP BY 1) s), '[]'::jsonb),
  'idade_buckets', COALESCE((SELECT jsonb_object_agg(bucket,cnt) FROM (
      SELECT CASE WHEN d.dob IS NULL THEN 'sem_idade' WHEN AGE(d.dob)<INTERVAL '11 years' THEN '0_10'
        WHEN AGE(d.dob)<INTERVAL '21 years' THEN '11_20' WHEN AGE(d.dob)<INTERVAL '41 years' THEN '21_40'
        WHEN AGE(d.dob)<INTERVAL '61 years' THEN '41_60' ELSE '60_plus' END bucket, COUNT(DISTINCT up.pid) cnt
      FROM (SELECT DISTINCT pid FROM roll, unnest(patient_ids) pid) up LEFT JOIN patient_dob d ON d.patient_id=up.pid GROUP BY 1) b), '{}'::jsonb),
  'creators_top', COALESCE((SELECT jsonb_agg(jsonb_build_object('creator',disp,'creator_norm',cn,'count',cnt) ORDER BY cnt DESC)
    FROM (SELECT kv.key cn, MAX(kv.value->>'disp') disp, SUM((kv.value->>'count')::int) cnt FROM roll, jsonb_each(creator_counts) kv GROUP BY 1) s), '[]'::jsonb),
  'mc_revenue_v4', COALESCE((SELECT SUM(mc_revenue) FROM roll),0)::numeric,
  'mc_revenue', COALESCE((SELECT SUM(mc_revenue) FROM roll),0)::numeric,
  'attribution_v4', jsonb_build_object(
    'mc_revenue', COALESCE((SELECT SUM(mc_revenue) FROM roll),0)::numeric,
    'hum_revenue', COALESCE((SELECT SUM(hum_revenue) FROM roll),0)::numeric,
    'mc_count', COALESCE((SELECT SUM(mc_pay_count) FROM roll),0),
    'hum_count', COALESCE((SELECT SUM(hum_pay_count) FROM roll),0),
    'rule', 'MC tocou em AVALIACAO INICIAL COMPARECIDA do paciente nos <=30d antes do pgto (rollup same-clinic)'),
  'acoes_agente', jsonb_build_object(
    'conf_mc', COALESCE((SELECT SUM(conf_mc) FROM roll),0), 'conf_hum', COALESCE((SELECT SUM(conf_hum) FROM roll),0),
    'reag_mc', COALESCE((SELECT SUM(reag_mc) FROM roll),0), 'reag_hum', COALESCE((SELECT SUM(reag_hum) FROM roll),0)),
  'campaign_count', COALESCE((SELECT SUM(campaign_count) FROM roll),0)
);
$function$
