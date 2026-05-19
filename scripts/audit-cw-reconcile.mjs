// Auditoria + sanitização: pega TODOS os IDs atuais no CW com label=campanha por account,
// compara com chatwoot_leads no Supabase, e DELETA os stale (que perderam a tag).
// Throttle conservador pra não estourar Sidekiq do CW.
import fs from 'node:fs';
import path from 'node:path';

const CW_BASE   = 'https://chatclinics.5ef4kt.easypanel.host';
const CW_TOKEN  = process.env.CHATWOOT_API_KEY || 'SYZ2hYzcnmswgS5yg2hPtiTi';
const SUPA_URL  = 'https://reeuuxkeqosiyjntyzma.supabase.co';
const SUPA_ANON = process.env.SUPABASE_ANON;
const OUT_DIR   = path.resolve('scripts/cw-data');
const LOG_FILE  = path.join(OUT_DIR, '_audit.log');
const HB_FILE   = path.join(OUT_DIR, '_audit_heartbeat.json');
const RESULT    = path.join(OUT_DIR, '_audit_result.json');
const LABEL     = 'campanha';
const SLEEP_PAGE_MS = 700;
const SLEEP_UNIT_MS = 1500;

if (!SUPA_ANON) { console.error('SUPABASE_ANON missing'); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m){ const l=`[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG_FILE, l+'\n'); }
function hb(o){ fs.writeFileSync(HB_FILE, JSON.stringify({at:new Date().toISOString(), ...o}, null, 2)); }

async function cwGet(p, params, att=0){
  const url = new URL(CW_BASE + p);
  for (const [k,v] of Object.entries(params||{})){
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, String(x)));
    else if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { api_access_token: CW_TOKEN, Accept: 'application/json' }});
  if (r.status === 429 || (r.status >= 500 && r.status < 600)){
    if (att >= 6) throw new Error(`CW ${r.status}`);
    const w = 3000 * Math.pow(2, att) + Math.random()*1500;
    await sleep(w);
    return cwGet(p, params, att+1);
  }
  if (!r.ok) throw new Error(`CW ${p} ${r.status}`);
  return r.json();
}

async function supaSelect(qs){
  const r = await fetch(`${SUPA_URL}/rest/v1/${qs}`, { headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }});
  if (!r.ok) throw new Error(`supa ${r.status}: ${await r.text()}`);
  return r.json();
}

async function supaDelete(accountId, ids){
  if (!ids.length) return 0;
  let deleted = 0;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK){
    const batch = ids.slice(i, i+CHUNK);
    const url = `${SUPA_URL}/rest/v1/chatwoot_leads?account_id=eq.${accountId}&id=in.(${batch.join(',')})`;
    const r = await fetch(url, { method: 'DELETE', headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}`, Prefer: 'return=minimal' }});
    if (!r.ok) throw new Error(`delete ${r.status}: ${(await r.text()).slice(0,200)}`);
    deleted += batch.length;
  }
  return deleted;
}

async function listUnits(){
  return supaSelect(`unitConfigs?select=Unidade,chatwoot_account_id&chatwoot_account_id=not.is.null&order=Unidade.asc`);
}

async function fetchAllCwIds(accountId){
  const ids = new Set();
  let page = 1, total = 0;
  while (page <= 800){
    const j = await cwGet(`/api/v1/accounts/${accountId}/contacts`, { 'labels[]': LABEL, page });
    if (page === 1) total = j.meta?.count ?? 0;
    const items = j.payload || [];
    if (!items.length) break;
    for (const c of items) ids.add(parseInt(c.id, 10));
    if (total > 0 && ids.size >= total) break;
    page++;
    await sleep(SLEEP_PAGE_MS);
  }
  return { ids, meta_count: total };
}

async function fetchSupaIds(accountId){
  // Pode ter muitos IDs; paginar via Range
  const ids = new Set();
  let from = 0, step = 1000;
  while (true){
    const r = await fetch(`${SUPA_URL}/rest/v1/chatwoot_leads?account_id=eq.${accountId}&labels=cs.{${LABEL}}&select=id`, {
      headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}`, 'Range-Unit': 'items', Range: `${from}-${from+step-1}` }});
    if (!r.ok) throw new Error(`supa ids ${r.status}`);
    const rows = await r.json();
    if (!rows.length) break;
    for (const row of rows) ids.add(row.id);
    if (rows.length < step) break;
    from += step;
  }
  return ids;
}

const t0 = Date.now();
log('=== AUDIT + RECONCILE ===');
const units = await listUnits();
log(`${units.length} accounts`);

const result = { totals: { cw: 0, supa: 0, deleted: 0, errors: 0 }, accounts: [] };

for (let i = 0; i < units.length; i++){
  const u = units[i];
  const accId = parseInt(u.chatwoot_account_id, 10);
  if (i > 0) await sleep(SLEEP_UNIT_MS);
  log(`[${i+1}/${units.length}] ${u.Unidade} (account=${accId})`);
  try {
    const [cw, supaIds] = await Promise.all([ fetchAllCwIds(accId), fetchSupaIds(accId) ]);
    const cwIds = cw.ids;
    const stale = [...supaIds].filter(id => !cwIds.has(id));
    let deleted = 0;
    if (stale.length){
      deleted = await supaDelete(accId, stale);
    }
    result.totals.cw += cwIds.size;
    result.totals.supa += supaIds.size;
    result.totals.deleted += deleted;
    result.accounts.push({ accountId: accId, unit: u.Unidade, cw: cwIds.size, supa_before: supaIds.size, stale: stale.length, deleted, meta_count: cw.meta_count });
    log(`  cw=${cwIds.size} supa=${supaIds.size} stale=${stale.length} deleted=${deleted}`);
    hb({ ...result.totals, current: `${u.Unidade} done` });
  } catch(e){
    result.totals.errors++;
    log(`  ✗ ${e.message}`);
  }
}

fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
log(`=== DONE === cw=${result.totals.cw} supa=${result.totals.supa} deleted=${result.totals.deleted} errors=${result.totals.errors} elapsed=${((Date.now()-t0)/1000).toFixed(1)}s`);
