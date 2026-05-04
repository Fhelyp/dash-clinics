// Local backfill: pega dados Mar+Mai 2026 da API Ecuro e grava em arquivos JSON
// pra serem upsertados no Supabase via execute_sql (script complementar).
//
// Por que não escreve direto no Supabase? Não temos service_role local.
// Solução: este script SÓ lê e grava em disco. O upload é orquestrado pelo
// agente Claude via execute_sql do MCP supabase em batches.
//
// Throttle/retry idênticos ao worker prod (sync-ecuro/src/index.js):
//   - 800ms entre páginas, 1.8s entre feeds, 2.5s entre clínicas
//   - 429/503 backoff: 5s, 10s, 20s, 40s + jitter, respeita retryAfter
//
// Saída: scripts/backfill-data/{feed}/{clinicId}_{period}.jsonl
//        scripts/backfill-data/_state.json (progresso pra retomar)
//        scripts/backfill-data/_log.txt (log linha por linha)
import fs from 'node:fs';
import path from 'node:path';

const ECURO_BASE  = 'https://clinics.api.ecuro.com.br/api/v1/ecuro-light';
const ECURO_KEY   = process.env.ECURO_API_KEY;
const SUPA_URL    = 'https://reeuuxkeqosiyjntyzma.supabase.co';
const SUPA_ANON   = process.env.SUPABASE_ANON;
const OUT_DIR     = path.resolve('scripts/backfill-data');
const STATE_FILE  = path.join(OUT_DIR, '_state.json');
const LOG_FILE    = path.join(OUT_DIR, '_log.txt');

if (!ECURO_KEY) { console.error('FATAL: ECURO_API_KEY missing'); process.exit(1); }
if (!SUPA_ANON) { console.error('FATAL: SUPABASE_ANON missing'); process.exit(1); }

const FEEDS = [
  { name: 'appointments',     path: '/bi/appointments' },
  { name: 'appointment_logs', path: '/bi/appointment-logs' },
  { name: 'payments',         path: '/bi/payments' },
];

// Períodos: só Mar e Mai (Abr já está completo)
const PERIODS = [
  { key: '2026-03', start: '2026-03-01', end: '2026-03-31' },
  { key: '2026-05', start: '2026-05-01', end: '2026-05-31' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function listClinics() {
  const r = await fetch(`${SUPA_URL}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId&Ecuro_clinicId=not.is.null&order=Unidade.asc`, {
    headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }
  });
  if (!r.ok) throw new Error(`unitConfigs ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ecuroFetch(feedPath, params, attempt = 0) {
  const url = new URL(ECURO_BASE + feedPath);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { Accept: 'application/json', 'app-access-token': ECURO_KEY } });

  if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
    if (attempt >= 5) throw new Error(`Ecuro ${r.status} after ${attempt} retries`);
    let waitMs = 5000 * Math.pow(2, attempt);
    try {
      const body = await r.clone().json();
      const ra = parseInt(body?.retryAfter || 0, 10);
      if (ra > 0) waitMs = Math.min(ra * 1000 + 1000, 90000);
    } catch (_) {}
    waitMs += Math.random() * 1500;
    log(`  retry ${attempt+1}/5 em ${Math.round(waitMs/1000)}s (status ${r.status})`);
    await sleep(waitMs);
    return ecuroFetch(feedPath, params, attempt + 1);
  }
  if (!r.ok) throw new Error(`Ecuro ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

async function pullFeedClinic(feed, clinicId, period) {
  const outFile = path.join(OUT_DIR, feed.name, `${clinicId}_${period.key}.jsonl`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // Resume se já existe state pra essa combinação E o arquivo está completo
  const state = loadState();
  const stateKey = `${feed.name}::${clinicId}::${period.key}`;
  if (state[stateKey]?.done) {
    log(`  SKIP ${stateKey} (já completo: ${state[stateKey].rows} rows)`);
    return state[stateKey].rows;
  }

  // Recomeça do zero (não tenta retomar página parcial — simples e robusto)
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  let cursorValue = null, cursorId = null, page = 0, total = 0;
  const HARD_LIMIT = 50;
  while (page < HARD_LIMIT) {
    const params = { clinicId, limit: 1000, startDate: period.start, endDate: period.end };
    if (cursorValue) params.cursorValue = cursorValue;
    if (cursorId)    params.cursorId    = cursorId;
    if (page > 0) await sleep(800);
    const j = await ecuroFetch(feed.path, params);
    const rows = j?.data?.rows || [];
    if (rows.length) {
      fs.appendFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      total += rows.length;
    }
    if (!j?.data?.hasMore || !j?.data?.nextCursor) break;
    cursorValue = j.data.nextCursor.cursorValue || j.data.nextCursor.updatedAt;
    cursorId    = j.data.nextCursor.id;
    page++;
  }

  state[stateKey] = { done: true, rows: total, fetched_at: new Date().toISOString() };
  saveState(state);
  return total;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, ''); // reset
  log('Iniciando backfill local Mar+Mai 2026');
  const clinics = await listClinics();
  log(`${clinics.length} clínicas, ${FEEDS.length} feeds × ${PERIODS.length} períodos = ${clinics.length * FEEDS.length * PERIODS.length} ciclos`);

  let totalRows = 0;
  for (let i = 0; i < clinics.length; i++) {
    const c = clinics[i];
    if (i > 0) await sleep(2500);
    log(`[${i+1}/${clinics.length}] ${c.Unidade} (${c.Ecuro_clinicId})`);
    for (let f = 0; f < FEEDS.length; f++) {
      const feed = FEEDS[f];
      if (f > 0) await sleep(1800);
      for (const period of PERIODS) {
        try {
          const n = await pullFeedClinic(feed, c.Ecuro_clinicId, period);
          totalRows += n;
          log(`  ✓ ${feed.name} ${period.key}: ${n} rows`);
        } catch (e) {
          log(`  ✗ ${feed.name} ${period.key}: ${e.message}`);
        }
      }
    }
  }
  log(`DONE. Total: ${totalRows} rows`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
