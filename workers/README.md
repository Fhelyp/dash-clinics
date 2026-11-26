# workers/ (legado)

Sync antigo na Cloudflare. **O sync roda na VPS** (`Forux-Digital/dash-sync-jobs`); não publique nada daqui.

| Worker | Na Cloudflare (25/11/2026) | Aqui |
|---|---|---|
| `dash-clinics-sync-chatwoot` | **publicado, cron `0 1 * * *` (22h BRT)**: grava `campaign_contacts_cache`, que nada lê | fonte mantida até o worker ser apagado |
| `dash-clinics-sync-ecuro`, `-sync-cw-leads`, `-health-check-sync` | apagados (set/2026) | removidos do repo (o histórico do git tem a fonte) |

Quando o `dash-clinics-sync-chatwoot` for apagado na Cloudflare, remova esta pasta.
