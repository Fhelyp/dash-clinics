// Sync incremental Chatwoot leads (label=campanha) — fetch + upsert direto via PostgREST.
// Inclui created_at_cw na unicidade pra trazer leads novos sem reprocessar tudo.
// Uso: ECURO_API_KEY=... SUPABASE_ANON=... node scripts/sync-cw-leads-direct.mjs

import fs from 'node:fs';
import path from 'node:path';

const CW_BASE   = 'https://chatclinics.5ef4kt.easypanel.host';
const CW_TOKEN  = process.env.CHATWOOT_API_KEY || 'SYZ2hYzcnmswgS5yg2hPtiTi';
const SUPA_URL  = 'https://reeuuxkeqosiyjntyzma.supabase.co';
const SUPA_ANON = process.env.SUPABASE_ANON;
const OUT_DIR   = path.resolve('scripts/cw-data');
const LOG_FILE  = path.join(OUT_DIR, '_sync_direct.log');
const HB_FILE   = path.join(OUT_DIR, '_sync_direct_heartbeat.json');
const LABEL     = 'campanha';
const PAGE_SIZE_HINT = 25;
const SLEEP_PAGE_MS  = 600;
const SLEEP_UNIT_MS  = 1500;

if (!SUPA_ANON) { console.error('FATAL: SUPABASE_ANON missing'); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m){ const l=`[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG_FILE, l+'\n'); }
function hb(o){ fs.writeFileSync(HB_FILE, JSON.stringify({at:new Date().toISOString(), ...o}, null, 2)); }

async function listUnits(){
  const r = await fetch(`${SUPA_URL}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId,chatwoot_account_id&chatwoot_account_id=not.is.null&order=Unidade.asc`,
    { headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }});
  if (!r.ok) throw new Error(`unitConfigs ${r.status}`);
  return r.json();
}

async function cwGet(p, params, att=0){
  const url = new URL(CW_BASE + p);
  for (const [k,v] of Object.entries(params||{})){
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, String(x)));
    else if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { api_access_token: CW_TOKEN, Accept: 'application/json' }});
  if (r.status === 429 || (r.status >= 500 && r.status < 600)){
    if (att >= 6) throw new Error(`CW ${r.status} after ${att} retries`);
    const w = 3000 * Math.pow(2, att) + Math.random()*1500;
    log(`  retry ${att+1}/6 em ${Math.round(w/1000)}s`);
    await sleep(w);
    return cwGet(p, params, att+1);
  }
  if (!r.ok) throw new Error(`CW ${p} ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

async function upsertBatch(rows){
  if (!rows.length) return 0;
  const r = await fetch(`${SUPA_URL}/rest/v1/chatwoot_leads?on_conflict=id,account_id`, {
    method: 'POST',
    headers: {
      apikey: SUPA_ANON,
      Authorization: `Bearer ${SUPA_ANON}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0,250)}`);
  return rows.length;
}

async function syncUnit(unit, totals){
  const accountId = unit.chatwoot_account_id;
  let page = 1, fetched = 0, upserted = 0, total = 0;
  while (page <= 800){
    const j = await cwGet(`/api/v1/accounts/${accountId}/contacts`, { 'labels[]': LABEL, page });
    if (page === 1) total = j.meta?.count ?? 0;
    const items = j.payload || [];
    if (!items.length) break;
    const rows = items.map(c => ({
      id: parseInt(c.id, 10),
      account_id: parseInt(accountId, 10),
      ecuro_clinic_id: unit.Ecuro_clinicId,
      name: c.name || null,
      email: c.email || null,
      phone_raw: c.phone_number || null,
      identifier: c.identifier || null,
      labels: [LABEL],
      created_at_cw: c.created_at ? new Date(c.created_at * 1000).toISOString() : null,
      last_activity_at: c.last_activity_at ? new Date(c.last_activity_at * 1000).toISOString() : null,
      inbox_ids: (c.contact_inboxes || []).map(ci => ci.inbox?.id).filter(Boolean)
    })).filter(r => !isNaN(r.id));
    fetched += rows.length;
    upserted += await upsertBatch(rows);
    totals.upserted += rows.length;
    hb({ ...totals, current: `${unit.Unidade}::page${page}` });
    if (total > 0 && fetched >= total) break;
    page++;
    await sleep(SLEEP_PAGE_MS);
  }
  return { fetched, upserted, total };
}

const t0 = Date.now();
log('=== SYNC CW DIRECT ===');
const units = await listUnits();
log(`${units.length} unidades`);
const totals = { upserted: 0, errors: 0, started_at: new Date().toISOString() };

for (let i = 0; i < units.length; i++){
  const u = units[i];
  if (i > 0) await sleep(SLEEP_UNIT_MS);
  log(`[${i+1}/${units.length}] ${u.Unidade} (account=${u.chatwoot_account_id})`);
  try {
    const r = await syncUnit(u, totals);
    log(`  ✓ fetched=${r.fetched} upserted=${r.upserted} meta=${r.total} (cumul=${totals.upserted})`);
  } catch(e){
    totals.errors++;
    log(`  ✗ ${e.message}`);
  }
}
log(`=== DONE === upserted=${totals.upserted} errors=${totals.errors} elapsed=${((Date.now()-t0)/1000).toFixed(1)}s`);
hb({ ...totals, current: 'done', finished_at: new Date().toISOString() });
