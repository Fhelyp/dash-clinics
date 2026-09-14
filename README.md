# dash-clinics

Dashboard de Clínicas (S-Pragel / Ecuro): KPIs, funil de marketing, financeiro e auditoria.
Acessado direto (`dash-clinics.pages.dev`) e embedado no hub GCI (`gci.arvore.party/dash`) via SSO.

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
  └─ functions/api/*  Pages Functions (login, sso, me, dashboard/*, data/*)
        │  service_role (secret)
        ▼
Supabase (ref reeuuxkeqosiyjntyzma)
  ├─ BI Appointments / Logs / Payments · chatwoot_leads · campaign_contacts_cache
  ├─ auth_users / auth_sessions · dashboard_daily_rollup
  ├─ unitConfigs / actions_mc / workflows  (READ-ONLY)
  └─ RPCs: funnel_stats(→v6), dashboard_stats(→precomputed→fast→live), refresh_rollup_and_precompute
        ▲  upsert incremental (service_role)
        │
VPS / EasyPanel «dash-sync-jobs» (Forux-Digital/dash-sync-jobs)  ← FONTE DO SYNC
  crons: syncEcuroIncremental 0 4 · syncEcuroBootstrap 0 22 · syncCwLeadsIncremental 0 3 ·
         syncCwLeadsFull 0 6(sáb) · healthCheck 7 7 — status: /status
```

> ⚠️ Os workers Cloudflare em `workers/` são **LEGADO** (o sync foi consolidado na VPS). Não
> religar/recriar workers de sync na Cloudflare. Ver `docs/AI_START_HERE.md` › "Sync".

## Deploy (git → produção)

- **Produção:** merge/push no `main` → `.github/workflows/deploy.yml` → `wrangler pages deploy`
  automático em `https://dash-clinics.pages.dev`. Token no secret do repo `CLOUDFLARE_API_TOKEN`.
- **Homologação:** push na branch `homolog` → `.github/workflows/deploy-homolog.yml` →
  `https://homolog.dash-clinics.pages.dev`. Valide ali antes de mergear no `main`.
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
