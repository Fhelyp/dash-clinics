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

// URL pública do próprio worker — usada pra fan-out em scheduled().
// Pega da env (configurável) ou usa o default produção.
const SELF_URL = 'https://dash-clinics-sync-cw-leads.foruxdigital.workers.dev';

export default {
  async scheduled(event, env, ctx) {
    // FAN-OUT: o cron sequencial estourava o CPU limit do Cloudflare (~30s) processando
    // só 8 das 32 contas. Agora o handler scheduled apenas dispara fetches assíncronos
    // pra /run-account de cada uma — cada fetch vira uma INVOCAÇÃO SEPARADA do worker
    // com seu próprio orçamento de CPU. Throttle 800ms entre disparos.
    const force = event.cron === '0 7 * * 6';
    console.log(`[cron] mode=${force ? 'full-refresh' : 'incremental'} — fan-out`);
    ctx.waitUntil(fanOutAccounts(env, force));
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

// Reconcile: deleta leads no Supabase que NÃO foram vistos no CW nesta run.
// Usado SÓ no full refresh (force=true). No incremental seria incorreto pq pagina
// até bater no cutoff e os "não vistos" são apenas mais antigos, não removidos.
async function reconcileAccount(env, accountId, seenIds) {
  if (!seenIds || seenIds.size === 0) {
    // Defesa: se algo deu errado e nada foi visto, não deletar tudo.
    console.log(`[${accountId}] reconcile SKIP (zero seen ids)`);
    return 0;
  }
  // Pega TODOS os IDs atuais no Supabase pra essa account com label=campanha
  const supaIds = new Set();
  let from = 0; const step = 1000;
  while (true) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/chatwoot_leads?account_id=eq.${accountId}&labels=cs.{campanha}&select=id`, {
      headers: { ...supaHeaders(env), 'Range-Unit': 'items', Range: `${from}-${from+step-1}` }
    });
    if (!r.ok) throw new Error(`reconcile select ${r.status}`);
    const rows = await r.json();
    if (!rows.length) break;
    for (const row of rows) supaIds.add(row.id);
    if (rows.length < step) break;
    from += step;
  }
  const stale = [...supaIds].filter(id => !seenIds.has(id));
  if (!stale.length) { console.log(`[${accountId}] reconcile clean (no stale)`); return 0; }
  // DELETE em batches
  let deleted = 0;
  const CHUNK = 200;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const batch = stale.slice(i, i + CHUNK);
    const url = `${env.SUPABASE_URL}/rest/v1/chatwoot_leads?account_id=eq.${accountId}&id=in.(${batch.join(',')})`;
    const r = await fetch(url, { method: 'DELETE', headers: { ...supaHeaders(env, 'return=minimal') }});
    if (!r.ok) throw new Error(`reconcile delete ${r.status}`);
    deleted += batch.length;
  }
  console.log(`[${accountId}] reconcile DELETED ${deleted} stale leads`);
  return deleted;
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
  // Em full refresh, rastreamos todos os IDs vistos pra fazer reconcile (DELETE stale) no final
  const seenIds = force ? new Set() : null;

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
      if (seenIds) seenIds.add(c.id);
      if (lastAct && (!maxSeen || lastAct > maxSeen.getTime())) maxSeen = new Date(lastAct);
    }
    if (batch.length) {
      try { await upsertLeads(env, batch); total += batch.length; }
      catch (e) { firstError = e.message; console.error(`[${accountId}] upsert error: ${firstError}`); break; }
    }

    // BUG fix 26/05: CW retorna 15 itens/página apesar do PAGE_SIZE=25 (bug documentado).
    // O break por `page * PAGE_SIZE >= cnt` quebrava cedo, deixando 30-40% dos contatos
    // não vistos — e o reconcile no full refresh DELETAVA esses como "stale".
    // Solução: SÓ confiar em items.length para detectar fim das páginas.
    if (items.length === 0) break;
    if (stop) break;

    page++;
    await sleep(SLEEP_PAGE_MS);
  }

  // Full refresh: reconcile (DELETE leads que não vieram nessa sync — perderam a tag no CW).
  // Só faz se NÃO houve erro no fetch — senão pode deletar erroneamente.
  let reconciled = 0;
  if (force && !firstError && seenIds) {
    try { reconciled = await reconcileAccount(env, accountId, seenIds); }
    catch (e) { console.error(`[${accountId}] reconcile error: ${e.message}`); }
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

  console.log(`[${accountId}] done +${total} leads, -${reconciled} stale (${firstError ? 'with error' : 'clean'})`);
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

// Fan-out: dispara /run-account pra cada conta como invocação separada do worker.
// Cada uma ganha seu próprio orçamento de CPU (~30s) — assim 32 contas processam
// em paralelo sem estourar o limit do scheduler.
async function fanOutAccounts(env, force) {
  let units;
  try { units = await listUnits(env); }
  catch (e) { console.error('[fan-out] listUnits failed:', e.message); return; }
  const DELAY_BETWEEN_INVOCATIONS_MS = 800; // throttle CW: ~1.25 req/s no fan-out
  let dispatched = 0, errors = 0;
  for (let i = 0; i < units.length; i++) {
    const accId = Number(units[i].chatwoot_account_id);
    if (!accId) continue;
    if (i > 0) await sleep(DELAY_BETWEEN_INVOCATIONS_MS);
    try {
      const url = `${SELF_URL}/run-account?accountId=${accId}&force=${force}`;
      // Não aguardar resposta — o handler /run-account usa ctx.waitUntil pra processar async
      const r = await fetch(url, { method: 'POST', headers: { 'x-admin-token': env.ADMIN_TOKEN || '' }});
      if (!r.ok) { errors++; console.error(`[fan-out] ${accId} status=${r.status}`); }
      else { dispatched++; }
    } catch (e) {
      errors++;
      console.error(`[fan-out] ${accId} ${e.message}`);
    }
  }
  console.log(`[fan-out] dispatched=${dispatched} errors=${errors} (force=${force})`);
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
