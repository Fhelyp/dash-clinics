// Lê JSONL gerados pelo local-chatwoot-leads.mjs e faz upsert em batch
// via edge function /functions/v1/bulk-upsert-cw-leads.
import fs from 'node:fs';
import path from 'node:path';

const SB_URL  = 'https://reeuuxkeqosiyjntyzma.supabase.co';
const TOKEN   = process.env.BULK_TOKEN || 'dash-clinics-bulk-2026';
const ANON    = process.env.SUPABASE_ANON;
const IN_DIR  = path.resolve('scripts/cw-data');
const STATE   = path.join(IN_DIR, '_upload_state.json');
const BATCH   = 500;

if (!ANON) { console.error('FATAL: SUPABASE_ANON missing'); process.exit(1); }

function loadState() {
  if (!fs.existsSync(STATE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE,'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s,null,2)); }

async function uploadBatch(rows) {
  const r = await fetch(`${SB_URL}/functions/v1/bulk-upsert-cw-leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON}`,    // edge function tem verify_jwt=false mas Supabase ainda pede
      'x-bulk-token': TOKEN,
      'apikey': ANON
    },
    body: JSON.stringify({ rows })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`upload ${r.status}: ${text.slice(0,300)}`);
  return JSON.parse(text);
}

async function main() {
  const state = loadState();
  const files = fs.readdirSync(IN_DIR).filter(f => f.startsWith('leads_') && f.endsWith('.jsonl')).sort();
  let grand = 0;
  for (const f of files) {
    const accountId = f.replace('leads_','').replace('.jsonl','');
    const seen = new Set();
    const rows = fs.readFileSync(path.join(IN_DIR, f), 'utf8').split('\n').filter(Boolean).map(l => {
      const r = JSON.parse(l);
      return {
        id: r.id, account_id: r.account_id, ecuro_clinic_id: r.ecuro_clinic_id,
        name: r.name, email: r.email, phone_raw: r.phone_raw,
        identifier: r.identifier, labels: r.labels,
        created_at_cw: r.created_at_cw, last_activity_at: r.last_activity_at,
        inbox_ids: r.inbox_ids
      };
    }).filter(r => {
      const k = `${r.id}::${r.account_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (state[accountId]?.uploaded === rows.length) {
      console.log(`SKIP account=${accountId} (já uploaded ${rows.length})`);
      grand += rows.length; continue;
    }
    let acc = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const res = await uploadBatch(chunk);
      acc += chunk.length;
      console.log(`  account=${accountId} ${acc}/${rows.length}`);
    }
    state[accountId] = { uploaded: rows.length, at: new Date().toISOString() };
    saveState(state);
    grand += rows.length;
  }
  console.log(`DONE. Grand total uploaded: ${grand}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
