// Testa Chatwoot pra UMA unidade pra entender shape de tags/labels.
// Não escreve nada — apenas leitura.
//
// Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... node scripts/test-chatwoot-one.mjs

const SUPA = process.env.SUPABASE_URL;
const SR   = process.env.SUPABASE_SERVICE_ROLE;
const targetUnit = process.argv[2] || 'Campo Limpo';

const r = await fetch(`${SUPA}/rest/v1/unitConfigs?select=Unidade,chatwoot_account_id,chatwoot_baseUrl,chatwoot_apiKey&Unidade=eq.${encodeURIComponent(targetUnit)}`, {
  headers: { apikey: SR, Authorization: `Bearer ${SR}` }
});
const [u] = await r.json();
if (!u) { console.error(`Unidade "${targetUnit}" não encontrada`); process.exit(1); }
console.log(`📌 ${u.Unidade} | account_id=${u.chatwoot_account_id} | base=${u.chatwoot_baseUrl}`);

const baseUrl = u.chatwoot_baseUrl.replace(/\/$/, '');
const headers = { api_access_token: u.chatwoot_apiKey, Accept: 'application/json' };

// 1. /labels
const labelsRes = await fetch(`${baseUrl}/api/v2/accounts/${u.chatwoot_account_id}/labels`, { headers });
console.log(`\n→ GET /api/v2/accounts/${u.chatwoot_account_id}/labels — HTTP ${labelsRes.status}`);
let labels = [];
if (labelsRes.ok) {
  const j = await labelsRes.json();
  labels = j.payload || j.data || [];
  console.log(`  ${labels.length} labels:`);
  labels.slice(0, 30).forEach(l => console.log(`    "${l.title || l.name}" (${l.color || ''})`));
} else {
  console.log('  body:', (await labelsRes.text()).slice(0, 250));
}

// 2. Para cada label que parece campanha, busca contatos
const camps = labels.filter(l => /camp|ad/i.test(l.title || l.name || ''));
console.log(`\n→ ${camps.length} labels com "camp"/"ad" no nome`);
for (const lbl of camps.slice(0, 3)) {
  const tag = lbl.title || lbl.name;
  const url = `${baseUrl}/api/v1/accounts/${u.chatwoot_account_id}/contacts/search?include=labels&labels[]=${encodeURIComponent(tag)}&page=1`;
  const res = await fetch(url, { headers });
  console.log(`\n→ contatos com label "${tag}" — HTTP ${res.status}`);
  if (res.ok) {
    const j = await res.json();
    const list = j.payload || [];
    console.log(`  ${list.length} contatos retornados`);
    list.slice(0, 2).forEach(c => console.log(`    ${c.name || '?'} | id=${c.id} | created_at=${c.created_at}`));
  }
}

// 3. Endpoint alternativo — conversations com labels
const convUrl = `${baseUrl}/api/v1/accounts/${u.chatwoot_account_id}/conversations?status=all&page=1`;
const convRes = await fetch(convUrl, { headers });
console.log(`\n→ /conversations — HTTP ${convRes.status}`);
if (convRes.ok) {
  const j = await convRes.json();
  console.log(`  meta.all_count: ${j.data?.meta?.all_count || '?'}`);
  console.log(`  primeira conversation labels:`, (j.data?.payload?.[0]?.labels || []).slice(0, 5));
}
