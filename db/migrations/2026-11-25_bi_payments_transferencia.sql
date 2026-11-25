-- 25/11/2026 · Transferência de saldo no "BI Payments"
--
-- O /bi/payments do Ecuro devolve `is_transfer` (0/1) e `origin_payment_id` (pagamento de onde o saldo saiu).
-- As colunas não existiam aqui, e o filtro anti schema-drift do sync (dash-sync-jobs, bulkUpsertBI) descartava
-- os dois campos. O Ecuro grava a transferência como um lançamento NOVO, com o mesmo valor, e mantém o original
-- vivo: somando tudo, o dinheiro contava duas vezes. As funções de receita passam a ignorar `is_transfer = 1`
-- quando o pagamento original está no banco e vivo (db/functions/*.sql, mesma data).
--
-- Colunas novas, nulas, sem default: no Postgres 11+ é só metadado (sem reescrever a tabela).
-- Depois do ALTER: NOTIFY pgrst + reiniciar o sync da VPS (o filtro de colunas é cacheado por processo).
-- Histórico: backfill noturno pelo modo histórico do Ecuro (20h–08h), só nas linhas com is_transfer = 1.

SET lock_timeout = '5s';

ALTER TABLE public."BI Payments"
  ADD COLUMN IF NOT EXISTS is_transfer smallint,
  ADD COLUMN IF NOT EXISTS origin_payment_id uuid;

COMMENT ON COLUMN public."BI Payments".is_transfer IS
  'Ecuro: 1 = lançamento de transferência de saldo (o dinheiro já está no pagamento original). NULL = não informado (linha anterior a 25/11/2026 ainda não reprocessada).';
COMMENT ON COLUMN public."BI Payments".origin_payment_id IS
  'Ecuro: pagamento de onde o saldo foi transferido (só quando is_transfer = 1).';

NOTIFY pgrst, 'reload schema';
