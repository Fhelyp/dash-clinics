CREATE OR REPLACE FUNCTION public.funnel_stats(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_min_lead_created_at timestamp with time zone DEFAULT '2026-04-06 00:00:00+00'::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  -- Wrapper do funil. Historico: v2 -> v4 (data consulta + carencia 30d) ->
  -- v5 (data do agendamento + passante + confirmacao sem filtro, 10/07) ->
  -- v6 (15/07): elegibilidade por PACIENTE + attended_time. A v5 aplicava
  -- passante consulta a consulta usando status 11/12 (que NAO sao atendimento),
  -- o que derrubava o proprio paciente da campanha de "compareceram".
  -- Rollback: trocar a linha abaixo por funnel_stats_v5(...).
  SELECT public.funnel_stats_v6(p_start, p_end, p_clinic_ids, p_min_lead_created_at);
$function$
