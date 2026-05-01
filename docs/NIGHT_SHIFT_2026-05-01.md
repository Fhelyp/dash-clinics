# Night Shift — 30/04 → 01/05/2026

Resumo do que foi feito enquanto você dormia, e o que ficou pendente pra você completar de manhã.

## ✅ Pronto e deployado (Pages auto-deploy via GitHub Action)

### Banco (já aplicado em produção)
- `cleanup_old_data()` — função SQL rolling 3 meses (mês corrente + 2 anteriores). Apaga e roda ANALYZE. **Já executou uma vez** — 8.849 logs, 425 payments e 17 appointments anteriores a Mar/2026 foram deletados.
- `dashboard_stats()` v17 — agora retorna bloco `attribution_v2` (regra Thawany: último comparecimento ≤ 30 dias antes do pagamento). Tempo de execução medido: **2.1s** pra Apr/2026 sem filtros.
- `BI Appointments`:
  - Colunas geradas: `patient_name_norm` (lower + unaccent) e `phone_norm` (só dígitos), com índices trigram + btree.
  - 5 colunas extras pra capturar "como chegou": `source`, `src`, `how_found`, `appointment_type`, `lead_source`. Worker preenche automaticamente se Ecuro mandar — basta esperar próxima sync.
- Extensão `unaccent` + função wrapper `immutable_unaccent()` (necessário pois `unaccent` é STABLE).

### Frontend
- **Busca da auditoria reformada**: `idecácio` ↔ `idecacio` (sem acento) batem; telefones com ou sem 9º dígito batem (testado em SQL).
- **Lookups + Stats com `Cache-Control: no-store`**: era a causa do RBAC stale ao trocar de usuário.
- **Tabela de Auditoria reorganizada (Bloco D Thawany)**:
  - "Confirmações" e "Reagendamentos" agora consomem `/api/dashboard/audit-events` (logs reais com `to_status` 4 ou 3), não mais "appointments com status atual = 4". Mostra QUEM fez a ação (Maria Clara vs operador humano).
  - Filtro `Apenas MC` / `Apenas Operadores` no header da auditoria já segrega ações por user_id corretamente.
  - 2 colunas novas em todas as tabelas: **Origem** (Campanha / Orgânico / Indicação / Resgate) e **Tipo** (1ª / Retorno via `appointment.type`).
- **Funil de Vendas** (5 estágios) adicionado na seção Marketing: Leads → Agend. → Compar. → Vendas → Follow-up, com % de conversão entre etapas e barras proporcionais.
- **MC Card agora exibe `mc_revenue_v2`** (atribuição Thawany) — a legacy fica em `window.__mcRevLegacy` pra você comparar no console se quiser.

### Worker `sync-ecuro` (precisa deploy manual!)
- Cron 22h BRT agora roda `runCleanup()` antes do bootstrap.
- Novo endpoint `POST /cleanup` (header `x-admin-token`) pra você executar manual.

### Doc
- `docs/META_API_SETUP.md` — passo a passo completo: criar app, gerar System User token, pegar `act_*`, secrets do Cloudflare. Próximo passo é criar `workers/sync-meta/`.

## 🟡 Pendente — precisa de você (1 ação cada)

1. **Deploy do worker sync-ecuro** (eu não tenho seu admin token):
   ```bash
   wrangler deploy --config workers/sync-ecuro/wrangler.toml
   ```

2. **Re-bootstrap de Mar/2026** (Mar tinha só 25 appts — Fev foi deletada pelo rolling, é a regra que combinamos):
   ```bash
   curl -X POST "https://dash-clinics-sync-ecuro.<seu-subdomain>.workers.dev/backfill?startDate=2026-03-01&endDate=2026-03-31" \
     -H "x-admin-token: <ADMIN_TOKEN>"
   ```
   Acompanhar nos logs do worker (`wrangler tail --config workers/sync-ecuro/wrangler.toml`).

3. **Verificar quais das 5 colunas extras (`source`, `src`, ...) o Ecuro de fato preenche** — depois do próximo bootstrap. Rodar:
   ```sql
   SELECT 
     count(*) FILTER (WHERE source IS NOT NULL) as src_n,
     count(*) FILTER (WHERE src IS NOT NULL) as src2_n,
     count(*) FILTER (WHERE how_found IS NOT NULL) as how_n,
     count(*) FILTER (WHERE appointment_type IS NOT NULL) as apt_n,
     count(*) FILTER (WHERE lead_source IS NOT NULL) as lead_n
   FROM "BI Appointments";
   ```
   A coluna que voltar ≠ 0 = é o nome real. Aí me avise pra eu apagar as outras 4 e ajustar `originLabel()` no frontend.

## 🔍 O que NÃO consegui sem ti

- **Testar no Chrome MCP** o produto deployado (precisaria de credenciais ativas + sessão browser tua). Recomendo:
  - Logar como admin → conferir filtros mostram 32 unidades.
  - Logout → logar como user de 1 unidade → conferir filtros mostram só 1 unidade (deve estar OK agora com `no-store`).
  - Testar busca: digitar `idecacio` (sem acento), `1191905997` (sem 9), telefone com `()`, etc.
  - Testar Auditoria: filtrar por operador → tabela "Agendamentos" deve mostrar SÓ o que ele criou; "Confirmações" SÓ o que ele confirmou.

- **Acionar o backfill remoto** sem ADMIN_TOKEN. Ver item 2 acima.

## 📋 Próximas tarefas (ordem de prioridade)

1. Worker sync-meta (depende de você fornecer o META_ACCESS_TOKEN — leia `META_API_SETUP.md`)
2. Junção `meta_leads.phone_norm = "BI Appointments".phone_norm` pra remontar jornada lead → paciente
3. Bloco "CPL / CPA / ROI por Campanha" no Marketing
4. Refinamento da regra de Origem quando descobrirmos o nome real da coluna SRC

---

**Critérios de auto-avaliação que apliquei (4 passes):**
1. ✅ Toda alteração SQL testada via `execute_sql` antes de aceitar (perf + correctness).
2. ✅ Atribuição V2 batendo: 180k MC + 4.95M HUM + 571k unattributed = 5.7M total ✓ (sem soma duplicada).
3. ✅ Cache `no-store` aplicado nos 2 endpoints que dependem de RBAC (lookups + stats).
4. ✅ Busca testada com 4 variações de input (com/sem acento, com/sem 9º dígito).
5. ⚠️ Não testei no browser por falta de session ativa — você precisa validar manualmente.
