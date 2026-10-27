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
--        'safra'    → só os leads que caíram no período; deles, quem agendou, compareceu e
--                     pagou, em qualquer data.
--   4. Campanha = consulta de Avaliação, de lead que veio de anúncio (Chatwoot) ou marcada
--      "Lead Campanha" no Ecuro. Follow-up e resgate ficam no funil próprio.
--   5. Remarcação não conta como novo agendamento: outra consulta de campanha do mesmo
--      paciente nos 60 dias anteriores = remarcação. O comparecimento dela conta.
--   6. Lead que foi direto à clínica (canal que não é CRC nem Maria Clara): só é campanha se a
--      consulta foi criada até 30 dias depois da data do lead.
--   7. Família no mesmo telefone: já tratada na atribuição (nome compatível, 19/10).
--   8. Receita: valores lançados como pagamento; boleto programado só quando pago.
--   9. Confirmados: informativo.
-- Filtro de operador (p_creators): mesmos nomes do filtro "Operador" do dash; Maria Clara = 'maria clara'.
-- p_agent_mode: 'ALL' | 'MC' (só Maria Clara) | 'HUM' (só operadores), igual ao botão do dash.

CREATE OR REPLACE FUNCTION public.funnel_v7_rows(p_start timestamp with time zone, p_end timestamp with time zone, p_clinic_ids text[] DEFAULT NULL::text[], p_view text DEFAULT 'comissao'::text, p_creators text[] DEFAULT NULL::text[], p_agent_mode text DEFAULT 'ALL'::text)
 RETURNS TABLE(clinic_id text, patient_id uuid, patient_name text, phone_norm text, cw_contact_id integer, account_id integer, lead_name text, lead_dt timestamp with time zone, agendou boolean, confirmou boolean, compareceu boolean, total_pago numeric, n_pgto integer, canais text[], atendentes text[])
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '60s'
AS $function$
WITH
cr AS (
  SELECT array_agg(lower(public.immutable_unaccent(btrim(regexp_replace(c, '\s+', ' ', 'g'))))) AS list
  FROM unnest(COALESCE(p_creators, ARRAY[]::text[])) c),
-- data em que o lead "caiu": a mais recente entre a criação do contato e o anúncio registrado
-- (anuncio_dt vem como meia-noite UTC do dia; vira meia-noite de Brasília do mesmo dia)
lead_att AS MATERIALIZED (
  SELECT att.appt_id, att.cw_contact_id, att.account_id, att.lead_name,
         GREATEST(COALESCE(cl.created_at_cw, att.lead_created_at),
                  COALESCE((cl.anuncio_dt AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'America/Sao_Paulo',
                           att.lead_created_at)) AS lead_dt
  FROM campaign_appt_attribution att
  LEFT JOIN chatwoot_leads cl ON cl.id = att.cw_contact_id AND cl.account_id = att.account_id
  WHERE (p_clinic_ids IS NULL OR att.clinic_id = ANY(p_clinic_ids))),
camp AS MATERIALIZED (
  SELECT a.id AS appt_id, a.clinic_id, a.patient_id, a.patient_name, a.phone_norm, a.created_at,
         a.attended_time, a.confirmed_time, a.status, a.channel_name, a.subchannel_name,
         CASE WHEN a.channel_name = 'Maria Clara IA' THEN 'Maria Clara'
              ELSE NULLIF(btrim(regexp_replace(COALESCE(a.created_by_name,''), '\s+', ' ', 'g')), '') END AS atendente,
         CASE WHEN a.channel_name = 'Maria Clara IA' THEN 'maria clara'
              WHEN COALESCE(btrim(a.created_by_name),'') = '' THEN 'sem criador'
              ELSE a.created_by_name_norm END AS creator_key,
         la.cw_contact_id, la.account_id, la.lead_name, la.lead_dt
  FROM "BI Appointments" a
  LEFT JOIN lead_att la ON la.appt_id = a.id
  WHERE a.patient_id IS NOT NULL
    AND a.created_at < p_end
    AND a.speciality_id = '8409c08e-f3fa-43a0-b9bd-53128cecdbdc'::uuid        -- regra 4: Avaliação
    AND COALESCE(a.subchannel_name,'') !~* '^(follow|resgate)'                 -- funil de resgate/follow
    AND (p_clinic_ids IS NULL OR a.clinic_id = ANY(p_clinic_ids))
    AND (a.subchannel_name = 'Lead Campanha'
         OR (la.appt_id IS NOT NULL
             AND (a.channel_name IN ('CRC','Maria Clara IA')                    -- regra 2: sem prazo
                  OR a.created_at <= la.lead_dt + interval '30 days')))),       -- regra 6
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
  WHERE (p_creators IS NULL OR s.creator_key IN (SELECT unnest(list) FROM cr))
    AND (COALESCE(p_agent_mode,'ALL') IN ('ALL','')
         OR (p_agent_mode = 'MC' AND s.creator_key = 'maria clara')
         OR (p_agent_mode = 'HUM' AND s.creator_key <> 'maria clara'))),
-- início do "ciclo" de cada consulta = data do novo agendamento que a abriu (para a safra)
ciclo AS MATERIALIZED (
  SELECT f.*, COALESCE(f.lead_dt, f.created_at) AS ref_dt FROM camp_f f),
pac_tot AS (SELECT c.patient_id, MIN(c.created_at) AS primeira FROM ciclo c GROUP BY 1),
alvo AS MATERIALIZED (
  -- pacientes que aparecem em alguma etapa do período, com as etapas já marcadas
  SELECT c.patient_id,
    CASE WHEN p_view = 'safra'
         THEN bool_or(c.novo AND c.ref_dt >= p_start AND c.ref_dt < p_end)
         ELSE bool_or(c.novo AND c.created_at >= p_start AND c.created_at < p_end) END AS agendou,
    CASE WHEN p_view = 'safra'
         THEN bool_or(c.confirmed_time IS NOT NULL OR c.attended_time IS NOT NULL)
         ELSE bool_or((c.confirmed_time >= p_start AND c.confirmed_time < p_end)
                      OR (c.attended_time >= p_start AND c.attended_time < p_end)) END AS confirmou,
    CASE WHEN p_view = 'safra'
         THEN bool_or(c.attended_time IS NOT NULL)
         ELSE bool_or(c.attended_time >= p_start AND c.attended_time < p_end) END AS compareceu,
    MIN(c.ref_dt) FILTER (WHERE c.novo) AS ref_dt
  FROM ciclo c GROUP BY 1),
safra AS (SELECT a.patient_id FROM alvo a WHERE a.agendou),
pg AS (
  SELECT p.patient_id, SUM(p.amount)::numeric AS total, COUNT(*)::int AS n
  FROM "BI Payments" p
  JOIN pac_tot t ON t.patient_id = p.patient_id
  WHERE p.deleted_at IS NULL
    AND NOT (btrim(COALESCE(p.payment_type_name,'')) ILIKE 'boleto programado' AND COALESCE(p.is_confirmed,false) = false)
    AND (p_clinic_ids IS NULL OR p.clinic_id = ANY(p_clinic_ids))
    AND p.date >= date_trunc('day', t.primeira)
    AND CASE WHEN p_view = 'safra'
             THEN p.patient_id IN (SELECT patient_id FROM safra)
             ELSE p.date >= p_start AND p.date < p_end END
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
       CASE WHEN p_view = 'safra' THEN a.agendou AND a.confirmou ELSE a.confirmou END,
       CASE WHEN p_view = 'safra' THEN a.agendou AND a.compareceu ELSE a.compareceu END,
       COALESCE(g.total, 0), COALESCE(g.n, 0), i.canais, COALESCE(i.atendentes, ARRAY[]::text[])
FROM alvo a
JOIN info i ON i.patient_id = a.patient_id
LEFT JOIN pg g ON g.patient_id = a.patient_id
WHERE CASE WHEN p_view = 'safra' THEN a.agendou
           ELSE a.agendou OR a.confirmou OR a.compareceu OR COALESCE(g.total, 0) > 0 END;
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
