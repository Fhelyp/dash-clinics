// ════════════════════════════════════════════════════════════════════
//  Worker: sync-chatwoot
//  Para cada clínica em unitConfigs (chatwoot_account_id presente):
//    - Lista labels (tags) iniciados pelo prefixo "campanha"
//    - Para cada tag, conta contatos do mês corrente
//    - Grava em campaign_contacts_cache
// ════════════════════════════════════════════════════════════════════

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
      ctx.waitUntil(runAggregation(env));
      return j({ ok: true });
    }
    return j({ ok: true, name: 'sync-chatwoot' });
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

async function listClinicsWithChatwoot(env) {
  const url = `${env.SUPABASE_URL}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId,chatwoot_account_id,chatwoot_baseUrl,chatwoot_apiKey&chatwoot_account_id=not.is.null`;
  const r = await fetch(url, { headers: supaHeaders(env) });
  if (!r.ok) throw new Error(`unitConfigs: ${r.status}`);
  return r.json();
}

async function chatwootFetch(baseUrl, accountId, apiKey, path, params) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/v2/accounts/${accountId}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { api_access_token: apiKey, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`chatwoot ${path}: ${r.status} ${await r.text().then(t => t.slice(0, 200))}`);
  return r.json();
}

async function runAggregation(env) {
  const clinics = await listClinicsWithChatwoot(env);
  const ym = new Date().toISOString().slice(0, 7);
  const since = new Date(ym + '-01T00:00:00Z').toISOString();
  console.log(`[chatwoot] ${clinics.length} clínicas, mês=${ym}`);

  const cacheRows = [];
  for (const c of clinics) {
    const baseUrl = c.chatwoot_baseUrl || env.CHATWOOT_BASE_URL;
    const apiKey  = c.chatwoot_apiKey  || env.CHATWOOT_API_TOKEN;
    const acct    = c.chatwoot_account_id;
    if (!acct || !apiKey) continue;
    try {
      // /api/v2/accounts/{id}/labels
      const labelsRes = await chatwootFetch(baseUrl, acct, apiKey, '/labels', {});
      const labels = (labelsRes.payload || labelsRes.data || []);
      const camps = labels.filter(l => String(l.title || l.name || '').toLowerCase().startsWith(env.CAMPAIGN_TAG_PREFIX));
      for (const lbl of camps) {
        const tag = lbl.title || lbl.name;
        // /api/v1/accounts/{id}/contacts/search com labels[]=tag
        const search = await chatwootFetch(
          baseUrl.replace('v2', 'v1'), acct, apiKey,
          '/contacts/search', { q: '', include: 'labels', 'labels[]': tag, page: 1 }
        ).catch(() => ({ payload: [] }));
        const contacts = search.payload || [];
        const inMonth = contacts.filter(ct => ct.created_at && new Date(ct.created_at * 1000 || ct.created_at) >= new Date(since));
        cacheRows.push({
          clinic_id: c.Ecuro_clinicId, year_month: ym, campaign_tag: tag,
          contacts_count: inMonth.length, conversations_count: 0,
          refreshed_at: new Date().toISOString()
        });
      }
    } catch (e) {
      console.error(`[chatwoot][${c.Unidade}]`, e.message);
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
