CREATE OR REPLACE FUNCTION public.refresh_precomputed()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '300s'
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d2 date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;       -- "hoje" no fuso do usuário
  ts_start timestamptz := ((d2 - 14)::text || 'T00:00:00+00:00')::timestamptz;
  ts_end   timestamptz := ((d2 + 1)::text  || 'T00:00:00+00:00')::timestamptz;
  r record; n int := 0;
BEGIN
  PERFORM precompute_dashboard(ts_start, ts_end, NULL); n := n + 1;  -- ALL (admin)
  FOR r IN SELECT DISTINCT allowed_clinic_ids AS aci FROM auth_users WHERE allowed_clinic_ids IS NOT NULL LOOP
    BEGIN
      PERFORM precompute_dashboard(ts_start, ts_end, r.aci); n := n + 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  DELETE FROM dashboard_precomputed WHERE period_end < (d2 - 4);   -- limpa janelas velhas
  RETURN jsonb_build_object('scopes', n, 'window_start', ts_start::date, 'window_end', ts_end::date, 'at', now());
END $function$
