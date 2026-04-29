// Roda a mesma lógica do worker chatwoot localmente para UMA unidade,
// imprime contagem antes de gravar — pra validar antes de soltar pras 32.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... node scripts/test-chatwoot-aggregate.mjs "Campo Limpo"

const SUPA = process.env.SUPABASE_URL;
const SR   = process.env.SUPABASE_SERVICE_ROLE;
const targetUnit = process.argv[2] || 'Campo Limpo';
const TAG = (process.env.CAMPAIGN_TAG_PREFIX || 'campanha').toLowerCase();

const SLEEP_MS = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const r = await fetch(`${SUPA}/rest/v1/unitConfigs?select=Unidade,chatwoot_account_id,chatwoot_baseUrl,chatwoot_apiKey&Unidade=eq.${encodeURIComponent(targetUnit)}`, {
  headers: { apikey: SR, Authorization: `Bearer ${SR}` }
});
const [u] = await r.json();
if (!u) { console.error(`Unidade "${targetUnit}" não encontrada`); process.exit(1); }
console.log(`📌 ${u.Unidade} | account=${u.chatwoot_account_id}`);

const baseUrl = u.chatwoot_baseUrl.replace(/\/$/, '');
const headers = { api_access_token: u.chatwoot_apiKey, Accept: 'application/json' };

const ym = new Date().toISOString().slice(0, 7);
const monthStart = new Date(ym + '-01T00:00:00Z').getTime() / 1000;
console.log(`Mês corrente=${ym} (epoch>=${monthStart})`);

const contactsInMonth = new Set();
const conversationsInMonth = new Set();
let page = 1;
const MAX = 30;
while (page <= MAX) {
  if (page > 1) await sleep(SLEEP_MS);
  const url = new URL(`${baseUrl}/api/v1/accounts/${u.chatwoot_account_id}/conversations`);
  url.searchParams.append('labels[]', TAG);
  url.searchParams.set('status', 'all');
  url.searchParams.set('page', String(page));
  const res = await fetch(url, { headers });
  if (!res.ok) { console.error(`page ${page} HTTP ${res.status}`); break; }
  const j = await res.json();
  const list = j.data?.payload || [];
  if (!list.length) { console.log(`  page ${page}: vazio, fim`); break; }
  let inMonth = 0, older = 0;
  for (const conv of list) {
    const ts = typeof conv.created_at === 'number' ? conv.created_at : new Date(conv.created_at).getTime() / 1000;
    if (ts >= monthStart) {
      conversationsInMonth.add(conv.id);
      const cid = conv.meta?.sender?.id || conv.contact_id;
      if (cid) contactsInMonth.add(cid);
      inMonth++;
    } else older++;
  }
  console.log(`  page ${page}: ${list.length} convs (${inMonth} no mês, ${older} antes)`);
  if (older === list.length) { console.log('  todas anteriores ao mês, parando'); break; }
  if (list.length < 25) break;
  page++;
}

console.log(`\n✅ ${u.Unidade} (${ym})`);
console.log(`   tag="${TAG}"`);
console.log(`   conversas no mês: ${conversationsInMonth.size}`);
console.log(`   contatos únicos: ${contactsInMonth.size}`);
