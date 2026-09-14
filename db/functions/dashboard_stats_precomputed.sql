CREATE OR REPLACE FUNCTION public.dashboard_stats_precomputed(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '5s'
AS $function$
  SELECT result FROM dashboard_precomputed
  WHERE scope_key = _scope_key(p_clinic_ids)
    AND period_start = (p_start AT TIME ZONE 'UTC')::date
    AND period_end   = (p_end   AT TIME ZONE 'UTC')::date;
$function$
