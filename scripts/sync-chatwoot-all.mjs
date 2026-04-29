// Sincroniza Chatwoot pra TODAS as 32 unidades, throttle pesado pra não comprometer prod.
// Grava em campaign_contacts_cache.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... node scripts/sync-chatwoot-all.mjs

const SUPA = process.env.SUPABASE_URL;
const SR   = process.env.SUPABASE_SERVICE_ROLE;
const TAG  = (process.env.CAMPAIGN_TAG_PREFIX || 'campanha').toLowerCase();

const SLEEP_PAGE_MS = 2500;
const SLEEP_UNIT_MS = 10000;
const PAGE_SIZE = 25;
const MAX_PAGES = 60; // ~1500 conversas
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!SUPA || !SR) { console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE são obrigatórios'); process.exit(1); }

async function listUnits() {
  const r = await fetch(`${SUPA}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId,chatwoot_account_id,chatwoot_baseUrl,chatwoot_apiKey&chatwoot_account_id=not.is.null`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  return r.json();
}

const units = await listUnits();
const ym = new Date().toISOString().slice(0, 7);
const monthStart = new Date(ym + '-01T00:00:00Z').getTime() / 1000;
console.log(`📋 ${units.length} unidades, mês=${ym}, tag="${TAG}"`);

const cacheRows = [];
for (let i = 0; i < units.length; i++) {
  const u = units[i];
  if (i > 0) {
    process.stdout.write(`  …${SLEEP_UNIT_MS/1000}s pausa…\n`);
    await sleep(SLEEP_UNIT_MS);
  }
  const baseUrl = (u.chatwoot_baseUrl || '').replace(/\/$/, '');
  const apiKey = u.chatwoot_apiKey;
  const acct = u.chatwoot_account_id;
  if (!baseUrl || !apiKey || !acct) {
    console.log(`  [${i+1}/${units.length}] ${u.Unidade.padEnd(28)} sem chatwoot config — pulando`);
    continue;
  }
  const headers = { api_access_token: apiKey, Accept: 'application/json' };
  process.stdout.write(`  [${i+1}/${units.length}] ${u.Unidade.padEnd(28)} `);

  const contacts = new Set();
  const convs = new Set();
  try {
    let page = 1;
    while (page <= MAX_PAGES) {
      if (page > 1) await sleep(SLEEP_PAGE_MS);
      const url = new URL(`${baseUrl}/api/v1/accounts/${acct}/conversations`);
      url.searchParams.append('labels[]', TAG);
      url.searchParams.set('status', 'all');
      url.searchParams.set('page', String(page));
      const res = await fetch(url, { headers });
      if (!res.ok) { process.stdout.write(`page${page}=HTTP${res.status} `); break; }
      const j = await res.json();
      const list = j.data?.payload || [];
      if (!list.length) break;
      let allOlder = true;
      for (const conv of list) {
        const ts = typeof conv.created_at === 'number' ? conv.created_at : new Date(conv.created_at).getTime() / 1000;
        if (ts >= monthStart) {
          convs.add(conv.id);
          const cid = conv.meta?.sender?.id || conv.contact_id;
          if (cid) contacts.add(cid);
          allOlder = false;
        }
      }
      if (allOlder || list.length < PAGE_SIZE) break;
      page++;
    }
    cacheRows.push({
      clinic_id: u.Ecuro_clinicId,
      year_month: ym,
      campaign_tag: TAG,
      contacts_count: contacts.size,
      conversations_count: convs.size,
      refreshed_at: new Date().toISOString()
    });
    console.log(`contatos=${contacts.size} convs=${convs.size}`);
  } catch (e) {
    console.log(`ERR(${e.message.slice(0, 60)})`);
  }
}

// Upsert em batch
if (cacheRows.length) {
  const r = await fetch(`${SUPA}/rest/v1/campaign_contacts_cache?on_conflict=clinic_id,year_month,campaign_tag`, {
    method: 'POST',
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(cacheRows)
  });
  console.log(`\n📦 Upsert ${cacheRows.length} linhas → ${r.status}`);
} else {
  console.log('\n⚠️  nada pra gravar');
}

const totalContacts = cacheRows.reduce((s,r)=>s+r.contacts_count, 0);
const totalConvs = cacheRows.reduce((s,r)=>s+r.conversations_count, 0);
console.log(`\n✅ Total: ${totalContacts} contatos · ${totalConvs} conversas em ${cacheRows.length} unidades`);
