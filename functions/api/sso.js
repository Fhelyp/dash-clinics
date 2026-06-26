// SSO do hub GCI: cria a sessão do dashboard a partir da credencial do Chatwoot
// (já validada no login único do hub), sem pedir senha de novo.
// Reusa o MESMO RBAC do login.js; valida o token via /auth/validate_token do Chatwoot.
// Cookie com SameSite=None p/ ser enviado dentro do iframe do hub (cross-site).
import { signJWT, sha256Hex } from '../_lib/auth.js';
import { supaSelect, supaInsert, supaUpdate } from '../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  try {
    return await handle({ request, env });
  } catch (e) {
    return j(500, { error: 'server_error', message: String(e?.message || e) });
  }
}

// Cookie de sessão para uso embedado (iframe). Mesmo nome do login normal.
// `Partitioned` (CHIPS): com o bloqueio de cookies de terceiros do Chrome, um Set-Cookie
// SameSite=None comum é descartado em iframe cross-site. Com Partitioned o cookie é gravado
// no "jar" particionado por site de topo (gci.arvore.party) e é enviado nas requisições do
// iframe — funciona inclusive em aba anônima / com cookies de terceiros bloqueados.
function embedCookie(token, ttl) {
  return `dc_session=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${ttl}`;
}

// Valida a credencial devise no Chatwoot e devolve o user no MESMO formato do sign_in.
async function chatwootValidate(baseUrl, cred) {
  if (!baseUrl) return { ok: false, reason: 'no_chatwoot_url' };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/validate_token`, {
      method: 'GET',
      headers: {
        'access-token': cred.access_token || '',
        'token-type': cred.token_type || 'Bearer',
        client: cred.client || '',
        uid: cred.uid || '',
        Accept: 'application/json'
      }
    });
    if (!res.ok) return { ok: false, reason: 'invalid_credentials', status: res.status };
    return await parseSuccess(res);
  } catch (e) {
    return { ok: false, reason: 'fetch_error', error: String(e?.message || e) };
  }
}

// Valida pelo token PESSOAL de API (api_access_token) via /api/v1/profile. Esse token NÃO
// rotaciona (ao contrário do devise de sessão, que o uso do Chatwoot embedado invalida) — é o
// caminho robusto, o mesmo que o Connect usa. /api/v1/profile devolve o user no nível raiz.
async function chatwootValidateProfile(baseUrl, apiToken) {
  if (!baseUrl || !apiToken) return { ok: false, reason: 'no_api_token' };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/profile`, {
      method: 'GET',
      headers: { api_access_token: apiToken, Accept: 'application/json' }
    });
    if (!res.ok) return { ok: false, reason: 'invalid_credentials', status: res.status };
    return await parseSuccess(res);
  } catch (e) {
    return { ok: false, reason: 'fetch_error', error: String(e?.message || e) };
  }
}

// Idêntico ao parseSuccess do login.js
async function parseSuccess(res) {
  try {
    const data = await res.json().catch(() => null);
    // Formatos: /auth/validate_token → `payload.data`; /auth/sign_in → `data`;
    // /api/v1/profile → o user no nível RAIZ. Trata os três.
    const u = (data && (data.payload?.data || data.data || data)) || null;
    if (!u || !u.email) return { ok: false, reason: 'unexpected_response' };
    const accounts = Array.isArray(u.accounts) ? u.accounts : [];
    const adminAccountIds = accounts
      .filter(a => a && a.id != null && a.status !== 'inactive' && a.role === 'administrator')
      .map(a => Number(a.id)).filter(n => !isNaN(n));
    const allAccountIds = accounts
      .filter(a => a && a.id != null && a.status !== 'inactive')
      .map(a => Number(a.id)).filter(n => !isNaN(n));
    return {
      ok: true,
      user: {
        id: u.id,
        email: String(u.email).toLowerCase(),
        name: u.name || u.available_name || u.email,
        confirmed: u.confirmed !== false,
        role: u.role || null,
        type: u.type || null,
        is_super_admin: u.type === 'SuperAdmin',
        account_ids: adminAccountIds,
        all_account_ids: allAccountIds
      }
    };
  } catch (e) {
    return { ok: false, reason: 'fetch_error', error: String(e?.message || e) };
  }
}

async function handle({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return j(400, { error: 'invalid_json' }); }
  const cred = body.cred || body || {};
  if (!cred.access_token && !cred.api_access_token) return j(400, { error: 'missing_cred' });

  // ── 1. Valida a credencial no Chatwoot (fonte de verdade) ──
  // Preferência: token PESSOAL de API (não rotaciona) → robusto. Fallback: devise de sessão.
  const cwUrl = env.CHATWOOT_BASE_URL || 'https://chatclinics.5ef4kt.easypanel.host';
  let cw = await chatwootValidateProfile(cwUrl, cred.api_access_token);
  if (!cw.ok && cred.access_token) cw = await chatwootValidate(cwUrl, cred);
  if (!cw.ok) return j(401, { error: 'invalid_credentials' });
  const cwUser = cw.user;
  const email = cwUser.email;

  // ── 2. Lookup / auto-provision em auth_users (igual ao login) ──
  let users = await supaSelect(
    env, 'auth_users',
    `select=id,email,role,active,must_change_password,display_name,regional,unrestricted,allowed_clinic_ids&email=eq.${encodeURIComponent(email)}`
  );
  let user = users[0];

  if (!user) {
    try {
      const inserted = await supaInsert(env, 'auth_users', [{
        email,
        password_hash: '__chatwoot__',
        role: 'viewer',
        active: true,
        display_name: cwUser.name || email,
        must_change_password: false
      }], 'return=representation');
      user = (Array.isArray(inserted) ? inserted[0] : inserted) || {
        email, role: 'viewer', active: true, display_name: cwUser.name || email
      };
    } catch (e) {
      user = { email, role: 'viewer', active: true, display_name: cwUser.name || email };
    }
  }

  if (!user.active) return j(403, { error: 'user_inactive', message: 'Usuário desativado.' });

  // ── 3. RBAC: accounts do Chatwoot → clinic_ids (idêntico ao login) ──
  let allowedClinicIds = null;
  const isUnrestricted = user.unrestricted === true;
  const cwAccountIds = Array.isArray(cwUser.account_ids) ? cwUser.account_ids : [];
  const regionalOverride = user.regional && String(user.regional).trim();

  const explicitClinicIds = Array.isArray(user.allowed_clinic_ids) && user.allowed_clinic_ids.length > 0
    ? user.allowed_clinic_ids.filter(Boolean) : null;
  if (explicitClinicIds && !isUnrestricted) {
    allowedClinicIds = explicitClinicIds;
  } else if (regionalOverride && !isUnrestricted) {
    try {
      const ucRows = await supaSelect(
        env, 'unitConfigs',
        `select=Ecuro_clinicId&regional=eq.${encodeURIComponent(regionalOverride)}&Ecuro_clinicId=not.is.null`
      );
      allowedClinicIds = ucRows.map(r => r.Ecuro_clinicId).filter(Boolean);
      if (allowedClinicIds.length === 0) {
        return j(403, { error: 'no_clinic_access', message: `Nenhuma clínica encontrada para a regional '${regionalOverride}'.` });
      }
    } catch (e) {
      return j(500, { error: 'rbac_error' });
    }
  } else if (!isUnrestricted && cwAccountIds.length > 0) {
    try {
      const ucRows = await supaSelect(
        env, 'unitConfigs',
        `select=Ecuro_clinicId,chatwoot_account_id&chatwoot_account_id=in.(${cwAccountIds.join(',')})`
      );
      allowedClinicIds = ucRows.map(r => r.Ecuro_clinicId).filter(Boolean);
      if (allowedClinicIds.length === 0) {
        return j(403, { error: 'no_clinic_access', message: 'Seu usuário no Chatwoot não tem clínica associada como administrador no dashboard.' });
      }
    } catch (e) {
      if (!isUnrestricted) return j(500, { error: 'rbac_error' });
    }
  } else if (!isUnrestricted && cwAccountIds.length === 0) {
    return j(403, { error: 'no_admin_access', message: 'Você precisa ter permissão de administrador em pelo menos uma unidade no Chatwoot para acessar o dashboard.' });
  }

  // ── 4. Emite JWT (idêntico ao login) ──
  const ttlHours = parseInt(env.JWT_TTL_HOURS || '12', 10);
  const ttl = ttlHours * 3600;
  const claims = {
    sub: user.id || user.email,
    email: user.email,
    role: user.role,
    name: user.display_name || cwUser.name || user.email,
    iss: env.JWT_ISSUER || 'dash-clinics',
    auth: 'chatwoot-sso',
    allowed_clinic_ids: allowedClinicIds,
    regional: regionalOverride || null
  };
  const token = await signJWT(claims, env.JWT_SECRET, ttl);
  const tokenHash = await sha256Hex(token);

  const ua = request.headers.get('user-agent') || null;
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || null;
  if (user.id) {
    await supaInsert(env, 'auth_sessions', [{
      user_id: user.id, token_hash: tokenHash, user_agent: ua, ip,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString()
    }], 'return=minimal').catch(() => {});
    await supaUpdate(env, 'auth_users', `id=eq.${user.id}`, { last_login_at: new Date().toISOString() }).catch(() => {});
  }

  // `token` no corpo: o gci-sso.js guarda em localStorage (particionado) e o SPA o envia como
  // Authorization: Bearer. Necessário no Safari, que NÃO grava/manda o cookie de terceiro do embed
  // (sem suporte a CHIPS/Partitioned). O cookie continua p/ Chrome e login direto (sem regressão).
  return new Response(JSON.stringify({
    ok: true,
    token,
    user: { email: user.email, role: user.role, name: claims.name }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': embedCookie(token, ttl) }
  });
}

function j(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
