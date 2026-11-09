-- Ações do CRC fora da campanha (05/11/2026) — substitui funnel_resgate_followup / _detail no front.
-- Pedido da reunião de 05/11 (Cleber, Thauany): ver orgânico e indicação e separar o resgate de
-- orto, no mesmo formato do bloco Resgate & Follow-up. Plano: docs/PLANO_2026-11-05.md.
--
-- Vertentes (bucket) de um agendamento do CRC no Ecuro, pelo subcanal "como chegou ao CRC":
--   resgate          CRC · Resgate, especialidade que não é Ortodontia
--   resgate_orto     CRC · Resgate com especialidade Ortodontia ("resgate de orto")
--   follow_campanha  CRC · Follow-Up - Campanha
--   follow_organico  CRC · Follow-Up - Orgânico
--   lead_organico    CRC · Lead Orgânico
--   indicacao        CRC · Indicação
-- (CRC · Lead Campanha é o funil de campanha, funnel_v7.sql.)
--
-- Regras (as mesmas do bloco Resgate & Follow-up, estendidas):
--   Agendados     agendamento criado no período (uma linha por agendamento, sem carência)
--   Confirmados   status 7/8, comparecimento ou log de confirmação (informativo)
--   Compareceram  comparecimento registrado (attended_time)
--   Receita       pagamento do período vai para a vertente da ÚLTIMA consulta atendida do paciente
--                 antes dele. Boleto programado só quando pago. Cada pagamento conta num lugar só:
--                 Follow-Up/Resgate já saem do funil de campanha (funnel_v7_rows, CTE pg); e um
--                 pagamento que o funil de campanha já conta (paciente de campanha, regras 1, 2, 4 e
--                 6 do v7) NÃO entra em Lead Orgânico/Indicação.
--   Venderam      pacientes com receita na vertente
--   Operador      p_creators / p_agent_mode: quem criou o agendamento (na receita, quem criou a
--                 consulta que levou ao pagamento) — mesmos nomes do filtro "Operador" do dash.
--   Especialidade p_specialty_ids (09/11): especialidade do agendamento (na receita, da consulta que
--                 levou ao pagamento).
--   Origem        p_origem (09/11): canal de origem do paciente (patient_channel_name), mesmo critério
--                 do Overview e da Auditoria.
--   Contatos (CW) etiquetas do Chatwoot (sync da VPS, 09/11): resgate sem orto / resgate + orto /
--                 follow_1..4 / organico / indicacao, pela data de criação do contato. Contato não
--                 tem operador, especialidade nem origem: esses filtros não valem para esta coluna.
--
-- Mudança de assinatura em 09/11: aplicar junto com db/functions/funnel_v7_origem_drop.sql (DROP
-- das assinaturas antigas na mesma transação).

CREATE OR REPLACE FUNCTION public.crc_acao_bucket(p_channel text, p_sub text, p_speciality uuid)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_channel IS DISTINCT FROM 'CRC' THEN NULL
    WHEN p_sub = 'Resgate' AND p_speciality = '7f945176-078f-448e-aa9b-6d5cd95961e7'::uuid THEN 'resgate_orto'
    WHEN p_sub = 'Resgate'              THEN 'resgate'
    WHEN p_sub = 'Follow-Up - Campanha' THEN 'follow_campanha'
    WHEN p_sub = 'Follow-Up - Orgânico' THEN 'follow_organico'
    WHEN p_sub = 'Lead Orgânico'        THEN 'lead_organico'
    WHEN p_sub = 'Indicação'            THEN 'indicacao'
  END
$function$;

-- Mesma chave do filtro de operador do funil v7 (funnel_v7_rows.creator_key)
CREATE OR REPLACE FUNCTION public.crc_creator_key(p_channel text, p_created_by_name text, p_created_by_name_norm text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_channel = 'Maria Clara IA' THEN 'maria clara'
              WHEN COALESCE(btrim(p_created_by_name),'') = '' THEN 'sem criador'
              ELSE p_created_by_name_norm END
$function$;

-- Base única: uma linha por agendamento do período e uma por pagamento atribuído.
-- kind = 'ag' (agendamento) | 'pg' (pagamento). Stats e drill leem daqui (contagem == drill).
CREATE OR REPLACE FUNCTION public.crc_acoes_base(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text, p_specialty_ids uuid[] DEFAULT NULL::uuid[], p_origem text[] DEFAULT NULL::text[])
 RETURNS TABLE(kind text, bucket text, appt_id uuid, patient_id uuid, patient_name text, phone_norm text, atendente text, dt timestamp with time zone, ult_start timestamp with time zone, status smallint, attended boolean, confirmed boolean, amount numeric)
 LANGUAGE plpgsql
 STABLE
 SET statement_timeout TO '60s'
AS $function$
-- plpgsql + EXECUTE: plano feito com os valores da chamada (ver docs/AI_START_HERE / funnel_v7)
BEGIN
RETURN QUERY EXECUTE $q$
WITH
cr AS (
  SELECT array_agg(lower(public.immutable_unaccent(btrim(regexp_replace(c, '\s+', ' ', 'g'))))) AS list
  FROM unnest(COALESCE($4, ARRAY[]::text[])) c),
acao AS MATERIALIZED (
  SELECT a.id AS appt_id, a.patient_id, a.patient_name, a.phone_norm, a.created_at, a.status, a.attended_time,
         a.speciality_id AS esp, a.patient_channel_name AS origem,
         public.crc_acao_bucket(a.channel_name, a.subchannel_name, a.speciality_id) AS bucket,
         public.crc_creator_key(a.channel_name, a.created_by_name, a.created_by_name_norm) AS ck,
         NULLIF(btrim(regexp_replace(COALESCE(a.created_by_name,''), '\s+', ' ', 'g')), '') AS atendente
  FROM "BI Appointments" a
  WHERE a.channel_name = 'CRC'
    AND a.created_at >= $1 AND a.created_at < $2
    AND ($3 IS NULL OR a.clinic_id = ANY($3))),
-- pagamentos do período com a consulta atendida que veio logo antes de cada um
pay0 AS MATERIALIZED (
  SELECT p.id, p.patient_id, p.amount, p.date, u.appt_id AS ult_id, u.start_time AS ult_start,
         u.patient_name, u.phone_norm, u.bucket, u.ck, u.atendente, u.esp, u.origem
  FROM "BI Payments" p
  CROSS JOIN LATERAL (
    SELECT x.id AS appt_id, x.start_time, x.patient_name, x.phone_norm,
           x.speciality_id AS esp, x.patient_channel_name AS origem,
           public.crc_acao_bucket(x.channel_name, x.subchannel_name, x.speciality_id) AS bucket,
           public.crc_creator_key(x.channel_name, x.created_by_name, x.created_by_name_norm) AS ck,
           NULLIF(btrim(regexp_replace(COALESCE(x.created_by_name,''), '\s+', ' ', 'g')), '') AS atendente
    FROM "BI Appointments" x
    WHERE x.patient_id = p.patient_id AND x.attended_time IS NOT NULL AND x.start_time <= p.date
    ORDER BY x.start_time DESC LIMIT 1) u
  WHERE p.deleted_at IS NULL AND p.date >= $1 AND p.date < $2
    AND NOT (btrim(COALESCE(p.payment_type_name,'')) ILIKE 'boleto programado' AND COALESCE(p.is_confirmed,false) = false)
    AND ($3 IS NULL OR p.clinic_id = ANY($3))
    AND u.bucket IS NOT NULL),
-- Pacientes de campanha, para não contar em Lead Orgânico/Indicação um pagamento que o funil de
-- campanha já conta. Cópia EXATA de camp/camp_ok/pac_tot de funnel_v7_rows (sem filtro de
-- operador: o pagamento é da campanha qualquer que seja o filtro), só para os pacientes que
-- importam. tests/sql/validar_crc_acoes.py confere contra o próprio v7.
oi_pac AS MATERIALIZED (SELECT DISTINCT patient_id FROM pay0 WHERE bucket IN ('lead_organico','indicacao')),
cand AS MATERIALIZED (
  SELECT a.id, a.patient_id, a.created_at, a.channel_name, a.subchannel_name
  FROM "BI Appointments" a
  WHERE a.patient_id IN (SELECT patient_id FROM oi_pac)
    AND a.created_at < $2
    AND a.speciality_id = '8409c08e-f3fa-43a0-b9bd-53128cecdbdc'::uuid
    AND COALESCE(a.subchannel_name,'') !~* '^(follow|resgate)'
    AND ($3 IS NULL OR a.clinic_id = ANY($3))),
lead_att AS MATERIALIZED (
  SELECT att.appt_id, COALESCE(cl.created_at_cw, att.lead_created_at) AS cw_dt,
         (cl.anuncio_dt AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'America/Sao_Paulo' AS an_dt
  FROM campaign_appt_attribution att
  LEFT JOIN chatwoot_leads cl ON cl.id = att.cw_contact_id AND cl.account_id = att.account_id
  WHERE att.appt_id IN (SELECT id FROM cand)
    AND ($3 IS NULL OR att.clinic_id = ANY($3))),
camp AS MATERIALIZED (
  SELECT c.patient_id, c.created_at
  FROM cand c
  LEFT JOIN lead_att la ON la.appt_id = c.id
  CROSS JOIN LATERAL (SELECT GREATEST(la.cw_dt, CASE WHEN la.an_dt <= c.created_at THEN la.an_dt END) AS lead_raw) lr
  WHERE c.subchannel_name = 'Lead Campanha'
     OR (la.appt_id IS NOT NULL
         AND (c.channel_name IN ('CRC','Maria Clara IA')
              OR (c.created_at >= lr.lead_raw AND c.created_at <= lr.lead_raw + interval '30 days')))),
camp_pac AS MATERIALIZED (
  SELECT c.patient_id, MIN(c.created_at) AS primeira
  FROM camp c
  WHERE NOT EXISTS (SELECT 1 FROM "BI Appointments" x
                    WHERE x.patient_id = c.patient_id AND x.attended_time IS NOT NULL
                      AND x.attended_time >= c.created_at - interval '6 months'
                      AND x.attended_time < c.created_at)
  GROUP BY c.patient_id),
pay AS (
  SELECT p.* FROM pay0 p
  LEFT JOIN camp_pac cp ON cp.patient_id = p.patient_id
  WHERE NOT (p.bucket IN ('lead_organico','indicacao')
             AND cp.patient_id IS NOT NULL AND p.date >= date_trunc('day', cp.primeira)))
SELECT 'ag'::text, ac.bucket, ac.appt_id, ac.patient_id, ac.patient_name, ac.phone_norm, ac.atendente,
       ac.created_at, NULL::timestamptz, ac.status, ac.attended_time IS NOT NULL,
       (ac.status IN (7,8) OR ac.attended_time IS NOT NULL
        OR EXISTS (SELECT 1 FROM "BI Appointment Logs" lg WHERE lg.appointment_id = ac.appt_id AND lg.to_status = 4)),
       0::numeric
FROM acao ac
WHERE ac.bucket IS NOT NULL
  AND ($4 IS NULL OR ac.ck IN (SELECT unnest(list) FROM cr))
  AND (COALESCE($5,'ALL') IN ('ALL','') OR ($5 = 'MC' AND ac.ck = 'maria clara') OR ($5 = 'HUM' AND ac.ck <> 'maria clara'))
  AND ($6 IS NULL OR ac.esp = ANY($6))
  AND ($7 IS NULL OR ac.origem = ANY($7))
UNION ALL
SELECT 'pg'::text, p.bucket, p.ult_id, p.patient_id, p.patient_name, p.phone_norm, p.atendente,
       p.date, p.ult_start, NULL::smallint, NULL::boolean, NULL::boolean, p.amount
FROM pay p
WHERE ($4 IS NULL OR p.ck IN (SELECT unnest(list) FROM cr))
  AND (COALESCE($5,'ALL') IN ('ALL','') OR ($5 = 'MC' AND p.ck = 'maria clara') OR ($5 = 'HUM' AND p.ck <> 'maria clara'))
  AND ($6 IS NULL OR p.esp = ANY($6))
  AND ($7 IS NULL OR p.origem = ANY($7))
$q$
USING p_start, p_end, p_clinic_ids, p_creators, p_agent_mode, p_specialty_ids, p_origem;
END;
$function$;

CREATE OR REPLACE FUNCTION public.crc_acoes_stats(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text, p_specialty_ids uuid[] DEFAULT NULL::uuid[], p_origem text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '60s'
AS $function$
WITH bk(bucket, ord) AS (
  VALUES ('resgate',1), ('resgate_orto',2), ('follow_campanha',3), ('follow_organico',4), ('lead_organico',5), ('indicacao',6)),
b AS MATERIALIZED (SELECT * FROM public.crc_acoes_base(p_start, p_end, p_clinic_ids, p_creators, p_agent_mode, p_specialty_ids, p_origem)),
agg AS (
  SELECT bucket, COUNT(*) AS agendados, COUNT(*) FILTER (WHERE confirmed) AS confirmados,
         COUNT(*) FILTER (WHERE attended) AS compareceram, COUNT(DISTINCT patient_id) AS pacientes
  FROM b WHERE kind = 'ag' GROUP BY bucket),
rev AS (
  SELECT bucket, COALESCE(SUM(amount),0)::numeric AS receita, COUNT(*) AS pagamentos,
         COUNT(DISTINCT patient_id) AS venderam
  FROM b WHERE kind = 'pg' GROUP BY bucket),
-- Contatos (CW): contatos do Chatwoot com a etiqueta, criados no período. Resgate de orto =
-- etiquetas resgate + orto. A etiqueta follow_N não separa campanha de orgânico (total único).
cw AS (
  SELECT
    COUNT(DISTINCT phone_norm) FILTER (WHERE 'resgate' = ANY(labels) AND NOT ('orto' = ANY(labels))) AS resgate,
    COUNT(DISTINCT phone_norm) FILTER (WHERE labels @> ARRAY['resgate','orto']) AS resgate_orto,
    COUNT(DISTINCT phone_norm) FILTER (WHERE labels && ARRAY['follow_1','follow_2','follow_3','follow_4']) AS follow,
    COUNT(DISTINCT phone_norm) FILTER (WHERE 'organico' = ANY(labels)) AS lead_organico,
    COUNT(DISTINCT phone_norm) FILTER (WHERE 'indicacao' = ANY(labels)) AS indicacao
  FROM chatwoot_leads
  WHERE created_at_cw >= p_start AND created_at_cw < p_end
    AND phone_norm IS NOT NULL AND length(phone_norm) >= 10
    AND (p_clinic_ids IS NULL OR ecuro_clinic_id = ANY(p_clinic_ids)))
SELECT jsonb_build_object(
  'period', jsonb_build_object('start', p_start, 'end', p_end),
  'contatos_cw', (SELECT jsonb_build_object('resgate', resgate, 'resgate_orto', resgate_orto, 'follow', follow,
                                            'lead_organico', lead_organico, 'indicacao', indicacao) FROM cw),
  'buckets', jsonb_object_agg(bk.bucket, jsonb_build_object(
      'agendados', COALESCE(agg.agendados,0), 'confirmados', COALESCE(agg.confirmados,0),
      'compareceram', COALESCE(agg.compareceram,0), 'pacientes', COALESCE(agg.pacientes,0),
      'venderam', COALESCE(rev.venderam,0), 'receita', COALESCE(rev.receita,0),
      'pagamentos', COALESCE(rev.pagamentos,0)) ORDER BY bk.ord),
  'rules', jsonb_build_object(
    'vertente', 'subcanal do agendamento no Ecuro (CRC · Resgate/Follow-Up/Lead Orgânico/Indicação); Resgate com especialidade Ortodontia = Resgate Orto',
    'agendados', 'agendamentos do CRC criados no período, pela data do agendamento',
    'compareceram', 'comparecimento registrado no Ecuro (attended_time)',
    'receita', 'pagamento do período vai para a vertente da última consulta atendida antes dele; boleto programado só quando pago; pagamento que o funil de campanha conta não entra em Lead Orgânico/Indicação',
    'operador', 'quem criou o agendamento (na receita, quem criou a consulta que levou ao pagamento)')
) FROM bk LEFT JOIN agg ON agg.bucket = bk.bucket LEFT JOIN rev ON rev.bucket = bk.bucket;
$function$;

CREATE OR REPLACE FUNCTION public.crc_acoes_detail(p_bucket text, p_stage text, p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_specialty_ids uuid[] DEFAULT NULL::uuid[], p_origem text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '60s'
AS $function$
-- Drill do bloco: mesma base do stats (crc_acoes_base), então count/total batem com a tabela.
--   contatos     contatos do Chatwoot com a tag (só resgate e follow — 'follow' = os dois follow-ups)
--   agendados / confirmados / compareceram  uma linha por agendamento; "pago" = pagamentos do
--                período cuja última consulta atendida é este agendamento (não repete pagamento)
--   receita      uma linha por paciente com os pagamentos do período atribuídos à vertente
WITH b AS MATERIALIZED (
  SELECT * FROM public.crc_acoes_base(p_start, p_end, p_clinic_ids, p_creators, p_agent_mode, p_specialty_ids, p_origem)
  WHERE p_stage <> 'contatos' AND bucket = p_bucket),
contatos AS (
  SELECT DISTINCT ON (cl.phone_norm) cl.name AS nome, cl.phone_norm AS telefone,
         to_char(cl.created_at_cw AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS data,
         NULL::text AS status, 0::numeric AS pago, NULL::uuid AS patient_id, NULL::text AS atendente,
         cl.created_at_cw AS ord_dt
  FROM chatwoot_leads cl
  WHERE p_stage = 'contatos'
    AND CASE p_bucket
          WHEN 'resgate'       THEN 'resgate' = ANY(cl.labels) AND NOT ('orto' = ANY(cl.labels))
          WHEN 'resgate_orto'  THEN cl.labels @> ARRAY['resgate','orto']
          WHEN 'lead_organico' THEN 'organico' = ANY(cl.labels)
          WHEN 'indicacao'     THEN 'indicacao' = ANY(cl.labels)
          WHEN 'follow'          THEN cl.labels && ARRAY['follow_1','follow_2','follow_3','follow_4']
          WHEN 'follow_campanha' THEN cl.labels && ARRAY['follow_1','follow_2','follow_3','follow_4']
          WHEN 'follow_organico' THEN cl.labels && ARRAY['follow_1','follow_2','follow_3','follow_4']
          ELSE false END
    AND cl.phone_norm IS NOT NULL AND length(cl.phone_norm) >= 10
    AND cl.created_at_cw >= p_start AND cl.created_at_cw < p_end
    AND (p_clinic_ids IS NULL OR cl.ecuro_clinic_id = ANY(p_clinic_ids))
  ORDER BY cl.phone_norm, cl.created_at_cw DESC),
pg AS (SELECT appt_id, SUM(amount) AS pago FROM b WHERE kind = 'pg' GROUP BY appt_id),
ag AS (
  SELECT b.patient_name AS nome, b.phone_norm AS telefone,
         to_char(b.dt AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS data,
         CASE WHEN b.attended THEN 'compareceu'
              ELSE CASE b.status WHEN 8 THEN 'concluído' WHEN 7 THEN 'atendido' WHEN 4 THEN 'confirmado'
                     WHEN 11 THEN 'aguard. retorno' WHEN 12 THEN 'retorno criado' WHEN 5 THEN 'cancelado'
                     WHEN 1 THEN 'à confirmar' ELSE b.status::text END END AS status,
         COALESCE(pg.pago, 0)::numeric AS pago, b.patient_id, b.atendente, b.dt AS ord_dt
  FROM b LEFT JOIN pg ON pg.appt_id = b.appt_id
  WHERE b.kind = 'ag'
    AND CASE p_stage WHEN 'agendados' THEN true
                     WHEN 'confirmados' THEN b.confirmed
                     WHEN 'compareceram' THEN b.attended
                     ELSE false END),
rec AS (
  SELECT MAX(b.patient_name) AS nome, MAX(b.phone_norm) AS telefone,
         to_char(MAX(b.dt) AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS data,
         to_char(MAX(b.ult_start) AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS status,
         SUM(b.amount)::numeric AS pago, b.patient_id,
         string_agg(DISTINCT b.atendente, ', ') AS atendente, MAX(b.dt) AS ord_dt
  FROM b WHERE b.kind = 'pg' AND p_stage IN ('receita','venderam')
  GROUP BY b.patient_id),
filtered AS (
  SELECT * FROM contatos UNION ALL SELECT * FROM ag UNION ALL SELECT * FROM rec)
SELECT jsonb_build_object('bucket', p_bucket, 'stage', p_stage,
  'count', (SELECT COUNT(*) FROM filtered),
  'total_pago', (SELECT COALESCE(SUM(pago),0) FROM filtered),
  'rows', COALESCE((SELECT jsonb_agg(row_to_json(r)) FROM (
    SELECT nome, telefone, data, status, pago, patient_id, atendente FROM filtered
    ORDER BY pago DESC, ord_dt DESC NULLS LAST, nome LIMIT p_limit OFFSET p_offset) r), '[]'::jsonb));
$function$;
