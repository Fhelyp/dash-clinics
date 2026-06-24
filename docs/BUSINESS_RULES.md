# Regras de Negócio — Dashboard Ecuro

Documento atualizado em **24/06/2026** (refactor do funil por lead + receita por pessoa).

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

## 2. Funil de Vendas (Marketing) — POR LEAD

**Refatorado em 24/06/2026.** Toda etapa conta o **LEAD (telefone) uma única vez** — não importa quantas consultas/cadastros a pessoa tenha. Antes contava por `patient_id`, o que inflava com cadastros duplicados (mesma pessoa, 2 cadastros no Ecuro) e familiares no mesmo telefone.

| Estágio | Definição (por LEAD / telefone) |
|---|---|
| **Lead** | Chatwoot label `campanha`, telefone válido, `created_at_cw >= 2026-04-06` (exclui bulk Cloudia). Conta telefones distintos criados no período. |
| **Agendou** | Telefone do lead bate (4 variantes BR: ±9º dígito, ±55) com `BI Appointments.phone_norm`, `appt.created_at >= lead.created_at_cw`. Conta leads distintos com ≥1 appt no período. |
| **Confirmou** | Lead com ≥1 appt com LOG `to_status=4` OU status ∈ {7,8}. |
| **Compareceu** | Lead com ≥1 consulta **Concluída (status = 8)**. ⚠️ Mudou 24/06: era {7,8}, agora só 8 (= "concluído" conforme operação). |
| **Vendeu** | Lead cuja **pessoa** (qualquer cadastro do telefone) fez ≥1 pagamento no período, `pgto.date >= lead.created_at_cw`. |
| **Receita** | SOMA de **todos** os pagamentos da pessoa no período (mesmo múltiplos), independente de confirmado. |

**Regra cohort:** conta o evento no período independente da chegada do lead (lead de abril que compareceu em junho conta em junho). Só "Lead" é fixo (criados no período) → conversão pode passar de 100%.

**Tabelas (pré-cálculo noturno via `refresh_campaign_attribution`, job `refresh-attribution`):**
- `campaign_appt_attribution` — appt → lead (telefone), base das etapas.
- `campaign_patient` — TODOS os cadastros de paciente de um telefone de campanha (sem a restrição "appt depois do lead"), base da receita por pessoa. Resolveu R$4k→R$12k em Campo Limpo (pagamentos sob cadastro irmão).

**Funções:** `funnel_stats_v2` (números) e `funnel_detail` (drill). **`count == drill`** em todas as etapas (validado). Cada barra clicável → modal lista os leads (1 linha por contato, sem repetir).

**Teto da atribuição:** se o lead agendou com número diferente do que entrou no Chatwoot, o match por telefone não casa — auditoria manual sempre acha mais. O número do dash é o **piso garantido**, não o teto.

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
