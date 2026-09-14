# Rollup noturno — cron de refresh (manutenção)

## O que é
O dashboard serve o admin/gerente pelo caminho rápido `dashboard_stats_fast`, que lê a
tabela pré-agregada **`dashboard_daily_rollup`**. Essa tabela precisa ser **refeita todo
dia**, senão o dash mostra dados congelados (o `live` fica certo, mas é lento e só é usado
como fallback).

A função que refaz é **`refresh_rollup_and_precompute()`** (janela rolante de 16 dias,
lotes de 10 clínicas, + `refresh_precomputed()` no fim). Roda em ~**9s** num banco saudável.

## Incidente 24/08/2026 — dash mostrando R$ 0,00 em agosto
**Sintoma:** admin abriu o dash no período 01–24/08 e viu Receita R$ 0,00, 0 concluídos,
6.670 agendamentos — mas a base tinha 26.909 concluídos e **R$ 7,24 mi** (sync fresco).

**Causa raiz:** o job pg_cron do rollup (`job2`) vinha **falhando com `statement timeout`
todo dia (12–23/07)** — era o período do incidente, banco Nano saturado — e depois foi
**removido**. Resultado: `cron.job` VAZIO, rollup **congelado desde 23/07** (quando agosto
ainda era futuro → 0/R$0). O `fast` servia esse rollup velho.

**Correção aplicada (24/08):**
1. Refeito o rollup manualmente `2026-07-28..2026-08-25`, 36 clínicas, health-gated (3,7min,
   pico 0,08–0,12s). `fast` voltou a bater `live` (47.299 / 26.909 / R$ 7.242.442).
2. `refresh_precomputed()` rodado.
3. **Cron RELIGADO:**
   ```sql
   SELECT cron.schedule('rollup-precompute-nightly', '0 9 * * *',
     'SELECT public.refresh_rollup_and_precompute()');
   -- 09:00 UTC = 06:00 BRT (após o sync 04h BRT, antes do time às 08h). jobid=3, active=true.
   ```
   A função levou **9s** no teste (banco Micro, saudável) — o timeout antigo era 100%
   saturação Nano, não a função.

## Como checar se está saudável (rodar de tempos em tempos)
```sql
-- 1) o cron existe e está ativo?
SELECT jobid, jobname, schedule, active FROM cron.job;
-- 2) últimas execuções (tem que estar 'succeeded')
SELECT jobid, status, start_time, return_message FROM cron.job_run_details
  ORDER BY start_time DESC LIMIT 10;
-- 3) o rollup está fresco? (refreshed_at recente)
SELECT max(refreshed_at) FROM dashboard_daily_rollup;
-- 4) fast == live? (não pode divergir num período fechado)
SELECT dashboard_stats_fast('2026-08-01','2026-08-25')->'kpis'->'receita_total',
       dashboard_stats_live('2026-08-01','2026-08-25')->'kpis'->'receita_total';
```

## Refresh manual (se o cron falhar de novo)
Per-clínica, com health-gate (padrão seguro — NÃO rodar tudo em massa sob carga):
```
scratchpad: loop refresh_daily_rollup(from,to, ARRAY[clinic_id]) por clínica, abortar
se `select 1` passar de 3s. Ver histórico em reference_dashboard_rollup (memória).
```

## ⚠️ Se voltar a estourar timeout
Não foi a função (roda em 9s) — é sinal de **banco saturado** (sync pesado concorrente,
tier baixo). Investigar carga antes de mexer na função. A função já é auto-protegida:
`statement_timeout 2700s` + try/catch por lote (lote lento não derruba o batch).

## Ampliação da janela (10/09/2026) — meses fechados não congelam mais
Sintoma: `dashboard_stats_fast` divergia do `_live` em meses FECHADOS (agosto: agend −19,
receita −73k) porque o cron só refrescava `d2-16` (16 dias) → ao sair da janela, o dia
"congelava" e não pegava pagamentos/cancelamentos tardios.
Fix: `refresh_rollup_and_precompute()` agora usa `d_from = 1º dia do mês ANTERIOR`
(cobre mês atual + anterior sempre). Testado: 37 clínicas, range 01/08→10/09, **52s**,
0 falhas, health 0,09s. Dentro do statement_timeout de 2700s com folga.

## Incidente 11–14/09/2026 — cron do rollup morrendo em 120s (rollup congelado desde 10/09)
**Sintoma:** clientes "não conseguem usar o dash" — períodos recentes com dados
congelados/zerados. `max(refreshed_at)` parado em 10/09; `cron.job_run_details` mostrava
`rollup-precompute-nightly` (jobid 3) **failed** em 11,12,13,14/09 com
`canceling statement due to statement timeout`, cada run durando **exatamente 120s**.
O run de 10/09 levou 30s (OK).

**Causa raiz — GOTCHA do `statement_timeout`:** o default da instância (Supabase) é
**120s ("2min")** e vale até para a sessão do pooler. A função declara
`SET statement_timeout TO '2700s'`, **mas isso é um NO-OP para a própria chamada**: o
timeout do statement `SELECT refresh_rollup_and_precompute()` é armado ANTES de entrar na
função, com o valor da sessão (120s). Mudar o GUC dentro da função NÃO re-arma o timer do
statement em curso. Enquanto a função terminava em <120s, "funcionava"; quando agosto
(mês fechado, refeito inteiro toda noite) ficou pesado (~97s só ele; total ~196s), passou
de 120s e o cron passou a morrer. Nunca esteve realmente protegido pelos 2700s.

**Correção aplicada (14/09):**
1. Remediação imediata: refresh manual de setembro (01→14, 37 clínicas) + `refresh_precomputed()`
   numa conexão psycopg2. Depois, com `SET statement_timeout='3600s'` ANTES do SELECT na
   MESMA conexão, rodei a função inteira: **196s, 0 fail_batches** (refez agosto+setembro).
   `fast==live` para 01–15/09 (R$ 3.706.840,42 / 24.454 agend / 13.392 concl), fast 1,1s.
2. Cron reagendado pondo o SET no COMANDO (arma o timeout do statement seguinte — testado:
   `SET statement_timeout='5s'; SELECT pg_sleep(8)` estoura em 5s):
   ```sql
   SELECT cron.schedule('rollup-precompute-nightly', '0 9 * * *',
     $$SET statement_timeout = '3600s'; SELECT public.refresh_rollup_and_precompute();$$);
   ```
   jobid segue 3, active=true. (O `SET` da definição da função pode ficar, mas é inócuo — o
   que vale é o SET no comando do cron, executado como statement separado antes do SELECT.)

⚠️ **Regra daqui pra frente:** para QUALQUER cron pesado (>120s), o `SET statement_timeout`
tem que estar no **comando do cron** (antes do SELECT), NÃO só na definição da função.
