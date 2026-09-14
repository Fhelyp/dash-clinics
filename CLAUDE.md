# 🤖 IA / DEV — COMECE POR AQUI

**Antes de qualquer alteração, leia [`docs/AI_START_HERE.md`](docs/AI_START_HERE.md).** Ele explica
a arquitetura, o pipeline de produção e as armadilhas que já quebraram o ar.

## Regras de ouro (resumo — detalhe no doc acima)
1. **NUNCA deploy por fora do git.** Nada de `wrangler pages deploy` de clone local pro ar.
2. **`main` == produção.** Push/merge no `main` → GitHub Actions (`deploy.yml`) → deploy automático.
3. **Fluxo:** branch → PR → validar em `homolog` (`homolog.dash-clinics.pages.dev`) → merge no `main`.
4. **Sync roda na VPS (EasyPanel / `Forux-Digital/dash-sync-jobs`), NÃO na Cloudflare.**
5. **READ-ONLY no Supabase:** `unitConfigs`, `actions_mc`, `workflows_and_machines` (só SELECT).
6. **`public/login.html` precisa de `<script src="/gci-sso.js"></script>`** (SSO do embed GCI).
7. **Números = RPCs no Supabase** (`funnel_stats`, `dashboard_stats`), versionadas em `db/functions/`.
8. Deploy manual só em emergência, do `main` limpo, e **diffando os arquivos servidos vs o ar** antes.

Camadas: **Cloudflare Pages** (front + APIs de auth, este repo) · **Supabase** (dados + RPCs) ·
**VPS EasyPanel** (sync Ecuro/Chatwoot → Supabase). URLs e detalhes no doc.
