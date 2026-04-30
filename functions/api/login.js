// Login com autenticação primária via Chatwoot.
// Fluxo:
//   1. Tenta autenticar contra /auth/sign_in do Chatwoot (fonte de verdade da senha)
//   2. Se Chatwoot OK → busca/auto-provisiona usuário em auth_users (role + active)
//   3. Se usuário ativo → emite JWT da nossa sessão
//   4. Se Chatwoot falhar e LOCAL_AUTH_FALLBACK=true → tenta hash local (compat)
//
// Vantagem: desativar/mudar senha no Chatwoot reflete imediatamente no dashboard.
import { verifyPassword, signJWT, makeAuthCookie, sha256Hex } from '../_lib/auth.js';
import { supaSelect, supaInsert, supaUpdate } from '../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  try {
    return await handle({ request, env });
  } catch (e) {
    return j(500, { error: 'server_error', message: String(e?.message || e), stack: String(e?.stack || '').split('\n').slice(0, 6) });
  }
}

async function chatwootSignIn(baseUrl, email, password) {
  if (!baseUrl) return { ok: false, reason: 'no_chatwoot_url' };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/sign_in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (res.status === 401 || res.status === 400) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (!res.ok) return { ok: false, reason: 'chatwoot_error', status: res.status };
    const data = await res.json().catch(() => null);
    const u = data?.data;
    if (!u || !u.email) return { ok: false, reason: 'unexpected_response' };
    return {
      ok: true,
      user: {
        id: u.id,
        email: String(u.email).toLowerCase(),
        name: u.name || u.available_name || u.email,
        confirmed: u.confirmed !== false,
        role: u.role || null
      }
    };
  } catch (e) {
    return { ok: false, reason: 'fetch_error', error: String(e?.message || e) };
  }
}

async function handle({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return j(400, { error: 'invalid_json' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return j(400, { error: 'missing_fields' });

  // ── 1. Autenticação contra Chatwoot ──────────────────────────────
  const cwUrl = env.CHATWOOT_BASE_URL || 'https://chatclinics.5ef4kt.easypanel.host';
  const cw = await chatwootSignIn(cwUrl, email, password);

  let authedViaCw = cw.ok;
  let cwUser = cw.ok ? cw.user : null;

  // ── 2. Fallback local (opt-in via env var, padrão: desligado) ─────
  if (!authedViaCw && env.LOCAL_AUTH_FALLBACK === 'true') {
    const rows = await supaSelect(
      env, 'auth_users',
      `select=id,email,password_hash,role,active,must_change_password,display_name&email=eq.${encodeURIComponent(email)}`
    );
    const local = rows[0];
    if (local && local.active && local.password_hash && local.password_hash !== '__chatwoot__') {
      const okLocal = await verifyPassword(password, local.password_hash);
      if (okLocal) {
        cwUser = { email: local.email, name: local.display_name || local.email, role: local.role };
      }
    }
  }

  if (!authedViaCw && !cwUser) return j(401, { error: 'invalid_credentials' });

  // ── 3. Lookup / auto-provision em auth_users (controle de acesso ao dashboard) ─
  let users = await supaSelect(
    env, 'auth_users',
    `select=id,email,role,active,must_change_password,display_name&email=eq.${encodeURIComponent(email)}`
  );
  let user = users[0];

  if (!user) {
    // Auto-provisiona com role=viewer. Admin promove depois se necessário.
    try {
      const inserted = await supaInsert(env, 'auth_users', [{
        email,
        password_hash: '__chatwoot__', // placeholder — auth real é via Chatwoot
        role: 'viewer',
        active: true,
        display_name: cwUser.name || email,
        must_change_password: false
      }], 'return=representation');
      user = (Array.isArray(inserted) ? inserted[0] : inserted) || {
        email, role: 'viewer', active: true, display_name: cwUser.name || email
      };
    } catch (e) {
      // Se inserção falhou, ainda permite acesso com defaults (Chatwoot já validou)
      user = { email, role: 'viewer', active: true, display_name: cwUser.name || email };
    }
  }

  if (!user.active) return j(403, { error: 'user_inactive', message: 'Usuário desativado.' });

  // ── 4. Emite JWT ───────────────────────────────────────────────────
  const ttlHours = parseInt(env.JWT_TTL_HOURS || '12', 10);
  const ttl = ttlHours * 3600;
  const claims = {
    sub: user.id || user.email,
    email: user.email,
    role: user.role,
    name: user.display_name || cwUser.name || user.email,
    iss: env.JWT_ISSUER || 'dash-clinics',
    auth: authedViaCw ? 'chatwoot' : 'local'
  };
  const token = await signJWT(claims, env.JWT_SECRET, ttl);
  const tokenHash = await sha256Hex(token);

  const ua = request.headers.get('user-agent') || null;
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || null;

  if (user.id) {
    await supaInsert(env, 'auth_sessions', [{
      user_id: user.id,
      token_hash: tokenHash,
      user_agent: ua,
      ip,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString()
    }], 'return=minimal').catch(() => {});

    await supaUpdate(env, 'auth_users', `id=eq.${user.id}`, {
      last_login_at: new Date().toISOString()
    }).catch(() => {});
  }

  return new Response(JSON.stringify({
    ok: true,
    user: {
      email: user.email,
      role: user.role,
      name: claims.name,
      must_change_password: user.must_change_password || false,
      auth_source: claims.auth
    }
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': makeAuthCookie(token, ttl)
    }
  });
}

function j(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
