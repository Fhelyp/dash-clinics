CREATE OR REPLACE FUNCTION public.refresh_rollup_and_precompute()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '2700s'
AS $function$
DECLARE
  d2 date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  m_atual date := date_trunc('month', d2::timestamp)::date;                          -- 1o dia mes atual
  m_ant   date := (date_trunc('month', d2::timestamp) - interval '1 month')::date;   -- 1o dia mes anterior
  m_prox  date := (date_trunc('month', d2::timestamp) + interval '1 month')::date;   -- 1o dia mes seguinte
  ids text[]; n int; i int := 1; batch_n int := 10; ok_b int := 0; fail_b int := 0;
BEGIN
  -- refresh_daily_rollup tem p_to INCLUSIVO (v_hi=p_to+1). Por isso passamos o ULTIMO DIA de
  -- cada mes (m_atual-1 = ultimo dia do mes anterior; m_prox-1 = ultimo dia do mes atual).
  -- 1 chamada por MES EXATO -> start_time+changeDate no mesmo mes, sem vazar log entre meses,
  -- e bate com o dashboard_stats_live (que usa < p_end exclusivo). NAO passar 1o dia do mes
  -- seguinte como p_to (incluiria 1 dia extra = o drift de reagendamento).
  SELECT array_agg("Ecuro_clinicId" ORDER BY "Ecuro_clinicId") INTO ids FROM "unitConfigs" WHERE "Ecuro_clinicId" IS NOT NULL;
  n := array_length(ids,1);
  WHILE i <= n LOOP
    BEGIN
      PERFORM refresh_daily_rollup(m_ant,   m_atual - 1, ids[i : LEAST(i+batch_n-1, n)]);  -- mes anterior
      PERFORM refresh_daily_rollup(m_atual, m_prox  - 1, ids[i : LEAST(i+batch_n-1, n)]);  -- mes atual
      ok_b := ok_b + 1;
    EXCEPTION WHEN OTHERS THEN fail_b := fail_b + 1;
    END;
    i := i + batch_n;
  END LOOP;
  BEGIN PERFORM refresh_precomputed(); EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('at', now(), 'clinics', n, 'ok_batches', ok_b, 'fail_batches', fail_b,
    'range', m_ant::text||' a '||(m_prox-1)::text||' (por mes, p_to inclusivo)');
END $function$

