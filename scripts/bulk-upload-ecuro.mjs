// Lê JSONL gerados pelo local-backfill.mjs e faz upsert via edge function bulk-upsert-bi.
// Mapeia feed name → table name (BI Appointments / BI Appointment Logs / BI Payments).
import fs from 'node:fs';
import path from 'node:path';

const SB_URL  = 'https://reeuuxkeqosiyjntyzma.supabase.co';
const TOKEN   = process.env.BULK_TOKEN || 'dash-clinics-bulk-2026';
const ANON    = process.env.SUPABASE_ANON;
const IN_DIR  = path.resolve('scripts/backfill-data');
const STATE   = path.join(IN_DIR, '_upload_state.json');
const BATCH   = 500;

const FEED_TABLE = {
  'appointments':     'BI Appointments',
  'appointment_logs': 'BI Appointment Logs',
  'payments':         'BI Payments'
};

if (!ANON) { console.error('FATAL: SUPABASE_ANON missing'); process.exit(1); }

function loadState(){ if (!fs.existsSync(STATE)) return {}; try { return JSON.parse(fs.readFileSync(STATE,'utf8')); } catch { return {}; } }
function saveState(s){ fs.writeFileSync(STATE, JSON.stringify(s,null,2)); }

async function uploadBatch(table, rows) {
  const r = await fetch(`${SB_URL}/functions/v1/bulk-upsert-bi`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON}`,
      'x-bulk-token': TOKEN,
      'apikey': ANON
    },
    body: JSON.stringify({ table, rows })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`upload ${r.status}: ${text.slice(0,300)}`);
  return JSON.parse(text);
}

async function main() {
  const state = loadState();
  for (const feed of Object.keys(FEED_TABLE)) {
    const dir = path.join(IN_DIR, feed);
    if (!fs.existsSync(dir)) continue;
    const table = FEED_TABLE[feed];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      const stKey = `${feed}::${f}`;
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
      if (state[stKey]?.uploaded === lines.length) {
        console.log(`SKIP ${stKey} (já uploaded ${lines.length})`);
        continue;
      }
      const seen = new Set();
      const rows = lines.map(l => JSON.parse(l)).filter(r => {
        if (!r.id || seen.has(r.id)) return false;
        seen.add(r.id); return true;
      });
      console.log(`UP ${stKey} → ${table} (${rows.length} rows)`);
      let acc = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        await uploadBatch(table, chunk);
        acc += chunk.length;
        if (acc % 1000 === 0 || acc === rows.length) console.log(`  ${acc}/${rows.length}`);
      }
      state[stKey] = { uploaded: lines.length, table, at: new Date().toISOString() };
      saveState(state);
    }
  }
  console.log('DONE');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
