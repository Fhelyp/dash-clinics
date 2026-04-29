# dash-clinics

Dashboard S-Pragel/Ecuro com autenticação e sincronização cron → Supabase.

## Arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Pages (dash-clinics)                             │
│   ├─ /public            → SPA estático (login + dashboard)   │
│   └─ /functions/api/*   → Pages Functions (auth + proxy)     │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼  service_role (secret)
┌──────────────────────────────────────────────────────────────┐
│  Supabase (Maria Clara DB)                                   │
│   ├─ BI Appointments / Logs / Payments  (sync alvo)          │
│   ├─ auth_users / auth_sessions         (login do dash)      │
│   ├─ sync_state / campaign_contacts_cache                    │
│   └─ unitConfigs / actions_mc / workflows  (READ-ONLY)       │
└──────────────────────────────────────────────────────────────┘
                          ▲
                          │
┌──────────────────────────┴───────────────────────────────────┐
│  Cloudflare Workers (cron triggers)                          │
│   ├─ sync-ecuro      → diário 04:00 BRT, incremental         │
│   └─ sync-chatwoot   → de hora em hora, contagem campanhas   │
└──────────────────────────────────────────────────────────────┘
```

## Setup local

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha os secrets locais
npm run dev                       # http://localhost:8788
```

## Secrets necessários (Cloudflare Pages)

Cadastrar via dashboard ou CLI:

```bash
wrangler pages secret put SUPABASE_SERVICE_ROLE --project-name=dash-clinics
wrangler pages secret put JWT_SECRET             --project-name=dash-clinics
```

Para o worker `sync-ecuro`:

```bash
wrangler secret put SUPABASE_SERVICE_ROLE --config workers/sync-ecuro/wrangler.toml
wrangler secret put ECURO_API_KEY         --config workers/sync-ecuro/wrangler.toml
```

Para o worker `sync-chatwoot`:

```bash
wrangler secret put SUPABASE_SERVICE_ROLE --config workers/sync-chatwoot/wrangler.toml
wrangler secret put CHATWOOT_API_TOKEN    --config workers/sync-chatwoot/wrangler.toml
```

## Cadastrar primeiro usuário admin

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... \
node scripts/seed-admin.mjs you@example.com SenhaForte123
```

## Deploy

Conecta o repo `Fhelyp/dash-clinics` no painel do Cloudflare Pages
(Build settings: command vazio, output `public`). Cada push em `main` faz deploy.

Workers:

```bash
npm run worker:sync-ecuro:deploy
npm run worker:sync-chatwoot:deploy
```

## Tabelas READ-ONLY no Supabase

⚠️ **Nunca editar:** `actions_mc`, `unitConfigs`, `workflows_and_machines`.
Essas pertencem ao projeto Maria Clara — só consulta.
