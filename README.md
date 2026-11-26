# dash-clinics

Dashboard de Clínicas (S-Pragel / Ecuro): KPIs, funil de marketing, ações do CRC, financeiro e
auditoria. **Número oficial da gerência desde 05/11/2026.** Acessado direto (`dash-clinics.pages.dev`)
e embedado no hub GCI (`gci.arvore.party/dash`) via SSO.

## Documentação

| Para | Leia |
|---|---|
| Entender o produto, quem usa e de onde vêm os dados | [docs/contexto/PRODUTO.md](docs/contexto/PRODUTO.md) |
| Saber para onde vai e o que está na fila | [ROADMAP](docs/contexto/ROADMAP.md) · [BACKLOG](docs/contexto/BACKLOG.md) |
| Operar: jobs da madrugada, alertas, checagem de saúde | [docs/contexto/OPERACAO.md](docs/contexto/OPERACAO.md) |
| Mudar algo e levar para produção | [docs/contexto/PROCESSO_DEPLOY.md](docs/contexto/PROCESSO_DEPLOY.md) |
| As regras de negócio | [DECISOES 27/10](docs/DECISOES_2026-10-27.md) · [DECISOES 05/11](docs/DECISOES_2026-11-05.md) · [BUSINESS_RULES](docs/BUSINESS_RULES.md) |
| Reuniões (contexto, decisões, próximos passos) | [docs/reunioes/](docs/reunioes/README.md) |
| Casos reportados e o que mudou | [docs/suporte/CASOS.md](docs/suporte/CASOS.md) |

> ⚠️ Este repositório é **público**. Nada de credencial, nome de paciente ou transcrição aqui:
> transcrições e casos completos ficam em `docs/_privado/` (fora do git). `npm test` reprova segredo
> versionado.

> ## 🤖 IA / DEV — COMECE POR AQUI
> **Antes de mexer, leia [`CLAUDE.md`](CLAUDE.md) e [`docs/AI_START_HERE.md`](docs/AI_START_HERE.md).**
> Regra nº1: **nunca faça deploy por fora do git.** `main` == produção; push no `main` deploya
> automático (GitHub Actions). O SYNC roda na **VPS (EasyPanel)**, não na Cloudflare.

## Arquitetura (resumo — completo em `docs/AI_START_HERE.md`)

```
Navegador / Hub GCI (iframe)
        │
        ▼
Cloudflare Pages «dash-clinics»
  ├─ public/          SPA estático (index.html, login.html, gci-sso.js)
  └─ functions/api/*  Pages Functions (login, sso, me, lookups, dashboard/*) + RBAC no _middleware
        │  service_role (secret)
        ▼
Supabase (ref reeuuxkeqosiyjntyzma)
  ├─ BI Appointments / Logs / Payments · chatwoot_leads · campaign_appt_attribution
  ├─ auth_users / auth_sessions · dashboard_daily_rollup
  ├─ unitConfigs / actions_mc / workflows  (READ-ONLY)
  └─ RPCs: funnel_v7_* (funil; v6 = rollback), crc_acoes_* (ações do CRC),
           dashboard_stats (→ rollup → live), rollup noturno no pg_cron
        ▲  upsert incremental (service_role)
        │
VPS / EasyPanel «dash-sync-jobs» (Forux-Digital/dash-sync-jobs)  ← FONTE DO SYNC
  crons (BRT): sync-cw-leads 03h · sync-ecuro incremental 04h (+ atribuição) · validate-counts 05h25 ·
               health-check 07h07 · full/reconcile aos sábados — status: /status (ver docs/contexto/OPERACAO.md)
```

> ⚠️ Os workers Cloudflare em `workers/` são **LEGADO** (o sync foi consolidado na VPS). Não
> religar/recriar workers de sync na Cloudflare. Ver `docs/AI_START_HERE.md` › "Sync".

## Deploy (git → produção)

Passo a passo completo: [docs/contexto/PROCESSO_DEPLOY.md](docs/contexto/PROCESSO_DEPLOY.md).

- **CI:** todo PR roda `npm test` (workflow `ci.yml`); os dois deploys só acontecem com os testes verdes.
- **Homologação:** Actions › *Deploy Homolog (preview)* › *Run workflow* na branch, ou push na branch
  `homolog` → `https://homolog.dash-clinics.pages.dev`. Valide ali antes de pedir a promoção.
- **Produção (promoção, só com autorização):** merge no `main` → `deploy.yml` → testes → deploy em
  `https://dash-clinics.pages.dev` → conferência no ar → **tag e release `vAAAA.MM.DD.N`**.
  Token no secret do repo `CLOUDFLARE_API_TOKEN`.
- **Emergência (raro):** `wrangler pages deploy public --project-name=dash-clinics --branch=main
  --commit-hash=<sha do main>` — do `main` limpo, e **diffando os arquivos servidos vs o ar** antes.
  Nunca de clone local sujo.

## Setup local

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha os secrets locais
npm run dev                       # http://localhost:8788
```

## Secrets (Cloudflare Pages)

```bash
wrangler pages secret put SUPABASE_SERVICE_ROLE --project-name=dash-clinics
wrangler pages secret put JWT_SECRET             --project-name=dash-clinics
```
(O secret do GitHub Actions `CLOUDFLARE_API_TOKEN` já está configurado no repo.)

## Números do dashboard = RPCs no Supabase

A lógica de funil/KPIs vive em RPCs no Supabase, versionadas em `db/functions/`. Para mudar um
número, edite a RPC no banco e atualize o `.sql` correspondente. Ver `db/ROLLUP_CRON.md` (rollup/cron)
e `db/SYNC_SCHEMA_DRIFT.md`.

## Tabelas READ-ONLY no Supabase

⚠️ **Nunca editar:** `actions_mc`, `unitConfigs`, `workflows_and_machines` — pertencem ao projeto
Maria Clara, só consulta.
