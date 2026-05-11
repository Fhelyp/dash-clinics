# Regras de Negócio — Dashboard Ecuro

Documento atualizado em **11/05/2026** (após validação Fhely).

## 1. Atribuição de Receita à Maria Clara (MC)

### Regra V4 (atual, vigente)

Um pagamento é atribuído à **Maria Clara** se, e somente se:

1. **Mesmo paciente** (`patient_id`) teve agendamento de **Avaliação Inicial** (`speciality_id = '8409c08e-f3fa-43a0-b9bd-53128cecdbdc'`)
2. Esse agendamento foi **comparecido** (status 7 = Atendido OU 8 = Concluído)
3. **MC tocou nesse agendamento**:
   - `channel_id` é canal MC (`fs22aka...` ou `hs22aka...`), **OU**
   - Existe log com `user_id = 'fs22aka-7860-431d-b312-a9a72eb7d27a'` (MC interagiu — confirmou, lembrou, reagendou)
4. `start_time` desse agendamento ∈ `[p.date - 30d, p.date]`

Senão → atribui a **HUM** (operadores). **MC + HUM = receita_total** (100% dos pagamentos).

### Filtros do dashboard
- **Maria Clara** → `receita_total = mc_revenue_v4`
- **Operadores** → `receita_total = hum_revenue_v4`
- **Todos** → soma geral

### Versões depreciadas
- V1: "primeiro appt MC concluído" (falhava com múltiplos appts)
- V2 Thawany: "último comparec ≤30d" (subatribuía — último era HUM em retornos)
- V3 curto: "MC tocou em qq appt" (sobreatribuía — incluía só toque em retorno)

V4 = avaliação inicial + comparecida + MC tocou + 30d = equilíbrio.

---

## 2. Funil de Vendas (Marketing)

| Estágio | Definição |
|---|---|
| **Lead** | Chatwoot label `campanha`, `created_at_cw >= 2026-04-06` (exclui bulk import 01-04/04) |
| **Agendado** | Phone do lead bate (variantes BR ±9, ±CC55) com `BI Appointments.phone`, `appt.created_at >= lead.created_at_cw` |
| **Confirmado** | LOG `to_status=4` OU status final ∈ {7,8} |
| **Compareceu** | status final ∈ {7, 8} |
| **Vendeu** | Paciente pagou ≥1 vez no período, `pgto.date >= lead.created_at_cw` |

Cada barra é clicável → modal lista contatos.

---

## 3. Auditoria

| Tabela | Conteúdo |
|---|---|
| Agendamentos (mn) | appts criados no período + filtros |
| Confirmações (cf) | logs `to_status=4` (mostra MC vs operador) |
| Reagendamentos (rg) | logs `to_status=3` |

Filtro operador normalizado (`Pedro Leão` ≡ `Pedro Leao`) via coluna geradora `created_by_name_norm`.

---

## 4. Cleanup rolling 3 meses

`cleanup_old_data()` no cron 22h BRT remove dados < (mês corrente - 2 meses) de Appointments, Logs, Payments. Storage estável ~200 MB.

---

## 5. Bulk import Chatwoot (excluído do funil)

01-04/04/2026 → 42.993 contatos importados do Cloud com label `campanha`. Funil **EXCLUI** leads com `created_at_cw < 2026-04-06` via `min_lead_created_at` em `funnel_stats()`.

---

## 6. Sincronização Ecuro

- **Cron 22h BRT**: bootstrap mês corrente + 7 dias lookback + cleanup
- **Cron 04h BRT**: incremental últimas 36h
- **Cron 03h BRT (sync-cw-leads)**: incremental Chatwoot leads
- **Cron sáb 04h BRT (sync-cw-leads)**: full refresh Chatwoot
- 3 feeds sequenciais: appointments → logs → payments
- Free tier `waitUntil` 30s. Quando esgota, payments fica pra trás → workaround: backfill local com retry agressivo via `scripts/local-backfill-mai.mjs`
