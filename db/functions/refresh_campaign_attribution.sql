CREATE OR REPLACE FUNCTION public.refresh_campaign_attribution(p_clinic_ids text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '280s'
AS $function$
DECLARE n int; np int; v_min_lead constant timestamptz := '2026-04-06 00:00:00+00';
BEGIN
  DROP TABLE IF EXISTS _camp_phones;
  CREATE TEMP TABLE _camp_phones AS
    SELECT DISTINCT ON (t.v) t.v AS phone, cl.created_at_cw AS lead_created_at,
           cl.name AS lead_name, cl.account_id, cl.id AS cw_contact_id, cl.phone_norm AS lead_phone
    FROM chatwoot_leads cl, LATERAL (VALUES
      (cl.phone_norm),
      (CASE WHEN length(cl.phone_norm)>=12 AND substring(cl.phone_norm,1,2)='55' THEN substring(cl.phone_norm,3) END),
      (CASE WHEN length(cl.phone_norm)=13 AND substring(cl.phone_norm,5,1)='9' THEN substring(cl.phone_norm,1,4)||substring(cl.phone_norm,6) END),
      (CASE WHEN length(cl.phone_norm)=12 AND substring(cl.phone_norm,1,2)='55' THEN substring(cl.phone_norm,1,4)||'9'||substring(cl.phone_norm,5) END)
    ) AS t(v)
    WHERE 'campanha' = ANY(cl.labels) AND cl.created_at_cw >= v_min_lead
      AND cl.phone_norm IS NOT NULL AND length(cl.phone_norm) >= 10
      AND (p_clinic_ids IS NULL OR cl.ecuro_clinic_id = ANY(p_clinic_ids))
      AND t.v IS NOT NULL AND length(t.v) >= 10
    ORDER BY t.v, cl.created_at_cw ASC;
  CREATE INDEX ON _camp_phones(phone);

  -- Ligacao pela FICHA (27/10/26): o contato do Chatwoot guarda o link da ficha do Ecuro
  -- (atributo ficha_ecuro -> chatwoot_leads.ficha_patient_id). As consultas que a Maria Clara
  -- agenda chegam do Ecuro SEM telefone, entao o match por telefone nao as achava: em out/26,
  -- 192 pacientes de campanha agendados por ela ficavam fora do funil.
  DROP TABLE IF EXISTS _camp_fichas;
  CREATE TEMP TABLE _camp_fichas AS
    SELECT DISTINCT ON (cl.ficha_patient_id) cl.ficha_patient_id AS patient_id, cl.created_at_cw AS lead_created_at,
           cl.name AS lead_name, cl.account_id, cl.id AS cw_contact_id, cl.phone_norm AS lead_phone
    FROM chatwoot_leads cl
    WHERE 'campanha' = ANY(cl.labels) AND cl.created_at_cw >= v_min_lead AND cl.ficha_patient_id IS NOT NULL
      AND (p_clinic_ids IS NULL OR cl.ecuro_clinic_id = ANY(p_clinic_ids))
    ORDER BY cl.ficha_patient_id, cl.created_at_cw ASC;
  CREATE INDEX ON _camp_fichas(patient_id);

  IF p_clinic_ids IS NULL THEN TRUNCATE public.campaign_appt_attribution;
  ELSE DELETE FROM public.campaign_appt_attribution WHERE clinic_id = ANY(p_clinic_ids); END IF;
  -- Telefone compartilhado (19/10/26): se o telefone do lead aparece em MAIS DE UM paciente (familia
  -- que usa o mesmo numero), so atribui quem tem nome compativel com o lead. Antes, todos viravam
  -- campanha (ex.: Maisa e Marilia Sena Cunha casavam com o lead da mae). Paciente sozinho no
  -- numero continua casando como antes, mesmo com apelido no Chatwoot.
  WITH m AS (
    SELECT a.id, a.clinic_id, a.patient_id, a.patient_name, a.phone_norm, a.patient_channel_name,
           c.lead_created_at, c.lead_phone, c.lead_name, c.account_id, c.cw_contact_id, a.start_time, a.status, a.created_at
    FROM "BI Appointments" a JOIN _camp_phones c ON c.phone = a.phone_norm
    WHERE a.created_at >= c.lead_created_at AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))),
  np AS (SELECT lead_phone, COUNT(DISTINCT COALESCE(patient_id::text, patient_name)) AS n FROM m GROUP BY 1),
  ph AS (SELECT m.* FROM m JOIN np ON np.lead_phone = m.lead_phone
         WHERE np.n = 1 OR public.nome_compativel(m.patient_name, m.lead_name)),
  fi AS (
    SELECT a.id, a.clinic_id, a.patient_id, a.patient_name, a.phone_norm, a.patient_channel_name,
           f.lead_created_at, f.lead_phone, f.lead_name, f.account_id, f.cw_contact_id, a.start_time, a.status, a.created_at
    FROM "BI Appointments" a JOIN _camp_fichas f ON f.patient_id = a.patient_id
    WHERE a.created_at >= f.lead_created_at AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids)))
  INSERT INTO public.campaign_appt_attribution
    (appt_id, clinic_id, patient_id, patient_name, appt_phone, patient_channel_name,
     lead_created_at, lead_phone, lead_name, account_id, cw_contact_id, start_time, status, created_at)
  SELECT DISTINCT ON (x.id)
    x.id, x.clinic_id, x.patient_id, x.patient_name, x.phone_norm, x.patient_channel_name,
    x.lead_created_at, x.lead_phone, x.lead_name, x.account_id, x.cw_contact_id, x.start_time, x.status, x.created_at
  FROM (SELECT * FROM ph UNION ALL SELECT * FROM fi) x
  ORDER BY x.id, x.lead_created_at ASC;
  GET DIAGNOSTICS n = ROW_COUNT;

  IF p_clinic_ids IS NULL THEN TRUNCATE public.campaign_patient;
  ELSE DELETE FROM public.campaign_patient WHERE clinic_id = ANY(p_clinic_ids); END IF;
  INSERT INTO public.campaign_patient (clinic_id, patient_id, lead_phone, lead_created_at, lead_name, cw_contact_id, account_id)
  SELECT DISTINCT ON (x.clinic_id, x.patient_id) x.* FROM (
    SELECT a.clinic_id, a.patient_id, c.lead_phone, c.lead_created_at, c.lead_name, c.cw_contact_id, c.account_id
    FROM "BI Appointments" a JOIN _camp_phones c ON c.phone = a.phone_norm
    WHERE a.patient_id IS NOT NULL AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))
    UNION ALL
    SELECT a.clinic_id, a.patient_id, f.lead_phone, f.lead_created_at, f.lead_name, f.cw_contact_id, f.account_id
    FROM "BI Appointments" a JOIN _camp_fichas f ON f.patient_id = a.patient_id
    WHERE p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids)
  ) x
  ORDER BY x.clinic_id, x.patient_id, x.lead_created_at ASC;
  GET DIAGNOSTICS np = ROW_COUNT;

  RETURN jsonb_build_object('attributed_appts', n, 'campaign_patients', np, 'scope', COALESCE(array_to_string(p_clinic_ids,','),'ALL'), 'at', now());
END $function$;
