-- Funil de marketing v7 — regras decididas com a gerência em 27/10/2026
-- (docs/DECISOES_2026-10-27.md). Três funções:
--   funnel_v7_rows   → uma linha por paciente com as etapas (base única: contagem == drill)
--   funnel_stats_v7  → números do funil
--   funnel_detail_v7 → lista do drill-down por etapa
--
-- Regras:
--   1. Paciente antigo: fora quem teve consulta concluída nos 6 meses antes do agendamento.
--   2. Lead sem prazo: "uma vez campanha, sempre campanha" (sem piso de data do lead).
--   3. Duas visões (p_view):
--        'comissao' → cada etapa no período em que aconteceu, não importa quando o lead caiu
--                     (agendamento criado, confirmação, comparecimento e pagamento no período);
--        'safra'    → só os leads que caíram no período; deles, quem agendou no período e,
--                     desse agendamento em diante, quem compareceu e pagou (em qualquer data).
--      Data do lead de uma consulta = sinal de lead mais recente ANTES dela (criação do contato
--      ou anúncio). Anúncio clicado depois do agendamento é outro lead.
--   4. Campanha = consulta de Avaliação, de lead que veio de anúncio (Chatwoot) ou marcada
--      "Lead Campanha" no Ecuro. Follow-up e resgate ficam no funil próprio.
--   5. Remarcação não conta como novo agendamento: outra consulta de campanha do mesmo
--      paciente nos 60 dias anteriores = remarcação. O comparecimento dela conta.
--   6. Lead que foi direto à clínica (canal que não é CRC nem Maria Clara): só é campanha se a
--      consulta foi criada depois do lead e até 30 dias dele.
--   7. Família no mesmo telefone: já tratada na atribuição (nome compatível, 19/10).
--   8. Receita: valores lançados como pagamento; boleto programado só quando pago. Pagamento cuja
--      última consulta atendida antes dele foi de Follow-Up/Resgate é do funil de resgate, não daqui.
--   9. Confirmados: informativo.
-- Filtro de operador (p_creators): mesmos nomes do filtro "Operador" do dash; Maria Clara = 'maria clara'.
-- p_agent_mode: 'ALL' | 'MC' (só Maria Clara) | 'HUM' (só operadores), igual ao botão do dash.

CREATE OR REPLACE FUNCTION public.funnel_v7_rows(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_view text DEFAULT 'comissao'::text, p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text)
 RETURNS TABLE(clinic_id text, patient_id uuid, patient_name text, phone_norm text, cw_contact_id integer, account_id integer, lead_name text, lead_dt timestamp with time zone, agendou boolean, confirmou boolean, compareceu boolean, total_pago numeric, n_pgto integer, canais text[], atendentes text[])
 LANGUAGE plpgsql
 STABLE
 SET statement_timeout TO '60s'
AS $function$
-- EXECUTE: plano feito com os valores da chamada (a versão LANGUAGE sql era planejada genérica,
-- errava as estimativas e levava ~25 s em vez de ~9 s)
BEGIN
RETURN QUERY EXECUTE $q$
WITH
cr AS (
  SELECT array_agg(lower(public.immutable_unaccent(btrim(regexp_replace(c, '\s+', ' ', 'g'))))) AS list
  FROM unnest(COALESCE($5, ARRAY[]::text[])) c),
-- sinais de lead do contato: criação no Chatwoot e anúncio registrado
-- (anuncio_dt vem como meia-noite UTC do dia; vira meia-noite de Brasília do mesmo dia)
lead_att AS MATERIALIZED (
  SELECT att.appt_id, att.cw_contact_id, att.account_id, att.lead_name,
         COALESCE(cl.created_at_cw, att.lead_created_at) AS cw_dt,
         (cl.anuncio_dt AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'America/Sao_Paulo' AS an_dt
  FROM campaign_appt_attribution att
  LEFT JOIN chatwoot_leads cl ON cl.id = att.cw_contact_id AND cl.account_id = att.account_id
  WHERE ($3 IS NULL OR att.clinic_id = ANY($3))),
camp AS MATERIALIZED (
  SELECT a.id AS appt_id, a.clinic_id, a.patient_id, a.patient_name, a.phone_norm, a.created_at,
         a.attended_time, a.confirmed_time, a.status, a.channel_name, a.subchannel_name,
         CASE WHEN a.channel_name = 'Maria Clara IA' THEN 'Maria Clara'
              ELSE NULLIF(btrim(regexp_replace(COALESCE(a.created_by_name,''), '\s+', ' ', 'g')), '') END AS atendente,
         CASE WHEN a.channel_name = 'Maria Clara IA' THEN 'maria clara'
              WHEN COALESCE(btrim(a.created_by_name),'') = '' THEN 'sem criador'
              ELSE a.created_by_name_norm END AS creator_key,
         la.cw_contact_id, la.account_id, la.lead_name,
         -- lead não pode ter "caído" depois do agendamento que ele gerou
         CASE WHEN la.appt_id IS NOT NULL THEN LEAST(a.created_at, lr.lead_raw) END AS lead_dt
  FROM "BI Appointments" a
  LEFT JOIN lead_att la ON la.appt_id = a.id
  -- sinal de lead mais recente que veio ANTES da consulta (um anúncio clicado depois do
  -- agendamento é outro lead, não o que gerou este agendamento — caso dos 99 da safra, 27/10)
  CROSS JOIN LATERAL (SELECT GREATEST(la.cw_dt, CASE WHEN la.an_dt <= a.created_at THEN la.an_dt END) AS lead_raw) lr
  WHERE a.patient_id IS NOT NULL
    AND a.created_at < $2
    AND a.speciality_id = '8409c08e-f3fa-43a0-b9bd-53128cecdbdc'::uuid        -- regra 4: Avaliação
    AND COALESCE(a.subchannel_name,'') !~* '^(follow|resgate)'                 -- funil de resgate/follow
    AND ($3 IS NULL OR a.clinic_id = ANY($3))
    AND (a.subchannel_name = 'Lead Campanha'
         OR (la.appt_id IS NOT NULL
             AND (a.channel_name IN ('CRC','Maria Clara IA')                    -- regra 2: sem prazo
                  OR (a.created_at >= lr.lead_raw                                -- regra 6: consulta depois
                      AND a.created_at <= lr.lead_raw + interval '30 days'))))),  --   do lead, até 30 dias
-- regra 1: fora quem concluiu consulta nos 6 meses antes do agendamento
camp_ok AS MATERIALIZED (
  SELECT c.* FROM camp c
  WHERE NOT EXISTS (SELECT 1 FROM "BI Appointments" x
                    WHERE x.patient_id = c.patient_id AND x.attended_time IS NOT NULL
                      AND x.attended_time >= c.created_at - interval '6 months'
                      AND x.attended_time < c.created_at)),
-- regra 5: novo agendamento = sem outra consulta de campanha do paciente nos 60 dias anteriores
camp_seq AS MATERIALIZED (
  SELECT c.*,
         (lag(c.created_at) OVER (PARTITION BY c.patient_id ORDER BY c.created_at) IS NULL
          OR c.created_at - lag(c.created_at) OVER (PARTITION BY c.patient_id ORDER BY c.created_at) > interval '60 days') AS novo
  FROM camp_ok c),
camp_f AS MATERIALIZED (
  SELECT s.* FROM camp_seq s
  WHERE ($5 IS NULL OR s.creator_key IN (SELECT unnest(list) FROM cr))
    AND (COALESCE($6,'ALL') IN ('ALL','')
         OR ($6 = 'MC' AND s.creator_key = 'maria clara')
         OR ($6 = 'HUM' AND s.creator_key <> 'maria clara'))),
-- ref_dt = data do lead da consulta (sem contato no Chatwoot: a do agendamento).
-- safra_ini = criação do novo agendamento de lead do período: na safra, só o que vem dele em
-- diante conta (comparecimento/venda de ciclo anterior do paciente não é desta safra).
ciclo0 AS MATERIALIZED (
  SELECT f.*, COALESCE(f.lead_dt, f.created_at) AS ref_dt FROM camp_f f),
ciclo AS MATERIALIZED (
  SELECT c.*, MIN(c.created_at) FILTER (WHERE c.novo AND c.ref_dt >= $1 AND c.ref_dt < $2)
                OVER (PARTITION BY c.patient_id) AS safra_ini
  FROM ciclo0 c),
pac_tot AS (SELECT c.patient_id, MIN(c.created_at) AS primeira, MIN(c.safra_ini) AS safra_ini FROM ciclo c GROUP BY 1),
alvo AS MATERIALIZED (
  -- pacientes que aparecem em alguma etapa do período, com as etapas já marcadas
  SELECT c.patient_id,
    CASE WHEN $4 = 'safra'
         THEN bool_or(c.novo AND c.ref_dt >= $1 AND c.ref_dt < $2)
         ELSE bool_or(c.novo AND c.created_at >= $1 AND c.created_at < $2) END AS agendou,
    CASE WHEN $4 = 'safra'
         THEN bool_or(c.created_at >= c.safra_ini AND (c.confirmed_time IS NOT NULL OR c.attended_time IS NOT NULL))
         ELSE bool_or((c.confirmed_time >= $1 AND c.confirmed_time < $2)
                      OR (c.attended_time >= $1 AND c.attended_time < $2)) END AS confirmou,
    CASE WHEN $4 = 'safra'
         THEN bool_or(c.created_at >= c.safra_ini AND c.attended_time IS NOT NULL)
         ELSE bool_or(c.attended_time >= $1 AND c.attended_time < $2) END AS compareceu,
    MIN(c.ref_dt) FILTER (WHERE c.novo) AS ref_dt
  FROM ciclo c GROUP BY 1),
pg0 AS MATERIALIZED (
  SELECT p.id, p.patient_id, p.amount, p.date
  FROM "BI Payments" p
  JOIN pac_tot t ON t.patient_id = p.patient_id
  WHERE p.deleted_at IS NULL
    AND NOT (btrim(COALESCE(p.payment_type_name,'')) ILIKE 'boleto programado' AND COALESCE(p.is_confirmed,false) = false)
    AND ($3 IS NULL OR p.clinic_id = ANY($3))
    AND CASE WHEN $4 = 'safra'
             THEN t.safra_ini IS NOT NULL AND p.date >= date_trunc('day', t.safra_ini)
             ELSE p.date >= date_trunc('day', t.primeira) AND p.date >= $1 AND p.date < $2 END),
pg AS (
  SELECT p.patient_id, SUM(p.amount)::numeric AS total, COUNT(*)::int AS n
  FROM pg0 p
  -- venda que vem depois de consulta de Follow-Up/Resgate é do funil de resgate, não da campanha
  -- (caso da Thauany, 27/10): olha a última consulta atendida do paciente antes do pagamento
  WHERE COALESCE((SELECT x.subchannel_name FROM "BI Appointments" x
                  WHERE x.patient_id = p.patient_id AND x.attended_time IS NOT NULL AND x.start_time <= p.date
                  ORDER BY x.start_time DESC LIMIT 1), '') !~* '^(follow|resgate)'
  GROUP BY 1),
info AS (
  SELECT c.patient_id, MAX(c.clinic_id) AS clinic_id, MAX(c.patient_name) AS patient_name,
         MAX(c.phone_norm) AS phone_norm, MAX(c.cw_contact_id) AS cw_contact_id, MAX(c.account_id) AS account_id,
         MAX(c.lead_name) AS lead_name, MIN(c.ref_dt) AS lead_dt,
         array_agg(DISTINCT concat_ws(' · ', c.channel_name, c.subchannel_name)) AS canais,
         array_agg(DISTINCT c.atendente) FILTER (WHERE c.atendente IS NOT NULL) AS atendentes
  FROM ciclo c GROUP BY 1)
SELECT i.clinic_id, i.patient_id, i.patient_name, i.phone_norm, i.cw_contact_id, i.account_id, i.lead_name,
       COALESCE(a.ref_dt, i.lead_dt) AS lead_dt,
       a.agendou,
       CASE WHEN $4 = 'safra' THEN a.agendou AND a.confirmou ELSE a.confirmou END,
       CASE WHEN $4 = 'safra' THEN a.agendou AND a.compareceu ELSE a.compareceu END,
       COALESCE(g.total, 0), COALESCE(g.n, 0), i.canais, COALESCE(i.atendentes, ARRAY[]::text[])
FROM alvo a
JOIN info i ON i.patient_id = a.patient_id
LEFT JOIN pg g ON g.patient_id = a.patient_id
WHERE CASE WHEN $4 = 'safra' THEN a.agendou
           ELSE a.agendou OR a.confirmou OR a.compareceu OR COALESCE(g.total, 0) > 0 END
$q$
USING p_start, p_end, p_clinic_ids, p_view, p_creators, p_agent_mode;
END;
$function$;

-- Leads do período: contato do Chatwoot com etiqueta de campanha ou anúncio, contado na data em
-- que o lead caiu (a mais recente entre a criação do contato e o anúncio). Piso de 06/04/2026
-- para não contar a carga antiga da Cloudia como lead novo.
CREATE OR REPLACE FUNCTION public.funnel_v7_leads(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[])
 RETURNS TABLE(phone_norm text, lead_clinic_id text, account_id integer, cw_contact_id bigint, lead_name text, lead_dt timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT DISTINCT ON (x.phone_norm) x.phone_norm, x.ecuro_clinic_id, x.account_id, x.id, x.name, x.lead_dt
  FROM (
    SELECT cl.*, GREATEST(cl.created_at_cw,
                          COALESCE((cl.anuncio_dt AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'America/Sao_Paulo',
                                   cl.created_at_cw)) AS lead_dt
    FROM chatwoot_leads cl
    WHERE ('campanha' = ANY(cl.labels) OR cl.tem_anuncio)
      AND cl.phone_norm IS NOT NULL AND length(cl.phone_norm) >= 10
      AND (p_clinic_ids IS NULL OR cl.ecuro_clinic_id = ANY(p_clinic_ids))) x
  WHERE x.lead_dt >= GREATEST(p_start, '2026-04-06 00:00:00+00'::timestamptz) AND x.lead_dt < p_end
  ORDER BY x.phone_norm, x.lead_dt DESC;
$function$;

CREATE OR REPLACE FUNCTION public.funnel_stats_v7(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_view text DEFAULT 'comissao'::text, p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '60s'
AS $function$
WITH r AS MATERIALIZED (SELECT * FROM public.funnel_v7_rows(p_start, p_end, p_clinic_ids, p_view, p_creators, p_agent_mode)),
m AS (SELECT
    (SELECT COUNT(*) FROM public.funnel_v7_leads(p_start, p_end, p_clinic_ids)) AS leads,
    (SELECT COUNT(*) FROM r WHERE agendou) AS agendados,
    (SELECT COUNT(*) FROM r WHERE confirmou) AS confirmados,
    (SELECT COUNT(*) FROM r WHERE compareceu) AS compareceram,
    (SELECT COUNT(*) FROM r WHERE total_pago > 0) AS venderam,
    (SELECT COALESCE(SUM(total_pago), 0)::numeric FROM r) AS receita)
SELECT jsonb_build_object(
  'period', jsonb_build_object('start', p_start, 'end', p_end),
  'view', p_view,
  'funnel', jsonb_build_object('leads', leads, 'agendados', agendados, 'confirmados', confirmados,
                               'compareceram', compareceram, 'venderam', venderam, 'receita_total', receita),
  'conversoes', jsonb_build_object(
    'lead_to_agend', CASE WHEN leads > 0 THEN ROUND(100.0*agendados/leads, 1) ELSE 0 END,
    'agend_to_conf', CASE WHEN agendados > 0 THEN ROUND(100.0*confirmados/agendados, 1) ELSE 0 END,
    'conf_to_comp',  CASE WHEN confirmados > 0 THEN ROUND(100.0*compareceram/confirmados, 1) ELSE 0 END,
    'comp_to_venda', CASE WHEN compareceram > 0 THEN ROUND(100.0*venderam/compareceram, 1) ELSE 0 END),
  'rules', jsonb_build_object(
    'versao', 'v7 (regras de 27/10/2026)',
    'visao', CASE WHEN p_view = 'safra'
                  THEN 'safra: leads que caíram no período e o que eles fizeram depois'
                  ELSE 'comissão: cada etapa no período em que aconteceu' END,
    'campanha', 'consulta de Avaliação de lead de anúncio (Chatwoot) ou marcada Lead Campanha no Ecuro',
    'paciente_antigo', 'fora quem concluiu consulta nos 6 meses antes do agendamento',
    'lead', 'sem prazo de validade',
    'remarcacao', 'nova consulta de campanha em até 60 dias da anterior não conta como novo agendamento',
    'fachada', 'canal fora do CRC e da Maria Clara só conta até 30 dias depois do lead',
    'receita', 'valores lançados como pagamento; boleto programado só quando pago',
    'confirmados', 'informativo')
) FROM m;
$function$;

CREATE OR REPLACE FUNCTION public.funnel_detail_v7(p_stage text, p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_view text DEFAULT 'comissao'::text, p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_origem_channels text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '60s'
AS $function$
WITH base AS MATERIALIZED (
  SELECT l.phone_norm, l.lead_clinic_id, l.account_id, l.cw_contact_id::integer AS cw_contact_id,
         l.lead_name, l.lead_dt AS lead_created_at,
         NULL::uuid[] AS patient_ids, ARRAY[]::text[] AS patient_channel_names, ARRAY[]::text[] AS atendentes,
         false AS agendou, false AS confirmou, false AS compareceu, 0::numeric AS total_pago, 0::int AS n_pgto
  FROM public.funnel_v7_leads(p_start, p_end, p_clinic_ids) l
  WHERE p_stage = 'leads'
  UNION ALL
  SELECT r.phone_norm, r.clinic_id, r.account_id, r.cw_contact_id, COALESCE(r.patient_name, r.lead_name), r.lead_dt,
         ARRAY[r.patient_id], COALESCE(r.canais, ARRAY[]::text[]), r.atendentes,
         r.agendou, r.confirmou, r.compareceu, r.total_pago, r.n_pgto
  FROM public.funnel_v7_rows(p_start, p_end, p_clinic_ids, p_view, p_creators, p_agent_mode) r
  WHERE p_stage <> 'leads'),
filtered AS MATERIALIZED (
  SELECT * FROM base
  WHERE CASE p_stage
          WHEN 'leads'        THEN true
          WHEN 'agendados'    THEN agendou
          WHEN 'confirmados'  THEN confirmou
          WHEN 'compareceram' THEN compareceu
          WHEN 'venderam'     THEN total_pago > 0
          ELSE false END
    AND (p_search IS NULL OR p_search = '' OR
         lower(public.immutable_unaccent(lead_name)) ILIKE '%'||lower(public.immutable_unaccent(p_search))||'%' OR
         (regexp_replace(p_search,'[^0-9]','','g') <> '' AND phone_norm ILIKE '%'||regexp_replace(p_search,'[^0-9]','','g')||'%'))
    AND (p_origem_channels IS NULL OR EXISTS (
           SELECT 1 FROM unnest(patient_channel_names) c, unnest(p_origem_channels) o WHERE c ILIKE o || '%')))
SELECT jsonb_build_object('stage', p_stage, 'view', p_view, 'count', (SELECT COUNT(*) FROM filtered),
  'limit', p_limit, 'offset', p_offset,
  'rows', COALESCE((SELECT jsonb_agg(row_to_json(x)) FROM (
     SELECT phone_norm, lead_clinic_id, account_id, cw_contact_id, lead_name, lead_created_at,
            patient_ids, patient_channel_names, atendentes, confirmou, compareceu, total_pago, n_pgto
     FROM filtered
     ORDER BY CASE WHEN p_stage = 'venderam' THEN total_pago ELSE 0 END DESC, lead_created_at DESC NULLS LAST
     LIMIT p_limit OFFSET p_offset) x), '[]'::jsonb));
$function$;
