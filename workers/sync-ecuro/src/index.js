// ════════════════════════════════════════════════════════════════════
//  Worker: sync-ecuro
//  - Cron diário (04:00 BRT) → puxa updatedAfter (ontem) das 32 clínicas
//  - Endpoint manual POST /backfill?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//    (protegido por ADMIN_TOKEN) para bootstrap histórico
// ════════════════════════════════════════════════════════════════════

const FEEDS = [
  { name: 'appointments',     path: '/bi/appointments',     table: 'BI Appointments' },
  { name: 'appointment_logs', path: '/bi/appointment-logs', table: 'BI Appointment Logs' },
  { name: 'payments',         path: '/bi/payments',         table: 'BI Payments' },
];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIncremental(env, { lookbackHours: 36 }));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/backfill' && req.method === 'POST') {
      if (env.ALLOW_MANUAL_BACKFILL !== 'true') return json({ error: 'disabled' }, 403);
      const auth = req.headers.get('x-admin-token') || '';
      if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);
      const startDate = url.searchParams.get('startDate');
      const endDate   = url.searchParams.get('endDate');
      const feeds     = (url.searchParams.get('feeds') || '').split(',').filter(Boolean);
      const onlyClinics = (url.searchParams.get('clinics') || '').split(',').filter(Boolean);
      if (!startDate || !endDate) return json({ error: 'missing startDate/endDate' }, 400);
      ctx.waitUntil(runBootstrap(env, { startDate, endDate, feeds, onlyClinics }));
      return json({ ok: true, message: 'backfill iniciado em background', startDate, endDate });
    }

    if (url.pathname === '/run-incremental' && req.method === 'POST') {
      const auth = req.headers.get('x-admin-token') || '';
      if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);
      ctx.waitUntil(runIncremental(env, { lookbackHours: parseInt(url.searchParams.get('lookbackHours') || '36', 10) }));
      return json({ ok: true, message: 'incremental iniciado' });
    }

    return json({ ok: true, name: 'sync-ecuro', endpoints: ['/health', 'POST /backfill', 'POST /run-incremental'] });
  }
};

// ── Helpers ─────────────────────────────────────────────────────────
function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

function supaHeaders(env, prefer = '') {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
}

async function listClinics(env) {
  const url = `${env.SUPABASE_URL}/rest/v1/unitConfigs?select=Unidade,Ecuro_clinicId&Ecuro_clinicId=not.is.null`;
  const r = await fetch(url, { headers: supaHeaders(env) });
  if (!r.ok) throw new Error(`unitConfigs select: ${r.status} ${await r.text()}`);
  return r.json(); // [{Unidade, Ecuro_clinicId}]
}

async function readSyncState(env, feed, clinicId) {
  const url = `${env.SUPABASE_URL}/rest/v1/sync_state?feed=eq.${feed}&clinic_id=eq.${clinicId}`;
  const r = await fetch(url, { headers: supaHeaders(env) });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function writeSyncState(env, row) {
  const url = `${env.SUPABASE_URL}/rest/v1/sync_state?on_conflict=feed,clinic_id`;
  await fetch(url, {
    method: 'POST',
    headers: supaHeaders(env, 'resolution=merge-duplicates,return=minimal'),
    body: JSON.stringify([row])
  });
}

// Upsert chunked
async function upsertRows(env, table, rows) {
  if (!rows.length) return 0;
  const url = `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?on_conflict=id`;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const r = await fetch(url, {
      method: 'POST',
      headers: supaHeaders(env, 'resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify(batch)
    });
    if (!r.ok) throw new Error(`upsert ${table}: ${r.status} ${await r.text()}`);
  }
  return rows.length;
}

// ── Ecuro fetch (suporta diferentes esquemas de auth) ──────────────
async function ecuroFetch(env, path, params) {
  const url = new URL(env.ECURO_BASE_URL + path);
  const headers = { Accept: 'application/json' };

  const mode = (env.ECURO_AUTH_MODE || 'header').toLowerCase();
  const headerName = env.ECURO_AUTH_HEADER || 'apiKey';
  if (mode === 'bearer') headers['Authorization'] = `Bearer ${env.ECURO_API_KEY}`;
  else if (mode === 'query') params = { ...params, [headerName]: env.ECURO_API_KEY };
  else headers[headerName] = env.ECURO_API_KEY;

  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Ecuro ${path} ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

// ── Sync run modes ──────────────────────────────────────────────────
async function runIncremental(env, { lookbackHours = 36 } = {}) {
  const clinics = await listClinics(env);
  // API Ecuro rejeita updatedAfter > 7 dias. Margem de 6 dias para garantir.
  const MAX_LOOKBACK_HOURS = 6 * 24;
  const safeHours = Math.min(lookbackHours, MAX_LOOKBACK_HOURS);
  const since = new Date(Date.now() - safeHours * 3600 * 1000).toISOString();
  console.log(`[incremental] ${clinics.length} clínicas, since=${since}`);

  for (const c of clinics) {
    const clinicId = c.Ecuro_clinicId;
    if (!clinicId) continue;
    for (const feed of FEEDS) {
      try {
        const state = await readSyncState(env, feed.name, clinicId);
        const updatedAfter = state?.last_updated_at || since;
        const total = await pullAndUpsert(env, feed, clinicId, { mode: 'incremental', updatedAfter });
        await writeSyncState(env, {
          feed: feed.name, clinic_id: clinicId,
          last_updated_at: new Date().toISOString(),
          last_run_at: new Date().toISOString(),
          last_run_status: 'ok',
          last_run_error: null,
          rows_synced_total: (state?.rows_synced_total || 0) + total
        });
      } catch (e) {
        console.error(`[incremental][${c.Unidade}][${feed.name}]`, e.message);
        await writeSyncState(env, {
          feed: feed.name, clinic_id: clinicId,
          last_run_at: new Date().toISOString(),
          last_run_status: 'error', last_run_error: e.message.slice(0, 500)
        });
      }
    }
  }
  console.log('[incremental] done');
}

async function runBootstrap(env, { startDate, endDate, feeds = [], onlyClinics = [] }) {
  const clinics = await listClinics(env);
  const targets = (onlyClinics.length ? clinics.filter(c => onlyClinics.includes(c.Ecuro_clinicId)) : clinics);
  const targetFeeds = feeds.length ? FEEDS.filter(f => feeds.includes(f.name)) : FEEDS;
  console.log(`[bootstrap] ${targets.length} clínicas × ${targetFeeds.length} feeds, ${startDate}→${endDate}`);
  for (const c of targets) {
    for (const feed of targetFeeds) {
      try {
        const total = await pullAndUpsert(env, feed, c.Ecuro_clinicId, { mode: 'bootstrap', startDate, endDate });
        console.log(`[bootstrap][${c.Unidade}][${feed.name}] +${total}`);
      } catch (e) {
        console.error(`[bootstrap][${c.Unidade}][${feed.name}]`, e.message);
      }
    }
  }
  console.log('[bootstrap] done');
}

async function pullAndUpsert(env, feed, clinicId, opts) {
  let total = 0;
  let cursorValue = null, cursorId = null, page = 0;
  const LIMIT = 1000;
  const HARD_PAGE_LIMIT = 25;
  while (page < HARD_PAGE_LIMIT) {
    const params = { clinicId, limit: LIMIT };
    if (opts.mode === 'bootstrap') {
      params.startDate = opts.startDate; params.endDate = opts.endDate;
      if (cursorValue) params.cursorValue = cursorValue;
      if (cursorId)    params.cursorId    = cursorId;
    } else {
      // Incremental: cada página avança updatedAfter pro nextCursor.updatedAt
      params.updatedAfter = cursorValue || opts.updatedAfter;
      if (cursorId) params.cursorId = cursorId;
    }
    const j = await ecuroFetch(env, feed.path, params);
    const data = j?.data || {};
    const rows = data.rows || [];
    if (rows.length) {
      await upsertRows(env, feed.table, rows);
      total += rows.length;
    }
    if (!data.hasMore || !data.nextCursor) break;
    cursorValue = data.nextCursor.cursorValue || data.nextCursor.updatedAt;
    cursorId    = data.nextCursor.id;
    page++;
  }
  return total;
}
