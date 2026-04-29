// Sync ad-hoc local: roda o mesmo fluxo do worker, mas direto do Node.
// Usado pra ter dados na hora em que bootstrap está bloqueado pela API (08:00–20:00 BRT).
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... ECURO_API_KEY=... \
//   node scripts/sync-now.mjs incremental
//
//   # ou para bootstrap entre 20-08 BRT:
//   node scripts/sync-now.mjs bootstrap 2026-04-01 2026-04-29
//
// Suporte a clinic_id único:
//   node scripts/sync-now.mjs incremental --only=878b3cf8-fc89-4e4d-9185-49d96b458cd0

const args = process.argv.slice(2);
const mode = args[0] || 'incremental';
const onlyArg = args.find(a => a.startsWith('--only='));
const onlyClinicId = onlyArg ? onlyArg.replace('--only=', '') : null;
const startDate = mode === 'bootstrap' ? args[1] : null;
const endDate   = mode === 'bootstrap' ? args[2] : null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPA_SR     = process.env.SUPABASE_SERVICE_ROLE;
const ECURO_KEY   = process.env.ECURO_API_KEY;
const ECURO_BASE  = process.env.ECURO_BASE_URL || 'https://clinics.api.ecuro.com.br/api/v1/ecuro-light';

if (!SUPABASE_URL || !SUPA_SR || !ECURO_KEY) {
  console.error('Faltam env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, ECURO_API_KEY');
  process.exit(1);
}

const FEEDS = [
  { name: 'appointments',     path: '/bi/appointments',     table: 'BI Appointments' },
  { name: 'appointment_logs', path: '/bi/appointment-logs', table: 'BI Appointment Logs' },
  { name: 'payments',         path: '/bi/payments',         table: 'BI Payments' },
];

// ── Rate-limit: pausas longas para NÃO comprometer a operação Maria Clara ──
// A API Ecuro é compartilhada com o agente em produção. Excesso de requisições
// pode degradar o atendimento aos pacientes — então preferimos sincronizar devagar.
const SLEEP_BETWEEN_REQUESTS_MS  = parseInt(process.env.SLEEP_REQUEST_MS  || '5000', 10);   // 5s entre páginas/feeds
const SLEEP_BETWEEN_CLINICS_MS   = parseInt(process.env.SLEEP_CLINIC_MS   || '60000', 10);  // 60s entre clínicas
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function supaHeaders(prefer = '') {
  return {
    apikey: SUPA_SR,
    Authorization: `Bearer ${SUPA_SR}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
}

async function listClinics() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId&Ecuro_clinicId=not.is.null`, { headers: supaHeaders() });
  if (!r.ok) throw new Error(`unitConfigs: ${r.status}`);
  const all = await r.json();
  return onlyClinicId ? all.filter(c => c.Ecuro_clinicId === onlyClinicId) : all;
}

async function ecuroFetch(path, params) {
  const url = new URL(ECURO_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { 'app-access-token': ECURO_KEY, Accept: 'application/json' } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Ecuro ${path} ${r.status}: ${txt.slice(0, 250)}`);
  return JSON.parse(txt);
}

async function upsertRows(table, rows) {
  if (!rows.length) return 0;
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?on_conflict=id`;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const r = await fetch(url, {
      method: 'POST',
      headers: supaHeaders('resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify(rows.slice(i, i + CHUNK))
    });
    if (!r.ok) throw new Error(`upsert ${table}: ${r.status} ${(await r.text()).slice(0, 250)}`);
  }
  return rows.length;
}

async function pullAndUpsert(feed, clinicId, opts) {
  let total = 0, cursorValue = null, cursorId = null, page = 0;
  const HARD_PAGE_LIMIT = 25; // safety contra loop infinito (25 × 1000 = 25k rows)
  while (page < HARD_PAGE_LIMIT) {
    const params = { clinicId, limit: 1000 };
    if (opts.mode === 'bootstrap') {
      params.startDate = opts.startDate; params.endDate = opts.endDate;
      if (cursorValue) params.cursorValue = cursorValue;
      if (cursorId)    params.cursorId    = cursorId;
    } else {
      // Incremental: cada página avança updatedAfter pro nextCursor.updatedAt
      params.updatedAfter = cursorValue || opts.updatedAfter;
      if (cursorId) params.cursorId = cursorId;
    }
    if (page > 0) await sleep(SLEEP_BETWEEN_REQUESTS_MS); // pausa entre páginas dentro do mesmo feed
    const j = await ecuroFetch(feed.path, params);
    const data = j?.data || {};
    const rows = data.rows || [];
    if (rows.length) {
      await upsertRows(feed.table, rows);
      total += rows.length;
    }
    if (!data.hasMore || !data.nextCursor) break;
    cursorValue = data.nextCursor.cursorValue || data.nextCursor.updatedAt;
    cursorId    = data.nextCursor.id;
    page++;
  }
  return total;
}

const clinics = await listClinics();
console.log(`📋 ${clinics.length} clínicas alvo`);

const grand = { appointments: 0, appointment_logs: 0, payments: 0 };
const t0 = Date.now();

if (mode === 'incremental') {
  // Lookback de 6 dias (limite duro da API é 7)
  const since = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
  console.log(`⏳ Incremental updatedAfter=${since}`);
  for (let i = 0; i < clinics.length; i++) {
    const c = clinics[i];
    if (i > 0) {
      process.stdout.write(`  …aguardando ${SLEEP_BETWEEN_CLINICS_MS/1000}s antes da próxima clínica…\n`);
      await sleep(SLEEP_BETWEEN_CLINICS_MS);
    }
    process.stdout.write(`  [${i+1}/${clinics.length}] ${c.Unidade.padEnd(28)} `);
    const counts = {};
    for (let f = 0; f < FEEDS.length; f++) {
      const feed = FEEDS[f];
      if (f > 0) await sleep(SLEEP_BETWEEN_REQUESTS_MS);
      try {
        const n = await pullAndUpsert(feed, c.Ecuro_clinicId, { mode: 'incremental', updatedAfter: since });
        counts[feed.name] = n;
        grand[feed.name] += n;
      } catch (e) {
        counts[feed.name] = `ERR(${e.message.slice(0, 60)})`;
      }
    }
    console.log(`appts=${counts.appointments} logs=${counts.appointment_logs} pays=${counts.payments}`);
  }
} else if (mode === 'bootstrap') {
  if (!startDate || !endDate) {
    console.error('bootstrap precisa de startDate e endDate (YYYY-MM-DD)');
    process.exit(1);
  }
  console.log(`⏳ Bootstrap ${startDate} → ${endDate}`);
  for (let i = 0; i < clinics.length; i++) {
    const c = clinics[i];
    if (i > 0) {
      process.stdout.write(`  …aguardando ${SLEEP_BETWEEN_CLINICS_MS/1000}s antes da próxima clínica…\n`);
      await sleep(SLEEP_BETWEEN_CLINICS_MS);
    }
    process.stdout.write(`  [${i+1}/${clinics.length}] ${c.Unidade.padEnd(28)} `);
    const counts = {};
    for (let f = 0; f < FEEDS.length; f++) {
      const feed = FEEDS[f];
      if (f > 0) await sleep(SLEEP_BETWEEN_REQUESTS_MS);
      try {
        const n = await pullAndUpsert(feed, c.Ecuro_clinicId, { mode: 'bootstrap', startDate, endDate });
        counts[feed.name] = n;
        grand[feed.name] += n;
      } catch (e) {
        counts[feed.name] = `ERR(${e.message.slice(0, 60)})`;
      }
    }
    console.log(`appts=${counts.appointments} logs=${counts.appointment_logs} pays=${counts.payments}`);
  }
} else {
  console.error('mode deve ser "incremental" ou "bootstrap"');
  process.exit(1);
}

console.log(`\n✅ Total: ${grand.appointments} appts, ${grand.appointment_logs} logs, ${grand.payments} pays — ${(Date.now() - t0) / 1000}s`);
