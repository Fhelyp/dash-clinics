# Hand-off — Dashboard de Clínicas

> **Última atualização:** rodada da tarde 29/abr — bug do dashboard zerado corrigido,
> filtros rápidos adicionados, métricas Thauany respondendo ao filtro, sync das 32
> clínicas rodando com throttle (5s/req, 60s/clínica) pra não comprometer a Maria Clara.



## ✅ O que está NO AR e funcionando

- **URL:** https://dash-clinics.pages.dev
- **Repo:** https://github.com/Fhelyp/dash-clinics
- **Login admin:** `fhelypg@gmail.com` / `0FueYs1FA64X` ← **TROQUE essa senha** logo após o primeiro login (clique em "Sair" → fizemos must_change_password=false só pra testar; pra trocar, abra `/change-password.html` direto)

### Pipeline funcional ponta a ponta:

1. **Auth completa**: PBKDF2 100k iter + JWT HS256 + cookie HttpOnly/Secure/SameSite=Lax + sessões em `auth_sessions`
2. **Proxy seguro de dados**: `/api/data/<table>` com allowlist (somente `BI Appointments`, `BI Appointment Logs`, `BI Payments`, `campaign_contacts_cache`, `sync_state`)
3. **Dashboard**: 300 agendamentos / 1502 logs / 150 pagamentos / 241 pacientes carregam corretamente
4. **Switch 3-estados** (Todos/Maria Clara/Operadores) ✅
5. **Botão de ficha do paciente** abre `https://ecuro.com.br/dashboard/patient-profile/{id}?activeTab=appointments` em nova aba ✅
6. **Métricas Thauany** (KPIs Campanha + Origem Pacientes + 1ª Consulta vs Follow-Up) calculadas no client com regras explícitas

### Service role
- A `service_role` antiga continua aplicada como secret no Cloudflare Pages (`SUPABASE_SERVICE_ROLE`).
- Quando você rotacionar a key no Supabase, basta:
  ```
  wrangler pages secret put SUPABASE_SERVICE_ROLE --project-name=dash-clinics
  ```
  (ou pelo painel Cloudflare Pages → Settings → Environment variables)

---

## 🚧 O que falta para 100%

### 1. Header de auth da API Ecuro (BLOQUEADOR do worker de sync)

Testei 17 variações de header (`apiKey`, `Authorization Bearer`, `x-api-key`, query param, etc.) — **todas retornam `401 "No token provided"`**. A mensagem é típica de middleware `express-jwt` que espera um JWT, mas a string que você me passou (255 chars) não tem formato JWT.

**O que preciso de você:** abrir o n8n que já está sincronizando hoje, ver o nó HTTP que chama a API Ecuro, e me mandar print/copia de **como o header está sendo enviado**.

Quando me passar, eu só:
```bash
wrangler secret put ECURO_API_KEY --config workers/sync-ecuro/wrangler.toml
# editar wrangler.toml var ECURO_AUTH_HEADER se for outro nome
wrangler deploy --config workers/sync-ecuro/wrangler.toml
# depois disparo backfill abril/2026 manualmente:
curl -X POST "https://dash-clinics-sync-ecuro.<SEU-SUBDOMAIN>.workers.dev/backfill?startDate=2026-04-01&endDate=2026-04-29" -H "x-admin-token: <ADMIN_TOKEN>"
```

### 2. Token Cloudflare precisa de mais 1 permissão pra deploy de Workers

O token `cfut_pm8pU…` que você me passou tem permissões de **Pages** (deu certo) mas **falta** `User → User Details → Read` que o wrangler usa pra deploy de Workers.

**Solução:** vai em https://dash.cloudflare.com/profile/api-tokens, edita o token e adiciona:
- ✅ User → User Details → **Read**
- ✅ Account → Workers Scripts → **Edit**
- ✅ Account → Workers Tail → **Read** (opcional, pra ver logs)

Aí me mande o token atualizado e eu deployo os 2 workers (`sync-ecuro` e `sync-chatwoot`).

### 3. Auto-deploy do GitHub → Cloudflare Pages

Hoje o deploy é **direct upload** (eu rodo `wrangler pages deploy` localmente). Pra ligar **auto-deploy a cada push em `main`**:

1. Vai em https://dash.cloudflare.com/?to=/:account/pages/view/dash-clinics/settings
2. Em "Builds & deployments" → **Connect to Git** → autoriza o app Cloudflare no GitHub e seleciona o repo `Fhelyp/dash-clinics`
3. Branch: `main`, Build command: vazio, Output dir: `public`

Isso é OAuth — não dá pra fazer via API. Leva 30 segundos no painel.

---

## 🔐 Secrets atualmente cadastrados no Pages

| Secret | Valor |
|---|---|
| `SUPABASE_URL` | `https://reeuuxkeqosiyjntyzma.supabase.co` (plain) |
| `SUPABASE_SERVICE_ROLE` | service_role atual (secret) — **rotacione** |
| `JWT_SECRET` | 64 bytes hex aleatórios (secret) — guardado em `/tmp/jwt_secret.txt` no meu sandbox; se precisar do valor pra alguma reinstalação, gera novo: `openssl rand -hex 64` |
| `JWT_ISSUER` | `dash-clinics` (plain) |
| `JWT_TTL_HOURS` | `12` (plain) |
| `PATIENT_PROFILE_BASE` | `https://ecuro.com.br/dashboard/patient-profile` (plain) |

---

## 📋 Tabelas criadas no Supabase

```
auth_users              (1 linha — fhelypg@gmail.com como admin)
auth_sessions           (sessões JWT ativas, com revogação)
sync_state              (vazia até worker rodar)
campaign_contacts_cache (vazia até worker chatwoot rodar)
```

Todas com RLS habilitado e SEM policy = bloqueia anon. Service role bypassa.

---

## 🧪 Resumo dos testes que rodei

```
[OK] curl /api/login com senha errada       → 401 invalid_credentials
[OK] curl /api/login com senha correta      → 200 + cookie HttpOnly Secure
[OK] curl /api/me                            → 200 user info
[OK] curl /api/logout                        → 200 + cookie limpo, sessão revogada
[OK] curl /api/change-password senha errada  → 401 invalid_old_password
[OK] curl /api/change-password senha curta   → 400 weak_password
[OK] curl /api/data/BI Appointments          → 200 + dados
[OK] curl /api/data/BI Appointment Logs      → 200 + dados
[OK] curl /api/data/BI Payments              → 200 + dados
[OK] curl /api/data/unitConfigs              → 403 table_not_allowed
[OK] curl /api/data sem auth                  → 401 unauthorized
[OK] Browser: login → /change-password se must_change_password=true
[OK] Browser: dashboard carrega 300 agend, R$38k receita, 241 pacientes
[OK] Browser: switch ALL/MC/OP alterna corretamente
[OK] Browser: botão ficha do paciente abre URL Ecuro em nova aba
[OK] Browser: botão Sair desloga e redireciona pra /login
```

---

## 📌 Próximos passos (depois você me responde)

1. Me passe o header correto da API Ecuro
2. Adicione as permissões de Workers no token Cloudflare e mande o novo token
3. Conecte o repo GitHub no painel Pages pra ter auto-deploy
4. Rotacione a service_role do Supabase quando achar bom

Quando 1 + 2 estiverem feitos eu termino:
- Deploy dos 2 workers
- Backfill abril/2026 (todas as 32 clínicas)
- Configurar `ADMIN_TOKEN` para os endpoints manuais
- Validar agregação Chatwoot rodando
