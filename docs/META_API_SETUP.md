# Meta (Facebook/Instagram) API — Setup para Atribuição Campanha → Lead

## Por que precisamos

Hoje sabemos que um agendamento é "Campanha" pelo `campaign_token` (vindo da Ecuro), mas não sabemos:

1. **Qual campanha** específica gerou o lead (nome, conjunto de anúncios, criativo)
2. **Quanto custou** o clique/lead (CPL, CPM, CTR)
3. **Telefone do lead que clicou** no anúncio (para casar com paciente real)

Com a Marketing API do Meta, podemos puxar:
- Lista de campanhas ativas + budget
- Leads gerados por anúncios "Lead Ads" → vem com nome, telefone, email
- Métricas de performance

Cruzando o **telefone normalizado** (ver `normalize_phone()` no banco) entre Meta Leads e `BI Appointments.phone`, montamos a jornada completa: clique → conversa Chatwoot → ficha paciente → agendamento → comparecimento → venda.

## Passo a passo — Pegar credenciais

### 1. Criar um App no Meta for Developers

1. Acesse https://developers.facebook.com/apps/
2. Botão **"Criar app"** (canto superior direito)
3. Tipo do app: **"Business"** (negócio)
4. Nome do app: `Dash Clinics — Marketing API`
5. Email de contato: o seu (Fhely)
6. Conta comercial: selecione a Business Manager onde estão as 32 páginas (S-Pragel/Ecuro)

### 2. Adicionar produto "Marketing API"

1. No painel do app criado, clique **"Adicionar produtos"**
2. Procure **"Marketing API"** → **"Configurar"**
3. Pronto — o produto está habilitado.

### 3. Gerar Access Token de longa duração (System User)

System User tokens **não expiram** (recomendado para integrações server-to-server).

1. Acesse https://business.facebook.com/settings/system-users
2. Botão **"Adicionar"** → nome: `dash-clinics-sync` → função: **"Admin"**
3. Em **"Atribuir ativos"**: selecione todas as Páginas/Contas de Anúncio que você precisa ler.
4. Em **"Gerar token"**:
   - App: o app criado no passo 1
   - Permissões: marque **`ads_read`**, **`ads_management`** (para insights), **`leads_retrieval`** (se for puxar leads), **`pages_read_engagement`**
   - Expiração: **"Nunca"**
5. **Copie o token gerado** — ele aparece UMA VEZ. Guarde em local seguro.

### 4. Pegar o Ad Account ID

1. https://business.facebook.com/settings/ad-accounts
2. Anote o ID no formato `act_123456789` para cada conta de anúncio relevante.

### 5. Cadastrar no Cloudflare como secret

```bash
# Worker que vai puxar (ainda a criar — sync-meta)
wrangler secret put META_ACCESS_TOKEN --config workers/sync-meta/wrangler.toml
wrangler secret put META_AD_ACCOUNT_IDS --config workers/sync-meta/wrangler.toml  # CSV: act_111,act_222

# (Backend Pages Functions também, se for chamar direto da API do dashboard)
wrangler pages secret put META_ACCESS_TOKEN
```

## Endpoints úteis (Marketing API v22)

```
GET https://graph.facebook.com/v22.0/{ad_account_id}/campaigns
  ?fields=id,name,status,objective,daily_budget,created_time
  &access_token={TOKEN}

GET https://graph.facebook.com/v22.0/{ad_account_id}/insights
  ?fields=campaign_name,impressions,clicks,spend,cpm,ctr,actions
  &date_preset=last_30d
  &access_token={TOKEN}

# Leads de um Lead Form:
GET https://graph.facebook.com/v22.0/{form_id}/leads
  ?access_token={TOKEN}
```

## Próximo passo no projeto

Criar `workers/sync-meta/`:
- Cron diário 03h BRT
- Puxa insights agregados (campaign_name, spend, leads, CPL) das últimas 7 dias
- Puxa leads novos via `/leads` endpoint (paginação por `created_time > last_sync`)
- Persiste em nova tabela `meta_campaign_insights` + `meta_leads` (com phone_norm)
- View no Postgres faz JOIN: `meta_leads.phone_norm = "BI Appointments".phone_norm`
- Dashboard ganha bloco "Custo por Agendamento (CPA)" e "ROI por Campanha"

## Importante — LGPD

Telefone de lead é dado pessoal. Recomendações:
- Hash SHA-256 antes de armazenar se não precisar do número original
- Política de retenção alinhada à LGPD (deletar leads não-convertidos após X dias)
- Lead Ads exigem aceite explícito do usuário no formulário — Meta já garante isso
