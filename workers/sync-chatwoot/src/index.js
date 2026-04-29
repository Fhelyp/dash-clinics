// ════════════════════════════════════════════════════════════════════
//  Worker: sync-chatwoot
//
//  Para cada unidade em unitConfigs (chatwoot_account_id presente):
//   - Itera /api/v1/accounts/{id}/conversations?labels[]=campanha&status=all
//   - Conta contatos únicos com tag de campanha no MÊS CORRENTE
//   - Grava em campaign_contacts_cache
//
//  Endpoint /api/v2/.../labels NÃO existe nesta instância Chatwoot.
//  Usamos /conversations com filtro labels[] que retorna o array de tags.
//
//  Atenção: Chatwoot é PRODUÇÃO (Maria Clara + operadores). Throttle pesado.
// ════════════════════════════════════════════════════════════════════

const SLEEP_REQUEST_MS = 2000; // entre páginas de conversations
const SLEEP_UNIT_MS    = 8000; // entre clínicas
const PAGE_SIZE        = 25;   // padrão Chatwoot
const MAX_PAGES        = 40;   // teto pra não rodar pra sempre
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAggregation(env));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return j({ ok: true });
    if (url.pathname === '/run' && req.method === 'POST') {
      const auth = req.headers.get('x-admin-token') || '';
      if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) return j({ error: 'unauthorized' }, 401);
      const onlyClinic = url.searchParams.get('clinicId') || null;
      ctx.waitUntil(runAggregation(env, { onlyClinic }));
      return j({ ok: true, message: 'aggregation iniciada em background' });
    }
    return j({ ok: true, name: 'sync-chatwoot', endpoints: ['/health', 'POST /run'] });
  }
};

function j(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

function supaHeaders(env, prefer = '') {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
}

async function listUnits(env, onlyClinic = null) {
  let url = `${env.SUPABASE_URL}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId,chatwoot_account_id,chatwoot_baseUrl,chatwoot_apiKey&chatwoot_account_id=not.is.null`;
  if (onlyClinic) url += `&Ecuro_clinicId=eq.${onlyClinic}`;
  const r = await fetch(url, { headers: supaHeaders(env) });
  if (!r.ok) throw new Error(`unitConfigs: ${r.status}`);
  return r.json();
}

async function chatwootGet(baseUrl, accountId, apiKey, path, params) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, String(item)));
    else if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { api_access_token: apiKey, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`chatwoot ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function runAggregation(env, { onlyClinic = null } = {}) {
  const units = await listUnits(env, onlyClinic);
  const ym = new Date().toISOString().slice(0, 7);
  const monthStart = new Date(ym + '-01T00:00:00Z').getTime() / 1000; // unix em segundos (Chatwoot usa unix timestamps)
  const tag = (env.CAMPAIGN_TAG_PREFIX || 'campanha').toLowerCase();
  console.log(`[chatwoot] ${units.length} unidades, mês=${ym}, tag=${tag}`);

  const cacheRows = [];

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (i > 0) await sleep(SLEEP_UNIT_MS);
    const baseUrl = u.chatwoot_baseUrl;
    const apiKey  = u.chatwoot_apiKey;
    const acct    = u.chatwoot_account_id;
    if (!baseUrl || !apiKey || !acct) continue;

    try {
      const contactsInMonth = new Set();
      const conversationsInMonth = new Set();
      let page = 1;
      while (page <= MAX_PAGES) {
        if (page > 1) await sleep(SLEEP_REQUEST_MS);
        const j = await chatwootGet(baseUrl, acct, apiKey, '/conversations', {
          'labels[]': [tag],
          status: 'all',
          page
        });
        const list = j.data?.payload || [];
        if (!list.length) break;
        for (const conv of list) {
          // Created_at: pode vir epoch ou ISO. Chatwoot v3 = epoch seconds.
          const ts = typeof conv.created_at === 'number' ? conv.created_at : (new Date(conv.created_at).getTime() / 1000);
          if (ts >= monthStart) {
            conversationsInMonth.add(conv.id);
            const cid = conv.meta?.sender?.id || conv.contact_id;
            if (cid) contactsInMonth.add(cid);
          }
        }
        // Se essa página inteira tá fora do mês, pare (paginação ordenada DESC por padrão)
        const allOlder = list.every(c => {
          const ts = typeof c.created_at === 'number' ? c.created_at : (new Date(c.created_at).getTime() / 1000);
          return ts < monthStart;
        });
        if (allOlder) break;
        if (list.length < PAGE_SIZE) break;
        page++;
      }
      cacheRows.push({
        clinic_id: u.Ecuro_clinicId,
        year_month: ym,
        campaign_tag: tag,
        contacts_count: contactsInMonth.size,
        conversations_count: conversationsInMonth.size,
        refreshed_at: new Date().toISOString()
      });
      console.log(`[chatwoot][${u.Unidade}] tag="${tag}" contatos=${contactsInMonth.size} conversas=${conversationsInMonth.size}`);
    } catch (e) {
      console.error(`[chatwoot][${u.Unidade}]`, e.message);
    }
  }

  if (cacheRows.length) {
    const url = `${env.SUPABASE_URL}/rest/v1/campaign_contacts_cache?on_conflict=clinic_id,year_month,campaign_tag`;
    const r = await fetch(url, {
      method: 'POST',
      headers: supaHeaders(env, 'resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify(cacheRows)
    });
    if (!r.ok) console.error('cache upsert', r.status, await r.text());
  }
  console.log(`[chatwoot] done — ${cacheRows.length} agregações gravadas`);
}
