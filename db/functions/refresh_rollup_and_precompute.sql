CREATE OR REPLACE FUNCTION public.refresh_rollup_and_precompute()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '2700s'
AS $function$
DECLARE
  d2 date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  -- Janela = 1o dia do MES ANTERIOR ate hoje (cobre mes atual + anterior). Antes era
  -- d2-16 (16 dias), o que fazia meses fechados CONGELAREM ao sair da janela e divergir
  -- do live conforme pagamentos/cancelamentos tardios chegavam (visto em agosto/2026).
  d_from date := (date_trunc('month', d2::timestamp) - interval '1 month')::date;
  ids text[]; n int; i int := 1; batch_n int := 10; ok_b int := 0; fail_b int := 0;
BEGIN
  SELECT array_agg("Ecuro_clinicId" ORDER BY "Ecuro_clinicId") INTO ids FROM "unitConfigs" WHERE "Ecuro_clinicId" IS NOT NULL;
  n := array_length(ids,1);
  WHILE i <= n LOOP
    BEGIN
      PERFORM refresh_daily_rollup(d_from, d2, ids[i : LEAST(i+batch_n-1, n)]);
      ok_b := ok_b + 1;
    EXCEPTION WHEN OTHERS THEN fail_b := fail_b + 1;
    END;
    i := i + batch_n;
  END LOOP;
  BEGIN PERFORM refresh_precomputed(); EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('at', now(), 'clinics', n, 'ok_batches', ok_b, 'fail_batches', fail_b, 'range', d_from::text||'..'||d2::text);
END $function$

