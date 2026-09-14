# 🤖 IA? COMECE POR AQUI — dash-clinics

> Se você é uma IA (ou dev) prestes a mexer neste repositório: **leia este documento inteiro
> antes de qualquer alteração.** Ele existe porque em 09–14/09/2026 uma série de deploys feitos
> por fora do git quebraram produção (SSO do embed e sync duplicado). As regras abaixo evitam
> que isso se repita.

---

## ⛔ REGRAS DE OURO (não negociáveis)

1. **NUNCA faça deploy pra produção por fora do git.** Nada de `wrangler pages deploy` de clone
   local direto pro ar. **Todo código passa pelo GitHub primeiro.** Produção sai do `main`.
2. **`main` == produção.** Um `push`/merge no `main` dispara o GitHub Actions
   (`.github/workflows/deploy.yml`) que faz o deploy automático no Cloudflare Pages. É assim que
   a Cloudflare recebe o código — não por upload manual.
3. **Fluxo de mudança:** branch de feature → PR → validar em **homologação** (branch `homolog`
   → `https://homolog.dash-clinics.pages.dev`) → merge no `main` → deploy automático em produção
   (`https://dash-clinics.pages.dev`).
4. **O SYNC roda na VPS (EasyPanel), NÃO na Cloudflare.** Não recrie/religue workers de sync na
   Cloudflare. Fonte autoritativa = repo `Forux-Digital/dash-sync-jobs`.
5. **Tabelas READ-ONLY no Supabase:** `unitConfigs`, `actions_mc`, `workflows_and_machines` — só
   `SELECT`, nunca escrever.
6. **`public/login.html` PRECISA da linha `<script src="/gci-sso.js"></script>`** no `<head>` —
   é o que faz o SSO do embed no hub GCI funcionar. Sem ela, quem entra pelo GCI cai na tela de
   login. (Foi o bug de 10–14/09.)
7. **O backend de dados são RPCs no Supabase** (`funnel_stats`, `dashboard_stats`, etc.), editados
   no banco e versionados em `db/functions/`. Mudar a lógica de números = mudar a RPC, não o front.
8. **Deploy manual só em EMERGÊNCIA**, e mesmo assim a partir do `main` limpo:
   `wrangler pages deploy public --project-name=dash-clinics --branch=main --commit-hash=<sha do main>`.
   Antes, **diffe TODOS os arquivos servidos contra o ar** (o CF serve cada deploy em
   `https://<hash>.dash-clinics.pages.dev/` — dá pra `curl` e comparar `index.html`, `login.html`,
   `gci-sso.js`, etc.). Produção já esteve À FRENTE do git no passado; não confie que a branch == ar.

---

## O que é o produto

**dash-clinics** é o **Dashboard de Clínicas** (S-Pragel / Ecuro): KPIs, funil de marketing,
financeiro e auditoria das ~37 clínicas. É acessado de 2 formas:

- **Direto:** `https://dash-clinics.pages.dev` (login com e-mail + senha do Chatwoot).
- **Embedado no hub GCI:** `https://gci.arvore.party/dash` — um iframe do dash dentro do hub, com
  **SSO** (o hub passa a credencial do Chatwoot já logada; o dash troca por sessão sem pedir senha).

## Arquitetura (atual, 09/2026)

```
   Navegador (direto)          Hub GCI (gci.arvore.party) --- iframe --->  dash embed
        │                                                                      │
        └──────────────► Cloudflare Pages  «dash-clinics»  ◄────────────────┘
                          ├─ public/            SPA estático (index.html, login.html, gci-sso.js)
                          └─ functions/api/*    Pages Functions (login, sso, me, logout,
                                                dashboard/*, data/*  — auth + proxy p/ Supabase)
                                   │  service_role (secret)
                                   ▼
                          Supabase  (ref reeuuxkeqosiyjntyzma)
                          ├─ "BI Appointments" / appointment_logs / "BI Payments"
                          ├─ chatwoot_leads / campaign_contacts_cache
                          ├─ auth_users / auth_sessions
                          ├─ dashboard_daily_rollup   (pré-cálculo p/ o caminho rápido)
                          ├─ unitConfigs / actions_mc / workflows  (READ-ONLY)
                          └─ RPCs: funnel_stats(→v6), dashboard_stats(→precomputed→fast→live),
                                   refresh_rollup_and_precompute (cron noturno pg_cron)
                                   ▲
                                   │  upsert incremental (service_role)
                          VPS / EasyPanel  «dash-sync-jobs»  (Forux-Digital/dash-sync-jobs)
                          host: dash-sync-jobs.5ef4kt.easypanel.host
                          crons: syncEcuroIncremental 0 4 · syncEcuroBootstrap 0 22 ·
                                 syncCwLeadsIncremental 0 3 · syncCwLeadsFull 0 6(sáb) · healthCheck 7 7
                          → puxa dados do Ecuro (BI) + leads do Chatwoot e joga no Supabase.
```

**Três camadas, três repositórios/lugares:**
| Camada | Onde vive | Como faz deploy |
|---|---|---|
| Frontend + APIs de auth | Cloudflare Pages `dash-clinics` (este repo, `Fhelyp/dash-clinics`) | git → `main` → Actions |
| Lógica de números (funil, KPIs, rollup) | RPCs no Supabase | editar no banco; versionar em `db/functions/` |
| Sync (Ecuro/Chatwoot → Supabase) | VPS EasyPanel (`Forux-Digital/dash-sync-jobs`) | deploy no EasyPanel |

## Pipeline de produção (o coração da governança)

- **`.github/workflows/deploy.yml`** — dispara no `push` pro `main`. Roda `cloudflare/wrangler-action`
  → `pages deploy public --project-name=dash-clinics --branch=main`. Token no secret do repo
  `CLOUDFLARE_API_TOKEN`. **É o único caminho de deploy de produção.**
- **`.github/workflows/deploy-homolog.yml`** — dispara no `push` pra branch `homolog`. Deploya em
  `https://homolog.dash-clinics.pages.dev` (branch alias / preview) pra validar antes de prod.
- ⚠️ O projeto Pages é **Direct Upload** (não é git-connected nativo — o Cloudflare não deixa
  converter, erro 8000069). Por isso o auto-deploy é via **GitHub Actions**, não pela integração
  git nativa do Pages. Efeito é o mesmo: push no main → deploy.

### Como fazer uma mudança (passo a passo)
1. `git checkout main && git pull` (sempre parta do main atualizado).
2. Crie uma branch: `git checkout -b feat/minha-melhoria`.
3. Faça a mudança. Rode `node --check` no JS que mexeu (o `index.html` tem JS grande).
4. Pra validar em homolog: `git push origin feat/minha-melhoria:homolog` (ou abra PR pra `homolog`).
   Veja em `https://homolog.dash-clinics.pages.dev`.
5. Validado: abra PR da sua branch pro `main`, revise o diff, faça merge.
6. O merge no `main` deploya sozinho em produção. Confira em `https://dash-clinics.pages.dev`.
7. Se a mudança for na LÓGICA de números, edite a RPC no Supabase e **versione** o SQL em
   `db/functions/`.

## Subsistemas & armadilhas conhecidas (leia antes de mexer)

- **SSO do embed** → `docs`/[regra 6]. `public/gci-sso.js` (carregado pelo `login.html`) recebe a
  credencial via `postMessage` do hub, chama `POST /api/sso`, guarda token em `localStorage`
  (`dc_embed_token`) e recarrega. `functions/api/sso.js` valida no Chatwoot e emite JWT com cookie
  `SameSite=None; Partitioned` (CHIPS) **e** token no corpo (fallback Bearer p/ Safari). O
  `functions/_middleware.js` aceita **cookie OU `Authorization: Bearer`**. Se o embed "loga e
  desloga", suspeite (nesta ordem): script `gci-sso.js` não carregado no login.html; cookie de 3º
  bloqueado + Bearer não injetado; JWT_SECRET divergente.
- **Rollup / caminho rápido** → `db/ROLLUP_CRON.md`. `dashboard_stats` usa
  `_precomputed`→`_fast`(lê `dashboard_daily_rollup`)→`_live`(verdade, lento). Um cron pg_cron
  (`rollup-precompute-nightly`, 0 9 UTC) refaz o rollup. **Gotcha:** `SET statement_timeout` DENTRO
  de função é no-op (o timer é armado antes de entrar) — cron pesado tem que pôr o `SET` no COMANDO
  do cron. Se o dash "carrega pra sempre" em datas recentes, cheque se o rollup congelou.
- **Funil** → `db/functions/funnel_stats_v6.sql` (em prod). Conta pela data do agendamento; exclui
  passante por PACIENTE; Confirmados usa a base ELEGÍVEL (mesma de agendados/compareceram).
- **Schema drift do Ecuro** → `db/SYNC_SCHEMA_DRIFT.md`. O Ecuro pode ADICIONAR campos; o sync da
  VPS filtra colunas desconhecidas pra não derrubar o feed.
- **RBAC/permissionamento** → `functions/api/login.js` e `sso.js`. Fonte de verdade = Chatwoot
  (admin de conta → clínicas daquela conta ao vivo). Overrides: `unrestricted` > `regional` >
  `allowed_clinic_ids` explícito. NÃO reexpandir acesso sem pedido.
- **Filtro por Regional** (chips "Regional <Líder>" no filtro de Unidade): mapa por `clinic_id` no
  `public/index.html` (constante `REGIONAIS`), porque o banco não tem mapa gerente→unidades.

## Mapa do repositório

```
public/            SPA servido (index.html = dashboard, login.html, gci-sso.js, favicon…)
functions/
  _middleware.js   guard de auth (cookie OU Bearer; PUBLIC_PATHS)
  _lib/            auth.js (JWT), supabase.js (service_role)
  api/             login, sso, me, logout, change-password, sso
  api/dashboard/   stats, funnel, funnel-detail, funnel-resgate*, lookups, appointments, audit-events
  api/data/[[path]].js   proxy REST read-only p/ Supabase (usado pelo cache de campanha)
db/
  functions/       SQL versionado das RPCs (fonte de verdade dos números)
  ROLLUP_CRON.md   runbook do rollup/cron + incidentes
  SYNC_SCHEMA_DRIFT.md
workers/           ⚠️ LEGADO — workers CF de sync. NÃO usar: o sync é na VPS. Ver "Sync".
.github/workflows/ deploy.yml (prod) + deploy-homolog.yml (homolog)
docs/              este arquivo, BUSINESS_RULES.md, HANDOFF.md, ...
wrangler.toml      config do Pages (output=public; vars não-secretas)
```

## Sync — estado (14/09/2026)

- **Autoritativo = VPS EasyPanel** (`Forux-Digital/dash-sync-jobs`). Saudável: sync-ecuro e
  sync-cw-leads completam 37/37 clínicas/dia, 0 erros. Status: `GET dash-sync-jobs.5ef4kt.easypanel.host/status`.
- Os **workers Cloudflare de sync foram descomissionados** por serem duplicados:
  `dash-clinics-sync-cw-leads` e `dash-clinics-health-check-sync` **deletados**;
  `dash-clinics-sync-ecuro` com **cron desligado** (dormente, será deletado).
  Os jobs de deploy desses workers foram removidos do `deploy.yml` (eles re-armavam os crons).
- **Pendência:** `dash-clinics-sync-chatwoot` (agrega `campaign_contacts_cache` — usado pelo
  contador de leads das "Métricas Thauany", com fallback) ainda NÃO existe na VPS. Migrar essa
  agregação pro `dash-sync-jobs` e então deletar o worker CF. É o único sync que falta migrar.
- Os workers `gci-chatwoot-proxy` / `gci-ecuro-proxy` (sem cron, proxies sob demanda) e
  `mc-farol-collector` (produto Farol) **não são deste produto** — não mexer.

## Infra & URLs

- Frontend prod: `https://dash-clinics.pages.dev` · homolog: `https://homolog.dash-clinics.pages.dev`
- Hub que embeda: `https://gci.arvore.party/dash`
- Cloudflare account: `de356bf3b5b6db75835e33e84876eefb` · projeto Pages `dash-clinics` (Direct Upload)
- Supabase ref: `reeuuxkeqosiyjntyzma` (PRODUÇÃO — cuidado)
- VPS sync: `https://dash-sync-jobs.5ef4kt.easypanel.host` (`/status`, `/logs/<job>`)
- Secrets: no Cloudflare Pages (JWT_SECRET, SUPABASE_SERVICE_ROLE) e no repo (`CLOUDFLARE_API_TOKEN`
  p/ o Actions). Nunca commitar secret.

## Registro do incidente 09–14/09/2026 (pra não repetir)
1. Deploy manual de branch subiu `login.html` sem `<script gci-sso.js>` → SSO do embed quebrou.
   Fix: restaurada a linha; deploy pelo `main`.
2. Reescrita da função do rollup fez o cron estourar o `statement_timeout` de 120s → rollup
   congelou → dash "carregando" em datas recentes. Fix: `SET` no comando do cron.
3. Workers CF de sync re-armados pelo pipeline → risco de sync dobrado. Fix: sync consolidado na VPS,
   workers CF desligados/deletados, jobs removidos do `deploy.yml`.
**Causa comum:** deploy por fora do git, sem diff revisável. Daí estas regras.
