# Operação: runbook do Dash Clínicas

Como saber se está tudo no ar, o que cada alerta quer dizer e o que fazer. Credenciais **nunca** neste
repo (ele é público): ficam no README do `dash-sync-jobs` (privado) e nos secrets da Cloudflare/GitHub.

## Onde olhar

| O quê | Onde |
|---|---|
| Dash em produção | `https://dash-clinics.pages.dev` (e embed `gci.arvore.party/dash`) |
| Homologação | `https://homolog.dash-clinics.pages.dev` |
| Sync (VPS) | `https://dash-sync-jobs.5ef4kt.easypanel.host/status`: versão (`GIT_SHA`), último resultado de cada job |
| Deploys do front | GitHub Actions do `Fhelyp/dash-clinics` + releases (uma tag por promoção) |
| Banco | Supabase (plano básico), projeto `reeuuxkeqosiyjntyzma`; SQL Editor ou pooler |
| Alertas | ntfy (tópico em `NTFY_TOPIC` na VPS) |

## Agenda da madrugada (horário de Brasília)

| Hora | Job | Onde | O que faz |
|---|---|---|---|
| a cada 2h | `ecuro-probe` | VPS | Mede se o Ecuro está bloqueando `/bi/appointment-logs` (cota) |
| 03:00 | `sync-cw-leads` | VPS | Leads e etiquetas do Chatwoot (~45 min, 37 unidades); grava a hora exata do anúncio |
| 04:00 | `sync-ecuro-incremental` → `refresh-attribution` | VPS | Agendamentos/logs/pagamentos de ontem; depois a atribuição de campanha |
| 05:25 | `validate-counts` | VPS | Compara Ecuro × Supabase dia a dia, **só dias que o sync já trouxe** |
| 06:00 | `rollup-precompute-nightly` | pg_cron (09:00 UTC) | Refaz o rollup diário da janela recente (~4 min) |
| 07:07 | `health-check` | VPS | Unidades defasadas (> 2 dias sem dado) |
| sáb 06:00 | `sync-cw-leads-full` | VPS | Varredura completa das etiquetas |
| sáb 06:30 | `reconcile-weekly` | VPS | Reconciliação semanal |
| dom 02:00 | `rollup-old-months-weekly` | pg_cron (05:00 UTC) | Refaz os meses antigos do rollup |

Desligados de propósito: bootstrap das 22h (estourava a cota do Ecuro), `sync-chatwoot-agg` (cache sem
uso, desde 24/11/2026), `cleanup-old-data` (o histórico é necessário). Todos seguem disponíveis
manualmente em `POST /run/<job>` com o `x-admin-token` (README do `dash-sync-jobs`).

## Alertas: o que quer dizer e o que fazer

| Alerta | Significado | Ação |
|---|---|---|
| `dash-sync-jobs UP` | O container da VPS (re)iniciou: deploy ou queda | Esperado depois de deploy. Se não houve deploy, abrir `/status` e ver se algum job estava rodando |
| `sync-ecuro ... ERROR` + "Cloud acionado" | Falha crítica no sync; a VPS acionou uma Routine do Claude Code para investigar | Ler o resumo da sessão; conferir `/status` e `/logs`. A Routine só fala com GitHub e conectores (não alcança a VPS) |
| `validate-counts: N diffs` | Diferença entre Ecuro e Supabase em algum dia | Poucas e pequenas (±1): ruído de edição no Ecuro, some no próximo sync. Muitas no mesmo dia: rodar `sync-ecuro-bootstrap` só daquela janela, fora do horário comercial |
| `cadastro_invalido` | Unidade com ID do Ecuro inválido na configuração (ex.: Campos do Jordão, ID com "h") | Não é falha do sync. Corrigir o cadastro em `unitConfigs`, que é **read-only para nós**: pedir a quem mantém a Maria Clara |
| Ecuro `400 "tente amanhã"` | Cota do Ecuro em `/bi/appointment-logs` | O sync tenta de novo em 1, 4 e 10 min; se persistir, entra no dia seguinte. Dono do Ecuro: Alex |
| `health-check: unidades defasadas` | Unidade sem dado há mais de 2 dias | Ver se é `Dash=false` (esperado), cadastro inválido ou falha real do sync daquela unidade |

### Falso alarme conhecido (24/11/2026)

Rodar `validate-counts` à mão **antes** do sync do dia comparava um dia que ainda não tinha sido
trazido (71 diffs). Corrigido no `dash-sync-jobs` (#23): o job só valida até o último dia que o
`sync-ecuro` concluiu. Se for rodar à mão, rode depois das 05h.

## Checagem de saúde (5 minutos)

1. `/status` da VPS: último `sync-ecuro` e `sync-cw-leads` com `ok`, versão esperada.
2. Supabase, `cron.job_run_details`: as duas últimas execuções do rollup com `succeeded`.
3. Frescor: toda unidade com `Dash=true` tem agendamento até D-1 (exceto cadastro inválido).
4. `curl -s https://dash-clinics.pages.dev/login.html | grep gci-sso.js`: sem isso o embed cai no
   login (incidente 10–14/09). O deploy de produção já confere sozinho.
5. `python tests/sql/drift_funcoes.py`: funções do repo == banco.

## Cuidados com o banco (plano básico)

- Consultas pesadas só fora do horário comercial e com janela curta (um mês, uma rede).
- `SET statement_timeout` **dentro** de função não vale: vai no comando do cron, antes do `SELECT`.
- Função `LANGUAGE sql` com `SET` cai em plano genérico lento: usar `plpgsql` + `RETURN QUERY EXECUTE`.
- Mudança de assinatura de RPC: `DROP FUNCTION IF EXISTS` + `CREATE` na **mesma transação** e depois
  `NOTIFY pgrst, 'reload schema'`.
- Tabelas da Maria Clara (`unitConfigs`, `actions_mc`, `workflows_and_machines`): **só SELECT**.
- Chatwoot: só leitura (API e Postgres). Nada de escrever em contato, conversa ou etiqueta.

## Incidentes registrados

- 09–14/09/2026: deploy sem `gci-sso.js` derrubou o SSO do embed. Ver [AI_START_HERE](../AI_START_HERE.md).
- 11–14/09/2026: rollup morria em 120 s (`statement_timeout` dentro da função).
- 24/11/2026: falso alarme do `validate-counts` (acima).
- Casos de suporte com causa e correção: [suporte/CASOS](../suporte/CASOS.md).
