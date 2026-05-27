// Backfill Abr 2026 (1-30) APENAS appointment_logs pra TODAS as clinicas SP.
// Objetivo: capturar is_reschedule retroativo. NAO re-puxa appointments nem payments.
// GO foi onboarded em 26/05, nao precisa Abr.
import fs from 'node:fs';
import path from 'node:path';

const ECURO_BASE = 'https://clinics.api.ecuro.com.br/api/v1/ecuro-light';
const ECURO_KEY  = process.env.ECURO_API_KEY;
const SUPA_URL   = 'https://reeuuxkeqosiyjntyzma.supabase.co';
const SUPA_ANON  = process.env.SUPABASE_ANON;
const BULK_TOKEN = process.env.BULK_TOKEN || 'dash-clinics-bulk-2026';
const OUT_DIR    = path.resolve('scripts/backfill-data');
const LOG_FILE   = path.join(OUT_DIR, '_abr_logs_log.txt');
const STATE_FILE = path.join(OUT_DIR, '_abr_logs_state.json');
const HEARTBEAT  = path.join(OUT_DIR, '_abr_logs_heartbeat.json');

const PERIODS = [
  { key: '2026-04a', start: '2026-04-01', end: '2026-04-15' },
  { key: '2026-04b', start: '2026-04-15', end: '2026-05-01' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m){ const l=`[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG_FILE, l+'\n'); }
function loadState(){ try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{return{}} }
function saveState(s){ fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function heartbeat(stats){ fs.writeFileSync(HEARTBEAT, JSON.stringify({at:new Date().toISOString(), ...stats}, null, 2)); }

async function listClinics(){
  const r = await fetch(`${SUPA_URL}/rest/v1/unitConfigs?select=Ecuro_clinicId,Unidade,regional&Ecuro_clinicId=not.is.null&regional=eq.SP&order=Unidade.asc`,
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

async function bulkUpsert(rows){
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
      }, body: JSON.stringify({ table: 'BI Appointment Logs', rows: b })
    });
    if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0,300)}`);
    ok += b.length;
  }
  return ok;
}

async function pullClinicPeriod(clinic, period, state, totals){
  const stKey = `logs::${clinic.Ecuro_clinicId}::${period.key}`;
  if (state[stKey]?.done) return state[stKey].rows;
  let cur=null, curId=null, page=0, total=0;
  while (page < 100){
    const params = { clinicId: clinic.Ecuro_clinicId, limit: 1000, startDate: period.start, endDate: period.end };
    if (cur) params.cursorValue = cur;
    if (curId) params.cursorId = curId;
    if (page > 0) await sleep(500);
    const j = await ecuroFetch('/bi/appointment-logs', params);
    const rows = j?.data?.rows || [];
    if (rows.length){
      const inserted = await bulkUpsert(rows);
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
  const total_ciclos = clinics.length * PERIODS.length;
  log(`=== BACKFILL ABR LOGS SP ===`);
  log(`${clinics.length} clinicas SP x ${PERIODS.length} periodos = ${total_ciclos} ciclos (ja feitos: ${totals.ciclos_done})`);

  for (let pi = 0; pi < PERIODS.length; pi++){
    const period = PERIODS[pi];
    log(`\n---- Periodo ${period.key} ----`);
    for (let i = 0; i < clinics.length; i++){
      const c = clinics[i];
      log(`[${pi+1}.${i+1}/${clinics.length}] ${c.Unidade}`);
      try {
        const n = await pullClinicPeriod(c, period, state, totals);
        totals.ciclos_done++;
        heartbeat({ ...totals, current: `${c.Ecuro_clinicId}::${period.key}` });
        log(`  ok: +${n} (cumul=${totals.upserted}, done=${totals.ciclos_done}/${total_ciclos})`);
        await sleep(600);
      } catch(e){
        totals.errors++;
        log(`  ERR: ${e.message}`);
      }
    }
  }
  log(`\n=== DONE === ciclos=${totals.ciclos_done}/${total_ciclos} upserted=${totals.upserted} errors=${totals.errors}`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
