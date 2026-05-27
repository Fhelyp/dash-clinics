// Backfill Mai 2026 (1→27) para TODAS as clinicas (SP + GO).
// Objetivos:
//  1) Carregar mês inicial das 49 clinicas GO (nunca tiveram dados)
//  2) Re-puxar logs SP de Mai pra capturar campo NOVO is_reschedule
//  3) Atualizar payments e appointments de SP (idempotente)
import fs from 'node:fs';
import path from 'node:path';

const ECURO_BASE = 'https://clinics.api.ecuro.com.br/api/v1/ecuro-light';
const ECURO_KEY  = process.env.ECURO_API_KEY;
const SUPA_URL   = 'https://reeuuxkeqosiyjntyzma.supabase.co';
const SUPA_ANON  = process.env.SUPABASE_ANON;
const BULK_TOKEN = process.env.BULK_TOKEN || 'dash-clinics-bulk-2026';
const OUT_DIR    = path.resolve('scripts/backfill-data');
const LOG_FILE   = path.join(OUT_DIR, '_mai26_log.txt');
const STATE_FILE = path.join(OUT_DIR, '_mai26_state.json');
const HEARTBEAT  = path.join(OUT_DIR, '_mai26_heartbeat.json');

const FEEDS = [
  { name: 'appointments',     path: '/bi/appointments',     table: 'BI Appointments' },
  { name: 'appointment_logs', path: '/bi/appointment-logs', table: 'BI Appointment Logs' },
  { name: 'payments',         path: '/bi/payments',         table: 'BI Payments' }
];
const PERIODS = [
  { key: '2026-05a', start: '2026-05-01', end: '2026-05-14' },
  { key: '2026-05b', start: '2026-05-14', end: '2026-05-27' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m){ const l=`[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG_FILE, l+'\n'); }
function loadState(){ try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{return{}} }
function saveState(s){ fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function heartbeat(stats){ fs.writeFileSync(HEARTBEAT, JSON.stringify({at:new Date().toISOString(), ...stats}, null, 2)); }

async function listClinics(){
  const r = await fetch(`${SUPA_URL}/rest/v1/unitConfigs?select=Ecuro_clinicId,Unidade,regional&Ecuro_clinicId=not.is.null&order=regional.asc,Unidade.asc`,
    { headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` } });
  if (!r.ok) throw new Error(`unitConfigs ${r.status}`);
  return (await r.json()).filter(c => c.Ecuro_clinicId);
}

async function ecuroFetch(p, params, att=0){
  const url = new URL(ECURO_BASE + p);
  for (const [k,v] of Object.entries(params)) if (v) url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: { Accept: 'application/json', 'app-access-token': ECURO_KEY } });
  if (r.status === 429 || (r.status >= 500 && r.status < 600)){
    if (att >= 20) throw new Error(`${r.status} after ${att} retries`);
    let w = 4000 * Math.pow(2, Math.min(att, 5));
    try { const b = await r.clone().json(); if (b?.retryAfter) w = Math.min(b.retryAfter*1000+1000, 120000); } catch {}
    w += Math.random() * 1500;
    log(`    retry ${att+1}/20 em ${Math.round(w/1000)}s (${r.status})`);
    await sleep(w);
    return ecuroFetch(p, params, att+1);
  }
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

async function bulkUpsert(table, rows){
  if (!rows.length) return 0;
  const seen = new Set();
  const dedup = rows.filter(r => { if (!r.id || seen.has(r.id)) return false; seen.add(r.id); return true; });
  const CHUNK = 500;
  let ok = 0;
  for (let i = 0; i < dedup.length; i += CHUNK){
    const b = dedup.slice(i, i+CHUNK);
    const r = await fetch(`${SUPA_URL}/functions/v1/bulk-upsert-bi`, {
      method:'POST', headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${SUPA_ANON}`,
        'x-bulk-token':BULK_TOKEN,
        'apikey':SUPA_ANON
      }, body: JSON.stringify({ table, rows: b })
    });
    if (!r.ok){
      const t = await r.text();
      throw new Error(`upsert ${r.status}: ${t.slice(0,300)}`);
    }
    ok += b.length;
  }
  return ok;
}

async function pullFeedClinicPeriod(feed, clinic, period, state, totals){
  const stKey = `${feed.name}::${clinic.Ecuro_clinicId}::${period.key}`;
  if (state[stKey]?.done){
    return state[stKey].rows;
  }
  let cur=null, curId=null, page=0, total=0;
  while (page < 80){
    const params = { clinicId: clinic.Ecuro_clinicId, limit: 1000, startDate: period.start, endDate: period.end };
    if (cur) params.cursorValue = cur;
    if (curId) params.cursorId = curId;
    if (page > 0) await sleep(500);
    const j = await ecuroFetch(feed.path, params);
    const rows = j?.data?.rows || [];
    if (rows.length){
      const inserted = await bulkUpsert(feed.table, rows);
      total += inserted;
      totals.upserted += inserted;
      heartbeat({ ...totals, current: stKey });
    }
    if (!j?.data?.hasMore || !j?.data?.nextCursor) break;
    cur = j.data.nextCursor.cursorValue || j.data.nextCursor.updatedAt;
    curId = j.data.nextCursor.id;
    page++;
  }
  state[stKey] = { done: true, rows: total, at: new Date().toISOString() };
  saveState(state);
  return total;
}

async function main(){
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
  const clinics = await listClinics();
  const state = loadState();
  const totals = { ciclos_done: Object.keys(state).filter(k => state[k].done).length, upserted: 0, errors: 0, started_at: new Date().toISOString() };
  const total_ciclos = clinics.length * FEEDS.length * PERIODS.length;
  log(`=== BACKFILL MAI 26 ===`);
  log(`${clinics.length} clinicas (SP+GO) x ${FEEDS.length} feeds x ${PERIODS.length} periodos = ${total_ciclos} ciclos (ja feitos: ${totals.ciclos_done})`);

  for (let pi = 0; pi < PERIODS.length; pi++){
    const period = PERIODS[pi];
    log(`\n---- Periodo ${period.key} (${period.start} -> ${period.end}) ----`);
    for (let i = 0; i < clinics.length; i++){
      const c = clinics[i];
      log(`[${pi+1}.${i+1}/${clinics.length}] ${c.regional}/${c.Unidade}`);
      for (const feed of FEEDS){
        try {
          const n = await pullFeedClinicPeriod(feed, c, period, state, totals);
          totals.ciclos_done++;
          heartbeat({ ...totals, current: `${feed.name}::${c.Ecuro_clinicId}::${period.key}` });
          log(`  ok ${feed.name}: +${n} (cumul=${totals.upserted}, done=${totals.ciclos_done}/${total_ciclos})`);
          await sleep(800);
        } catch(e){
          totals.errors++;
          log(`  ERR ${feed.name}: ${e.message}`);
        }
      }
    }
  }
  log(`\n=== DONE === ciclos=${totals.ciclos_done}/${total_ciclos} upserted=${totals.upserted} errors=${totals.errors}`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
