CREATE OR REPLACE FUNCTION public.refresh_daily_rollup(p_from date, p_to date, p_clinic_ids text[] DEFAULT NULL::text[])
 RETURNS integer
 LANGUAGE plpgsql
 SET statement_timeout TO '280s'
AS $function$
DECLARE n int;
  v_mc1 text := 'fs22aka-7860-431d-b312-a9a72eb7d27a'; v_mc2 text := 'hs22aka-7860-434d-b312-a9a72eb7d27a';
  v_lo timestamptz := (p_from::timestamp AT TIME ZONE 'UTC');
  v_hi timestamptz := ((p_to + 1)::timestamp AT TIME ZONE 'UTC');
BEGIN
  DELETE FROM dashboard_daily_rollup r WHERE r.day >= p_from AND r.day <= p_to
    AND (p_clinic_ids IS NULL OR r.clinic_id = ANY(p_clinic_ids));

  WITH appt_base AS (
    SELECT ap.id, ap.clinic_id, (ap.start_time AT TIME ZONE 'UTC')::date AS day, ap.patient_id, ap.status, ap.campaign_token,
      (ap.channel_id IN (v_mc1,v_mc2) OR ap.channel_name='Maria Clara IA') AS is_mc_channel,
      TRIM(REGEXP_REPLACE(COALESCE(ap.created_by_name,''),'\s+',' ','g')) AS creator_name, ap.created_by_name_norm,
      EXISTS(SELECT 1 FROM "BI Appointment Logs" lg WHERE lg.appointment_id=ap.id AND lg.user_id=v_mc1) AS has_mc_log
    FROM "BI Appointments" ap
    WHERE ap.start_time >= v_lo AND ap.start_time < v_hi AND (p_clinic_ids IS NULL OR ap.clinic_id = ANY(p_clinic_ids))
  ),
  appt_typed AS (
    SELECT *, CASE WHEN is_mc_channel OR (creator_name='' AND has_mc_log) THEN 'MC' ELSE 'HUM' END AS agent,
      CASE WHEN is_mc_channel THEN 'Maria Clara' WHEN creator_name='' AND has_mc_log THEN 'Maria Clara' WHEN creator_name='' THEN 'Sem criador' ELSE creator_name END AS creator,
      CASE WHEN is_mc_channel THEN 'mc-channel' WHEN creator_name='' AND has_mc_log THEN 'mc-logged' WHEN creator_name='' THEN 'sem criador' ELSE created_by_name_norm END AS creator_norm
    FROM appt_base
  ),
  ag_scalar AS (
    SELECT clinic_id, day, COUNT(*) agendamentos, COUNT(*) FILTER (WHERE status=8) concluidos, COUNT(*) FILTER (WHERE status IN (4,5,6,7,8)) confirmacoes,
      COUNT(*) FILTER (WHERE agent='MC') mc_agendamentos, COUNT(*) FILTER (WHERE agent='MC' AND status IN (7,8)) mc_concluidos,
      COUNT(*) FILTER (WHERE agent='HUM') hum_agendamentos, COUNT(*) FILTER (WHERE agent='HUM' AND status IN (7,8)) hum_concluidos,
      COUNT(*) FILTER (WHERE campaign_token IS NOT NULL AND TRIM(campaign_token)<>'') campaign_count,
      array_agg(DISTINCT patient_id) FILTER (WHERE patient_id IS NOT NULL) patient_ids
    FROM appt_typed GROUP BY clinic_id, day
  ),
  ag_status AS (SELECT clinic_id, day, jsonb_object_agg(status::text, c) sc FROM
    (SELECT clinic_id, day, status, COUNT(*) c FROM appt_typed WHERE status IS NOT NULL GROUP BY clinic_id, day, status) x GROUP BY clinic_id, day),
  ag_creator AS (SELECT clinic_id, day, jsonb_object_agg(creator_norm, jsonb_build_object('disp', disp, 'count', c)) cc FROM
    (SELECT clinic_id, day, creator_norm, MAX(creator) disp, COUNT(*) c FROM appt_typed WHERE creator_norm IS NOT NULL GROUP BY clinic_id, day, creator_norm) x GROUP BY clinic_id, day)
  INSERT INTO dashboard_daily_rollup (clinic_id, day, agendamentos, concluidos, confirmacoes, mc_agendamentos, mc_concluidos, hum_agendamentos, hum_concluidos, campaign_count, patient_ids, status_counts, creator_counts)
  SELECT s.clinic_id, s.day, s.agendamentos, s.concluidos, s.confirmacoes, s.mc_agendamentos, s.mc_concluidos, s.hum_agendamentos, s.hum_concluidos, s.campaign_count,
    COALESCE(s.patient_ids,'{}'), COALESCE(st.sc,'{}'::jsonb), COALESCE(cr.cc,'{}'::jsonb)
  FROM ag_scalar s LEFT JOIN ag_status st ON st.clinic_id=s.clinic_id AND st.day=s.day LEFT JOIN ag_creator cr ON cr.clinic_id=s.clinic_id AND cr.day=s.day
  ON CONFLICT (clinic_id, day) DO UPDATE SET agendamentos=EXCLUDED.agendamentos, concluidos=EXCLUDED.concluidos, confirmacoes=EXCLUDED.confirmacoes,
    mc_agendamentos=EXCLUDED.mc_agendamentos, mc_concluidos=EXCLUDED.mc_concluidos, hum_agendamentos=EXCLUDED.hum_agendamentos, hum_concluidos=EXCLUDED.hum_concluidos,
    campaign_count=EXCLUDED.campaign_count, patient_ids=EXCLUDED.patient_ids, status_counts=EXCLUDED.status_counts, creator_counts=EXCLUDED.creator_counts, refreshed_at=now();
  GET DIAGNOSTICS n = ROW_COUNT;

  WITH mc_eval AS (
    SELECT DISTINCT a.clinic_id, a.patient_id, a.start_time AS attended_at FROM "BI Appointments" a
    WHERE a.status IN (7,8) AND a.speciality_id='8409c08e-f3fa-43a0-b9bd-53128cecdbdc' AND a.patient_id IS NOT NULL
      AND a.start_time >= v_lo - INTERVAL '31 days' AND a.start_time < v_hi AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))
      AND (a.channel_id IN (v_mc1,v_mc2) OR a.channel_name='Maria Clara IA' OR EXISTS(SELECT 1 FROM "BI Appointment Logs" lg WHERE lg.appointment_id=a.id AND lg.user_id=v_mc1))
  ),
  pay_base AS (
    SELECT DISTINCT ON (p.id) p.id, p.clinic_id, (p.date AT TIME ZONE 'UTC')::date AS day, p.amount, p.specialty_id, p.specialty_name,
      CASE WHEN m.patient_id IS NOT NULL THEN 'MC' ELSE 'HUM' END AS attribution_agent
    FROM "BI Payments" p LEFT JOIN mc_eval m ON m.clinic_id=p.clinic_id AND m.patient_id=p.patient_id AND m.attended_at<=p.date AND m.attended_at>=p.date - INTERVAL '30 days'
    WHERE p.date >= v_lo AND p.date < v_hi AND p.deleted_at IS NULL AND (p_clinic_ids IS NULL OR p.clinic_id = ANY(p_clinic_ids))
    ORDER BY p.id, m.attended_at DESC NULLS LAST
  ),
  pay_scalar AS (
    SELECT clinic_id, day, SUM(amount) receita_total, SUM(amount) FILTER (WHERE attribution_agent='MC') mc_revenue, SUM(amount) FILTER (WHERE attribution_agent='HUM') hum_revenue,
      COUNT(*) FILTER (WHERE attribution_agent='MC') mc_pay_count, COUNT(*) FILTER (WHERE attribution_agent='HUM') hum_pay_count
    FROM pay_base GROUP BY clinic_id, day
  ),
  pay_spec AS (SELECT clinic_id, day, jsonb_object_agg(specialty_id, jsonb_build_object('nome', nome, 'valor', valor)) rpe FROM
    (SELECT clinic_id, day, specialty_id, MAX(specialty_name) nome, SUM(amount) valor FROM pay_base WHERE specialty_name IS NOT NULL AND specialty_id IS NOT NULL GROUP BY clinic_id, day, specialty_id) x GROUP BY clinic_id, day)
  INSERT INTO dashboard_daily_rollup (clinic_id, day, receita_total, mc_revenue, hum_revenue, mc_pay_count, hum_pay_count, receita_por_especialidade)
  SELECT s.clinic_id, s.day, s.receita_total, COALESCE(s.mc_revenue,0), COALESCE(s.hum_revenue,0), s.mc_pay_count, s.hum_pay_count, COALESCE(sp.rpe,'{}'::jsonb)
  FROM pay_scalar s LEFT JOIN pay_spec sp ON sp.clinic_id=s.clinic_id AND sp.day=s.day
  ON CONFLICT (clinic_id, day) DO UPDATE SET receita_total=EXCLUDED.receita_total, mc_revenue=EXCLUDED.mc_revenue, hum_revenue=EXCLUDED.hum_revenue,
    mc_pay_count=EXCLUDED.mc_pay_count, hum_pay_count=EXCLUDED.hum_pay_count, receita_por_especialidade=EXCLUDED.receita_por_especialidade, refreshed_at=now();

  WITH log_base AS (
    SELECT lg.appointment_id, lg.user_id, lg.to_status, COALESCE(lg.is_reschedule,false) AS is_resched,
      ap.clinic_id, (lg."changeDate" AT TIME ZONE 'UTC')::date AS day
    FROM "BI Appointment Logs" lg JOIN "BI Appointments" ap ON ap.id=lg.appointment_id
    WHERE lg."changeDate" >= v_lo AND lg."changeDate" < v_hi
      AND ap.start_time >= v_lo AND ap.start_time < v_hi
      AND (p_clinic_ids IS NULL OR ap.clinic_id = ANY(p_clinic_ids))
  ),
  log_agg AS (
    SELECT clinic_id, day, COUNT(DISTINCT appointment_id) FILTER (WHERE is_resched) reagendamentos,
      array_agg(DISTINCT appointment_id) FILTER (WHERE is_resched) reag_appt_ids,
      COUNT(*) FILTER (WHERE to_status=4 AND user_id=v_mc1) conf_mc, COUNT(*) FILTER (WHERE to_status=4 AND user_id IS DISTINCT FROM v_mc1) conf_hum,
      COUNT(*) FILTER (WHERE is_resched AND user_id=v_mc1) reag_mc, COUNT(*) FILTER (WHERE is_resched AND user_id IS DISTINCT FROM v_mc1) reag_hum
    FROM log_base GROUP BY clinic_id, day
  )
  INSERT INTO dashboard_daily_rollup (clinic_id, day, reagendamentos, reag_appt_ids, conf_mc, conf_hum, reag_mc, reag_hum)
  SELECT clinic_id, day, reagendamentos, COALESCE(reag_appt_ids,'{}'), conf_mc, conf_hum, reag_mc, reag_hum FROM log_agg
  ON CONFLICT (clinic_id, day) DO UPDATE SET reagendamentos=EXCLUDED.reagendamentos, reag_appt_ids=EXCLUDED.reag_appt_ids,
    conf_mc=EXCLUDED.conf_mc, conf_hum=EXCLUDED.conf_hum, reag_mc=EXCLUDED.reag_mc, reag_hum=EXCLUDED.reag_hum, refreshed_at=now();

  INSERT INTO patient_dob (patient_id, dob)
  SELECT DISTINCT ON (patient_id) patient_id, patient_date_of_birth FROM "BI Appointments"
  WHERE start_time >= v_lo AND start_time < v_hi AND patient_id IS NOT NULL AND (p_clinic_ids IS NULL OR clinic_id = ANY(p_clinic_ids))
  ON CONFLICT (patient_id) DO UPDATE SET dob=EXCLUDED.dob;
  RETURN n;
END $function$
