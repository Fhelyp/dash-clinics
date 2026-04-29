// Sync rápido e simples — todas 32 clínicas, 6d lookback, com throttle moderado
// Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... ECURO_API_KEY=... node scripts/quick-sync.mjs

const SUPA = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE;
const ECURO = process.env.ECURO_API_KEY;
const ECURO_BASE = 'https://clinics.api.ecuro.com.br/api/v1/ecuro-light';

const FEEDS = [
  { path: '/bi/appointments', table: 'BI Appointments', dateField: 'start_time' },
  { path: '/bi/appointment-logs', table: 'BI Appointment Logs', dateField: 'changeDate' },
  { path: '/bi/payments', table: 'BI Payments', dateField: 'date' },
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11,19)}]`, ...a);
const supaH = (prefer = '') => ({
  apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json',
  ...(prefer ? { Prefer: prefer } : {})
});

async function listClinics() {
  const r = await fetch(`${SUPA}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId&Ecuro_clinicId=not.is.null`, { headers: supaH() });
  return r.json();
}

async function fetchPage(path, clinicId, updatedAfter, cursorId) {
  const u = new URL(ECURO_BASE + path);
  u.searchParams.set('clinicId', clinicId);
  u.searchParams.set('updatedAfter', updatedAfter);
  if (cursorId) u.searchParams.set('cursorId', cursorId);
  u.searchParams.set('limit', '500');
  const r = await fetch(u, { headers: { 'app-access-token': ECURO } });
  if (!r.ok) throw new Error(`Ecuro ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json();
}

async function upsert(table, rows) {
  if (!rows.length) return;
  const r = await fetch(`${SUPA}/rest/v1/${encodeURIComponent(table)}?on_conflict=id`, {
    method: 'POST', headers: supaH('resolution=merge-duplicates,return=minimal'),
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`upsert ${table} ${r.status}: ${(await r.text()).slice(0, 150)}`);
}

// Filtra só 2026 — Ecuro retorna appointments com start_time fora desse range
function only2026(rows, dateField) {
  if (!dateField) return rows;
  return rows.filter(r => {
    const d = r[dateField];
    if (!d) return true; // sem data, mantem
    const y = new Date(d).getFullYear();
    return y === 2026;
  });
}

async function syncFeed(feed, clinicId, since) {
  let updatedAfter = since, cursorId = null, total = 0, page = 0;
  while (page < 10) {
    const j = await fetchPage(feed.path, clinicId, updatedAfter, cursorId);
    let rows = j.data?.rows || [];
    rows = only2026(rows, feed.dateField);
    if (rows.length) await upsert(feed.table, rows);
    total += rows.length;
    if (!j.data?.hasMore || !j.data?.nextCursor) break;
    updatedAfter = j.data.nextCursor.updatedAt;
    cursorId = j.data.nextCursor.id;
    page++;
    await sleep(800);
  }
  return total;
}

const clinics = await listClinics();
const since = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
log(`📋 ${clinics.length} clínicas, since=${since.slice(0, 10)}`);

let grandTotal = { appts: 0, logs: 0, pays: 0 };
for (let i = 0; i < clinics.length; i++) {
  const c = clinics[i];
  if (i > 0) await sleep(2500);
  const t0 = Date.now();
  try {
    const a = await syncFeed(FEEDS[0], c.Ecuro_clinicId, since); await sleep(500);
    const l = await syncFeed(FEEDS[1], c.Ecuro_clinicId, since); await sleep(500);
    const p = await syncFeed(FEEDS[2], c.Ecuro_clinicId, since);
    grandTotal.appts += a; grandTotal.logs += l; grandTotal.pays += p;
    log(`[${(i+1).toString().padStart(2)}/${clinics.length}] ${c.Unidade.padEnd(28)} a=${a} l=${l} p=${p} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
  } catch (e) {
    log(`[${(i+1).toString().padStart(2)}/${clinics.length}] ${c.Unidade.padEnd(28)} ERR: ${e.message.slice(0, 100)}`);
  }
}
log(`✅ Total: appts=${grandTotal.appts} logs=${grandTotal.logs} pays=${grandTotal.pays}`);
