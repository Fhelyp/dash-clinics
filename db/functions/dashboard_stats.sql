CREATE OR REPLACE FUNCTION public.dashboard_stats(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_specialty_ids uuid[] DEFAULT NULL::uuid[], p_status_codes integer[] DEFAULT NULL::integer[], p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text, p_origem text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v jsonb;
  -- p_origem entra aqui: com filtro de origem NAO da pra usar o rollup
  -- pre-calculado (ele nao quebra por canal), tem que ir pro calculo ao vivo.
  is_default boolean := (p_specialty_ids IS NULL AND p_status_codes IS NULL
                         AND p_creators IS NULL AND p_origem IS NULL
                         AND (p_agent_mode IS NULL OR p_agent_mode = 'ALL'));
BEGIN
  IF is_default THEN
    v := dashboard_stats_precomputed(p_start, p_end, p_clinic_ids);
    IF v IS NOT NULL THEN RETURN v; END IF;
    v := dashboard_stats_fast(p_start, p_end, p_clinic_ids);
    IF v IS NOT NULL AND (v->>'_covered')::boolean THEN RETURN v; END IF;
  END IF;
  RETURN dashboard_stats_live(p_start, p_end, p_clinic_ids, p_specialty_ids,
                              p_status_codes, p_creators, p_agent_mode, p_origem);
END;
$function$
