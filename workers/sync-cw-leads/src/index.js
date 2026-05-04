// ════════════════════════════════════════════════════════════════════
//  Worker: sync-cw-leads
//
//  Sincroniza contatos do Chatwoot com label="campanha" → tabela
//  chatwoot_leads (Supabase). Usado pra montar o funil de vendas
//  cruzando com BI Appointments via phone_norm.
//
//  Modos:
//   - INCREMENTAL (diário 03h BRT): pra cada conta, GET /contacts?labels[]=campanha
//     ordenado por last_activity_at DESC. Pagina até encontrar contato
//     com last_activity_at <= last_activity_seen. Upsert no Supabase.
//
//   - FULL REFRESH (sábado 04h BRT): re-puxa TODAS as páginas de TODAS
//     as contas. Captura mudanças retroativas (label removida, etc).
//
//  Endpoints manuais (com x-admin-token):
//   POST /run-incremental
//   POST /run-full-refresh
//   POST /run-account?accountId=N (incremental só uma conta)
//   GET  /health
//   GET  /status   (resume sync_state pra debug)
// ════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 25;          // padrão Chatwoot
const SLEEP_PAGE_MS = 700;     // throttle entre páginas
const SLEEP_UNIT_MS = 2000;    // throttle entre contas
const HARD_PAGE_LIMIT = 500;   // safety stop
const FULL_REFRESH_BACKDATE = '1970-01-01T00:00:00Z'; // forces full

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 7 * * 6') {
      console.log('[cron sat 04h BRT] Full refresh');
      ctx.waitUntil(runFullRefresh(env));
    } else {
      console.log('[cron daily 03h BRT] Incremental');
      ctx.waitUntil(runIncremental(env));
    }
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return j({ ok: true, name: 'sync-cw-leads' });

    if (url.pathname === '/status') {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/chatwoot_sync_state?select=*&order=rows_synced_total.desc`,
        { headers: supaHeaders(env) });
      return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }

    const auth = req.headers.get('x-admin-token') || '';
    if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) return j({ error: 'unauthorized' }, 401);

    if (url.pathname === '/run-incremental' && req.method === 'POST') {
      ctx.waitUntil(runIncremental(env));
      return j({ ok: true, message: 'incremental started' });
    }
    if (url.pathname === '/run-full-refresh' && req.method === 'POST') {
      ctx.waitUntil(runFullRefresh(env));
      return j({ ok: true, message: 'full refresh started' });
    }
    if (url.pathname === '/run-account' && req.method === 'POST') {
      const accountId = parseInt(url.searchParams.get('accountId') || '', 10);
      const force = url.searchParams.get('force') === 'true';
      if (!accountId) return j({ error: 'missing_accountId' }, 400);
      ctx.waitUntil(runOneAccount(env, accountId, { force }));
      return j({ ok: true, message: `account ${accountId} sync started`, force });
    }

    return j({ ok: true, name: 'sync-cw-leads',
      endpoints: ['/health', '/status', 'POST /run-incremental', 'POST /run-full-refresh', 'POST /run-account?accountId=N&force=true'] });
  }
};

// ── Helpers ─────────────────────────────────────────────────────────
function j(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

function supaHeaders(env, prefer = '') {
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
}

async function listUnits(env) {
  const url = `${env.SUPABASE_URL}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId,chatwoot_account_id&chatwoot_account_id=not.is.null&order=Unidade.asc`;
  const r = await fetch(url, { headers: supaHeaders(env) });
  if (!r.ok) throw new Error(`unitConfigs: ${r.status} ${await r.text()}`);
  return r.json();
}

async function readState(env, accountId) {
  const url = `${env.SUPABASE_URL}/rest/v1/chatwoot_sync_state?account_id=eq.${accountId}`;
  const r = await fetch(url, { headers: supaHeaders(env) });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function writeState(env, row) {
  const url = `${env.SUPABASE_URL}/rest/v1/chatwoot_sync_state?on_conflict=account_id`;
  await fetch(url, {
    method: 'POST',
    headers: supaHeaders(env, 'resolution=merge-duplicates,return=minimal'),
    body: JSON.stringify([row])
  });
}

async function cwGet(env, path, params, attempt = 0) {
  const url = new URL(`${env.CHATWOOT_BASE_URL.replace(/\/$/, '')}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, String(item)));
    else if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { api_access_token: env.CHATWOOT_API_KEY, Accept: 'application/json' } });
  if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
    if (attempt >= 5) throw new Error(`CW ${r.status} after ${attempt} retries`);
    const wait = 3000 * Math.pow(2, attempt) + Math.random() * 1500;
    console.log(`  CW retry ${attempt+1}/5 em ${Math.round(wait/1000)}s (status ${r.status})`);
    await sleep(wait);
    return cwGet(env, path, params, attempt + 1);
  }
  if (!r.ok) throw new Error(`CW ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function upsertLeads(env, rows) {
  if (!rows.length) return 0;
  // Dedup por (id, account_id) dentro do batch — Chatwoot pode retornar duplicatas entre páginas
  const seen = new Set();
  const dedup = rows.filter(r => {
    const k = `${r.id}::${r.account_id}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  const url = `${env.SUPABASE_URL}/rest/v1/chatwoot_leads?on_conflict=id,account_id`;
  const CHUNK = 500;
  for (let i = 0; i < dedup.length; i += CHUNK) {
    const batch = dedup.slice(i, i + CHUNK);
    const r = await fetch(url, {
      method: 'POST',
      headers: supaHeaders(env, 'resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify(batch)
    });
    if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  return dedup.length;
}

function mapContact(c, accountId, ecuroClinicId) {
  const inboxIds = (c.contact_inboxes || []).map(ci => ci.inbox?.id).filter(Boolean);
  return {
    id: c.id,
    account_id: accountId,
    ecuro_clinic_id: ecuroClinicId,
    name: c.name || null,
    email: c.email || null,
    phone_raw: c.phone_number || null,
    identifier: c.identifier || null,
    labels: ['campanha'],
    created_at_cw: c.created_at ? new Date(c.created_at * 1000).toISOString() : null,
    last_activity_at: c.last_activity_at ? new Date(c.last_activity_at * 1000).toISOString() : null,
    inbox_ids: inboxIds
  };
}

// ── Runners ──────────────────────────────────────────────────────────
async function runOneAccount(env, accountId, { force = false } = {}) {
  const units = await listUnits(env);
  const unit = units.find(u => Number(u.chatwoot_account_id) === Number(accountId));
  if (!unit) { console.error(`account ${accountId} not in unitConfigs`); return; }

  const state = await readState(env, accountId);
  // Cutoff: se force ou nunca rodou, baixa tudo. Senão, baixa até bater no last_activity_seen.
  const cutoffISO = (force || !state?.last_activity_seen) ? null : state.last_activity_seen;
  const cutoffTs = cutoffISO ? new Date(cutoffISO).getTime() : null;

  console.log(`[${accountId}] ${unit.Unidade} — cutoff=${cutoffISO || 'NONE (full)'}`);

  const ecuroClinicId = unit.Ecuro_clinicId;
  const label = env.CAMPAIGN_LABEL || 'campanha';

  let page = 1, total = 0, maxSeen = cutoffISO ? new Date(cutoffISO) : null, stop = false;
  let firstError = null;

  while (page <= HARD_PAGE_LIMIT && !stop) {
    let resp;
    try {
      resp = await cwGet(env, `/api/v1/accounts/${accountId}/contacts`, {
        'labels[]': label, page, sort: '-last_activity_at'
      });
    } catch (e) {
      firstError = e.message;
      console.error(`[${accountId}] page ${page} error: ${firstError}`);
      break;
    }
    const items = resp.payload || [];
    if (!items.length) break;

    const batch = [];
    for (const c of items) {
      const lastAct = c.last_activity_at ? c.last_activity_at * 1000 : 0;
      if (cutoffTs && lastAct <= cutoffTs) { stop = true; break; }
      batch.push(mapContact(c, accountId, ecuroClinicId));
      if (lastAct && (!maxSeen || lastAct > maxSeen.getTime())) maxSeen = new Date(lastAct);
    }
    if (batch.length) {
      try { await upsertLeads(env, batch); total += batch.length; }
      catch (e) { firstError = e.message; console.error(`[${accountId}] upsert error: ${firstError}`); break; }
    }

    const cnt = resp.meta?.count ?? 0;
    if (cnt > 0 && page * PAGE_SIZE >= cnt) break;
    if (items.length === 0) break;
    if (stop) break;

    page++;
    await sleep(SLEEP_PAGE_MS);
  }

  await writeState(env, {
    account_id: accountId,
    ecuro_clinic_id: ecuroClinicId,
    last_synced_at: new Date().toISOString(),
    last_activity_seen: maxSeen ? maxSeen.toISOString() : (state?.last_activity_seen || null),
    rows_synced_total: (state?.rows_synced_total || 0) + total,
    last_run_status: firstError ? 'error' : 'ok',
    last_run_error: firstError ? firstError.slice(0, 500) : null,
    full_refresh_at: force ? new Date().toISOString() : (state?.full_refresh_at || null)
  });

  console.log(`[${accountId}] done +${total} leads (${firstError ? 'with error' : 'clean'})`);
  return total;
}

async function runIncremental(env) {
  const units = await listUnits(env);
  console.log(`[incremental] ${units.length} unidades`);
  let grand = 0;
  for (let i = 0; i < units.length; i++) {
    if (i > 0) await sleep(SLEEP_UNIT_MS);
    const accId = Number(units[i].chatwoot_account_id);
    try { grand += (await runOneAccount(env, accId, { force: false })) || 0; }
    catch (e) { console.error(`[incremental][${accId}]`, e.message); }
  }
  console.log(`[incremental] DONE +${grand} leads`);
}

async function runFullRefresh(env) {
  const units = await listUnits(env);
  console.log(`[full refresh] ${units.length} unidades`);
  let grand = 0;
  for (let i = 0; i < units.length; i++) {
    if (i > 0) await sleep(SLEEP_UNIT_MS);
    const accId = Number(units[i].chatwoot_account_id);
    try { grand += (await runOneAccount(env, accId, { force: true })) || 0; }
    catch (e) { console.error(`[full refresh][${accId}]`, e.message); }
  }
  console.log(`[full refresh] DONE +${grand} leads`);
}
