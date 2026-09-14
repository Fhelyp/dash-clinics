# Sync × schema drift do Ecuro — incidente 26–31/08/2026 e runbook

## O que aconteceu
De **26/08 a 31/08** o sync noturno do Ecuro falhou TODA noite com a assinatura:
`clinicas ok=1 err=36 | apt=0 logs=0 pgto=~190k | erros=~72` (72 = 36 clínicas × 2 feeds).

**Causa raiz:** o Ecuro **adicionou um campo novo** ao feed `/bi/appointments` —
**`cancellation_reason_code`** — e a edge function `bulk-upsert-bi` (PostgREST) rejeita
payload com coluna desconhecida:

```
bulk-upsert BI Appointments 500: Could not find the 'cancellation_reason_code'
column of 'BI Appointments' in the schema cache
```

Efeito cascata: com os appointments falhando, os `appointment_logs` falhavam na FK
(`bi_logs_appointment_fk` — o agendamento referenciado nunca entrou). O feed `payments`
não mudou → continuava OK (por isso pgto != 0 nos alertas).

## Correção aplicada (31/08)
1. **DDL aditivo** (instantâneo, nullable, não quebra nada):
   ```sql
   ALTER TABLE "BI Appointments" ADD COLUMN IF NOT EXISTS cancellation_reason_code text;
   NOTIFY pgrst, 'reload schema';   -- o erro é do SCHEMA CACHE do PostgREST: recarregar!
   ```
2. Teste em 1 clínica (Taubaté): `+1602 apt, +3982 logs, 0 erros` — FK dos logs curou sozinha.
3. Backfill da frota (37 clínicas) rodando o **código da VPS localmente** com
   `INCREMENTAL_DAYS=6.5` (cobre o buraco 26→31/08). Mesmo playbook de 27/07.
4. Rollup refeito para a janela afetada após o backfill.

## Runbook — se acontecer de novo (sync com apt=0 e erros ~= 2×clínicas)
1. Ler o erro real: `GET https://dash-sync-jobs.5ef4kt.easypanel.host/logs/sync-ecuro?lines=300`
   (ou `/status` → `errors_sample`).
2. Se for `Could not find the '<campo>' column ... schema cache`:
   - Provar o feed: chamar o endpoint do Ecuro com `limit=3` e comparar as chaves da row
     com `information_schema.columns` da tabela.
   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS <campo> text;` (text é seguro p/ enum/número)
   - `NOTIFY pgrst, 'reload schema';`
   - Testar 1 clínica antes da frota.
3. Fechar o buraco: rodar o código da VPS local com `INCREMENTAL_DAYS=6.5` (máx da API ~7d).
   Se o buraco for > 6,5 dias → bootstrap (janela 20h–08h BRT, 29 dias máx).
4. Refazer o rollup da janela afetada (ver `db/ROLLUP_CRON.md`).

## Prevenção — ✅ IMPLEMENTADA (31/08, dash-sync-jobs `feada7c`)
O `bulkUpsertBI`/`upsertChatwootLeads` (VPS `src/lib/supabase.js`) agora **filtram campos
desconhecidos** antes do upsert: pegam as **colunas REAIS da tabela** (via PostgREST
`select=*&limit=1`, cache por processo) e descartam qualquer chave que não seja coluna —
excluindo também as `GENERATED ALWAYS` (`patient_name_norm`/`phone_norm`/`created_by_name_norm`).
Campo novo do Ecuro → **ignorado + alerta 1×** no log (`SCHEMA DRIFT ...`), o feed NÃO cai.
Abordagem DINÂMICA (auto-mantém): se um dia a gente ADD a coluna no banco, o campo passa a
fluir sozinho no próximo restart — sem editar lista hardcoded. Fallback seguro: se a leitura
das colunas falhar, não filtra (comportamento antigo). Testado: dropa desconhecido + geradas,
upsert retorna OK. **Falta só o redeploy da VPS no Easypanel** (o código já está na `main`).

> Nota: a Routine da nuvem já tinha detectado isto (PR #14, branch `puc52p`, allowlist
> ESTÁTICA) — o `feada7c` na main o supersede (dinâmico + guarda `cancellation_reason_code`).
> PR #14 pode ser fechado como resolvido. Uma vez deployado, as ~65 ativações da Routine param.

## Observações da mesma investigação
- **Bertioga** (`c04fd517-…`): clínica NOVA no `unitConfigs`, sem Chatwoot, entrou na frota
  em ~26/08. Só terá histórico completo após um bootstrap noturno (o incremental cobre
  apenas os últimos dias).
- **`pgto=~190k`/noite nos alertas NÃO é problema:** a tabela não incha (~1k novas/dia);
  o feed payments re-manda registros cujo `updated_at` o Ecuro re-bumpa. Desperdício
  idempotente, sem ação necessária.
