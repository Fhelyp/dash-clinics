// Sync Chatwoot leads (label=campanha) → JSONL local + buffer pro upserter Supabase.
// Pega TODOS os contatos com label "campanha" das 32 unidades (account_id de unitConfigs).
//
// Schema do contact retornado por Chatwoot:
//   { id, name, email, phone_number, identifier, contact_inboxes[{inbox.id}],
//     created_at(unix), last_activity_at(unix), additional_attributes, custom_attributes }
//
// Saída:
//   scripts/cw-data/leads_{account_id}.jsonl   (1 row/linha)
//   scripts/cw-data/_log.txt
//   scripts/cw-data/_state.json (resume)
import fs from 'node:fs';
import path from 'node:path';

const CW_BASE      = 'https://chatclinics.5ef4kt.easypanel.host';
const CW_TOKEN     = process.env.CHATWOOT_API_KEY || 'SYZ2hYzcnmswgS5yg2hPtiTi';
const SUPA_URL     = 'https://reeuuxkeqosiyjntyzma.supabase.co';
const SUPA_ANON    = process.env.SUPABASE_ANON;
const OUT_DIR      = path.resolve('scripts/cw-data');
const STATE_FILE   = path.join(OUT_DIR, '_state.json');
const LOG_FILE     = path.join(OUT_DIR, '_log.txt');
const LABEL        = 'campanha';
const PAGE_SIZE    = 25; // padrão Chatwoot
const SLEEP_PAGE_MS = 700;
const SLEEP_UNIT_MS = 2000;

if (!SUPA_ANON) { console.error('FATAL: SUPABASE_ANON missing'); process.exit(1); }

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
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function listUnits() {
  const r = await fetch(`${SUPA_URL}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId,chatwoot_account_id&chatwoot_account_id=not.is.null&order=Unidade.asc`, {
    headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }
  });
  if (!r.ok) throw new Error(`unitConfigs ${r.status}`);
  return r.json();
}

async function cwGet(path, params, attempt = 0) {
  const url = new URL(`${CW_BASE}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, String(item)));
    else if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { api_access_token: CW_TOKEN, Accept: 'application/json' } });
  if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
    if (attempt >= 5) throw new Error(`CW ${r.status} after ${attempt} retries`);
    const wait = 3000 * Math.pow(2, attempt) + Math.random() * 1500;
    log(`  CW retry ${attempt+1}/5 em ${Math.round(wait/1000)}s (status ${r.status})`);
    await sleep(wait);
    return cwGet(path, params, attempt + 1);
  }
  if (!r.ok) throw new Error(`CW ${path} ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

async function fetchUnitLeads(unit) {
  const accountId = unit.chatwoot_account_id;
  const outFile = path.join(OUT_DIR, `leads_${accountId}.jsonl`);
  const state = loadState();
  const stateKey = `cw::${accountId}`;
  if (state[stateKey]?.done) {
    log(`  SKIP account=${accountId} ${unit.Unidade} (já tem ${state[stateKey].rows} rows)`);
    return state[stateKey].rows;
  }
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  let page = 1, total = 0, count = 0;
  while (true) {
    const j = await cwGet(`/api/v1/accounts/${accountId}/contacts`, { 'labels[]': LABEL, page });
    if (page === 1) {
      count = j.meta?.count ?? 0;
      log(`  account=${accountId} ${unit.Unidade}: ${count} contatos com label=${LABEL}`);
    }
    const items = j.payload || [];
    if (!items.length) break;

    for (const c of items) {
      const inboxIds = (c.contact_inboxes || []).map(ci => ci.inbox?.id).filter(Boolean);
      const row = {
        id: c.id,
        account_id: accountId,
        ecuro_clinic_id: unit.Ecuro_clinicId,
        name: c.name || null,
        email: c.email || null,
        phone_raw: c.phone_number || null,
        identifier: c.identifier || null,
        labels: [LABEL], // simplificado — pra ter todas as labels precisaria de outro endpoint
        created_at_cw: c.created_at ? new Date(c.created_at * 1000).toISOString() : null,
        last_activity_at: c.last_activity_at ? new Date(c.last_activity_at * 1000).toISOString() : null,
        inbox_ids: inboxIds,
        raw: c
      };
      fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
      total++;
    }

    // Critério de fim: ou esgotou meta.count, ou veio página vazia.
    // NÃO usar items.length < PAGE_SIZE — Chatwoot retorna 15/pg (não 25), bug anterior.
    if (count > 0 && total >= count) break;
    page++;
    if (page > 800) { log('  HARD STOP page=800'); break; }
    await sleep(SLEEP_PAGE_MS);
  }

  state[stateKey] = { done: true, rows: total, fetched_at: new Date().toISOString() };
  saveState(state);
  return total;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, '');
  log('Iniciando sync Chatwoot leads (label=campanha)');
  const units = await listUnits();
  log(`${units.length} unidades`);

  let grandTotal = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (i > 0) await sleep(SLEEP_UNIT_MS);
    log(`[${i+1}/${units.length}] ${u.Unidade} (account=${u.chatwoot_account_id})`);
    try {
      const n = await fetchUnitLeads(u);
      grandTotal += n;
      log(`  ✓ +${n} (total=${grandTotal})`);
    } catch (e) {
      log(`  ✗ ${e.message}`);
    }
  }
  log(`DONE. Grand total: ${grandTotal} leads`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
