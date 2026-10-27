CREATE OR REPLACE FUNCTION public.refresh_rollup_old_months()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d2 date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  m_fim date := (date_trunc('month', d2::timestamp) - interval '2 month')::date;  -- mes retrasado
  m date; m_ini date;
  ids text[]; n int; i int; batch_n int := 10; ok_b int := 0; fail_b int := 0; meses int := 0;
BEGIN
  -- Reprocessa os meses do rollup MAIS ANTIGOS que o mes anterior (o cron noturno
  -- refresh_rollup_and_precompute ja cobre mes atual + anterior). Sem isto, lancamentos e
  -- correcoes tardias do Ecuro em meses antigos nunca chegam ao dash: em 19/10/26 maio estava
  -- R$ 314 mil abaixo do real. Agendado semanal (domingo). Uma chamada por MES EXATO com p_to =
  -- ultimo dia (refresh_daily_rollup tem p_to inclusivo — ver db/ROLLUP_CRON.md).
  SELECT date_trunc('month', MIN(day))::date INTO m_ini FROM dashboard_daily_rollup;
  IF m_ini IS NULL OR m_ini > m_fim THEN
    RETURN jsonb_build_object('at', now(), 'skipped', 'nenhum mes antigo no rollup');
  END IF;
  SELECT array_agg("Ecuro_clinicId" ORDER BY "Ecuro_clinicId") INTO ids FROM "unitConfigs" WHERE "Ecuro_clinicId" IS NOT NULL AND "Dash" IS TRUE;
  n := array_length(ids, 1);
  m := m_ini;
  WHILE m <= m_fim LOOP
    i := 1;
    WHILE i <= n LOOP
      BEGIN
        PERFORM refresh_daily_rollup(m, (m + interval '1 month')::date - 1, ids[i : LEAST(i+batch_n-1, n)]);
        ok_b := ok_b + 1;
      EXCEPTION WHEN OTHERS THEN fail_b := fail_b + 1;
      END;
      i := i + batch_n;
    END LOOP;
    meses := meses + 1;
    m := (m + interval '1 month')::date;
  END LOOP;
  BEGIN PERFORM refresh_precomputed(); EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('at', now(), 'meses', meses, 'de', m_ini, 'ate', m_fim,
                            'ok_batches', ok_b, 'fail_batches', fail_b);
END $function$;
