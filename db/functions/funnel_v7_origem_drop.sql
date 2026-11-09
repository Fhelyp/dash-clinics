-- 09/11/2026: filtros novos (Origem no funil v7; Especialidade e Origem nas ações do CRC) mudaram a
-- assinatura destas funções. Rodar ESTE arquivo e depois funnel_v7.sql e crc_acoes.sql NA MESMA
-- TRANSAÇÃO: sem o DROP ficariam duas versões de cada função e o PostgREST não saberia qual chamar.
DROP FUNCTION IF EXISTS public.funnel_v7_rows(timestamp with time zone, timestamp with time zone, text[], text, text[], text);
DROP FUNCTION IF EXISTS public.funnel_stats_v7(timestamp with time zone, timestamp with time zone, text[], text, text[], text);
DROP FUNCTION IF EXISTS public.funnel_detail_v7(text, timestamp with time zone, timestamp with time zone, text[], text, text[], text, integer, integer, text, text[]);
DROP FUNCTION IF EXISTS public.crc_acoes_base(timestamp with time zone, timestamp with time zone, text[], text[], text);
DROP FUNCTION IF EXISTS public.crc_acoes_stats(timestamp with time zone, timestamp with time zone, text[], text[], text);
DROP FUNCTION IF EXISTS public.crc_acoes_detail(text, text, timestamp with time zone, timestamp with time zone, text[], text[], text, integer, integer);
