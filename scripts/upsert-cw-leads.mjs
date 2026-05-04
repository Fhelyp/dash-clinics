// Lê os JSONL gerados pelo local-chatwoot-leads.mjs e monta arquivos .sql
// com INSERT ... ON CONFLICT (id, account_id) DO UPDATE em batches.
// O agente Claude lê esses .sql files e os passa pra execute_sql do MCP supabase.
//
// Uso:
//   node scripts/upsert-cw-leads.mjs
//
// Saída: scripts/cw-data/sql/{account_id}_{batch}.sql
import fs from 'node:fs';
import path from 'node:path';

const IN_DIR  = path.resolve('scripts/cw-data');
const OUT_DIR = path.resolve('scripts/cw-data/sql');
const BATCH   = 25; // rows por arquivo SQL (~5KB, cabe no Read tool sem truncar)

fs.mkdirSync(OUT_DIR, { recursive: true });

function esc(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}
function escArr(arr) {
  if (!arr || !arr.length) return "ARRAY[]::text[]";
  return "ARRAY[" + arr.map(x => esc(String(x))).join(',') + "]";
}
function escIntArr(arr) {
  if (!arr || !arr.length) return "ARRAY[]::int[]";
  return "ARRAY[" + arr.map(x => parseInt(x,10)).filter(n=>!isNaN(n)).join(',') + "]::int[]";
}
function escTs(s) {
  if (!s) return 'NULL';
  return esc(s) + '::timestamptz';
}

const files = fs.readdirSync(IN_DIR).filter(f => f.startsWith('leads_') && f.endsWith('.jsonl'));
let totalRows = 0;
let sqlFiles = 0;

for (const f of files) {
  const accountId = f.replace('leads_','').replace('.jsonl','');
  const lines = fs.readFileSync(path.join(IN_DIR, f), 'utf8').split('\n').filter(Boolean);
  if (!lines.length) continue;

  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    const values = chunk.map(line => {
      try {
        const r = JSON.parse(line);
        return `(${[
          parseInt(r.id, 10),
          parseInt(r.account_id, 10),
          esc(r.ecuro_clinic_id),
          esc(r.name),
          esc(r.email),
          esc(r.phone_raw),
          esc(r.identifier),
          escArr(r.labels),
          escTs(r.created_at_cw),
          escTs(r.last_activity_at),
          escIntArr(r.inbox_ids)
        ].join(',')})`;
      } catch (e) { return null; }
    }).filter(Boolean).join(',\n');

    const sql = `INSERT INTO chatwoot_leads (id, account_id, ecuro_clinic_id, name, email, phone_raw, identifier, labels, created_at_cw, last_activity_at, inbox_ids) VALUES\n${values}\nON CONFLICT (id, account_id) DO UPDATE SET\n  ecuro_clinic_id = EXCLUDED.ecuro_clinic_id,\n  name = EXCLUDED.name,\n  email = EXCLUDED.email,\n  phone_raw = EXCLUDED.phone_raw,\n  identifier = EXCLUDED.identifier,\n  labels = EXCLUDED.labels,\n  last_activity_at = EXCLUDED.last_activity_at,\n  inbox_ids = EXCLUDED.inbox_ids,\n  synced_at = now();\n`;
    const outFile = path.join(OUT_DIR, `${accountId}_${String(Math.floor(i/BATCH)).padStart(3,'0')}.sql`);
    fs.writeFileSync(outFile, sql);
    sqlFiles++;
    totalRows += chunk.length;
  }
  console.log(`  account=${accountId}: ${lines.length} rows → ${Math.ceil(lines.length/BATCH)} files`);
}

console.log(`\nTotal: ${totalRows} rows, ${sqlFiles} arquivos SQL em ${OUT_DIR}`);
