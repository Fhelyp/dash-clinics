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
  // Retry só pra erros 5xx (servidor). 429 NÃO retry — não vale agravar
  // o rate limit que o CW aplica por email. Falha rápido com mensagem clara.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/sign_in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (res.status === 401 || res.status === 400) {
        return { ok: false, reason: 'invalid_credentials' };
      }
      // 429: NÃO retry — agrava o rate limit do CW. Falha imediato.
      if (res.status === 429) {
        return { ok: false, reason: 'chatwoot_unavailable', status: 429 };
      }
      // 5xx: 1 retry só (2s)
      if (res.status >= 500 && res.status < 600) {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return { ok: false, reason: 'chatwoot_unavailable', status: res.status };
      }
      if (!res.ok) return { ok: false, reason: 'chatwoot_error', status: res.status };
      return await parseSuccess(res);
    } catch (e) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      return { ok: false, reason: 'fetch_error', error: String(e?.message || e) };
    }
  }
}

async function parseSuccess(res) {
  try {
    const data = await res.json().catch(() => null);
    const u = data?.data;
    if (!u || !u.email) return { ok: false, reason: 'unexpected_response' };
    // accounts: array de {id, name, role, status, permissions, ...}
    // role pode ser 'administrator' | 'agent' | 'supervisor' (no nível do account)
    // user.type='SuperAdmin' tem acesso global no Chatwoot
    const accounts = Array.isArray(u.accounts) ? u.accounts : [];
    // REGRA (26/05): apenas accounts onde o user e ADMINISTRATOR sao consideradas
    // pro RBAC do dashboard. Agente nao ve dashboard daquela account, mesmo tendo
    // acesso ao Chatwoot dela.
    const adminAccountIds = accounts
      .filter(a => a && a.id != null && a.status !== 'inactive' && a.role === 'administrator')
      .map(a => Number(a.id))
      .filter(n => !isNaN(n));
    // accountIds = TODAS (admin+agente) — usado so pra debug/log, nao pro RBAC
    const allAccountIds = accounts
      .filter(a => a && a.id != null && a.status !== 'inactive')
      .map(a => Number(a.id))
      .filter(n => !isNaN(n));
    return {
      ok: true,
      user: {
        id: u.id,
        email: String(u.email).toLowerCase(),
        name: u.name || u.available_name || u.email,
        confirmed: u.confirmed !== false,
        role: u.role || null,
        type: u.type || null,
        // SuperAdmin = role GLOBAL no Chatwoot. role='administrator' e admin DA conta
        // (operador que gerencia 1 unidade no Chatwoot).
        is_super_admin: u.type === 'SuperAdmin',
        account_ids: adminAccountIds,       // usado pro RBAC
        all_account_ids: allAccountIds       // diagnostico
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

  // ── 2. Fallback local: usado quando CW falha e o user tem senha local valida.
  // Caso de uso: usuarios regionais que nao tem conta CW (ex: crcgoias regional='GO').
  // Sem env var gate — basta o user existir com password_hash != '__chatwoot__'.
  if (!authedViaCw) {
    const rows = await supaSelect(
      env, 'auth_users',
      `select=id,email,password_hash,role,active,must_change_password,display_name,regional&email=eq.${encodeURIComponent(email)}`
    );
    const local = rows[0];
    if (local && local.active && local.password_hash && local.password_hash !== '__chatwoot__') {
      const okLocal = await verifyPassword(password, local.password_hash);
      if (okLocal) {
        cwUser = {
          email: local.email,
          name: local.display_name || local.email,
          role: local.role,
          account_ids: [],
          all_account_ids: [],
          is_super_admin: false
        };
      }
    }
  }

  if (!authedViaCw && !cwUser) {
    // 429 do CW: rate limit por email/IP. Normalmente acontece após múltiplas
    // tentativas com senha errada. Mostra mensagem combinada (mais útil pro user).
    if (cw.reason === 'chatwoot_unavailable' && cw.status === 429) {
      return j(429, {
        error: 'rate_limited',
        message: 'Muitas tentativas de login. Verifique a senha e aguarde 1 minuto antes de tentar novamente.'
      });
    }
    if (cw.reason === 'chatwoot_unavailable' || cw.reason === 'chatwoot_error' || cw.reason === 'fetch_error') {
      return j(503, {
        error: 'auth_service_unavailable',
        message: 'Serviço de autenticação temporariamente indisponível. Tente em 1 minuto.',
        upstream_status: cw.status || null
      });
    }
    return j(401, { error: 'invalid_credentials' });
  }

  // ── 3. Lookup / auto-provision em auth_users (controle de acesso ao dashboard) ─
  let users = await supaSelect(
    env, 'auth_users',
    `select=id,email,role,active,must_change_password,display_name,regional,unrestricted&email=eq.${encodeURIComponent(email)}`
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

  // ── 3.5. Mapeia accounts do Chatwoot → clinic_ids permitidas (RBAC) ──
  // POLITICA (26/05): apenas auth_users.unrestricted=true tem acesso irrestrito.
  // Hoje somente admin@arvore.ia. Removido bypass por role='admin' e por
  // SuperAdmin do Chatwoot — eles devem passar pelo RBAC normal (CW admin accounts).
  // Override por regional: se user.regional='GO', acesso a todas unidades GO independente do CW.
  let allowedClinicIds = null; // null = sem restrição (UNICO caso: unrestricted=true)
  const isUnrestricted = user.unrestricted === true;
  const cwAccountIds = Array.isArray(cwUser.account_ids) ? cwUser.account_ids : [];
  const regionalOverride = user.regional && String(user.regional).trim();

  if (regionalOverride && !isUnrestricted) {
    // Override regional: ignora CW.account_ids, busca todas unidades da regional
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
      console.error('regional lookup failed:', e);
      return j(500, { error: 'rbac_error' });
    }
  } else if (!isUnrestricted && cwAccountIds.length > 0) {
    try {
      const ucRows = await supaSelect(
        env, 'unitConfigs',
        `select=Ecuro_clinicId,chatwoot_account_id&chatwoot_account_id=in.(${cwAccountIds.join(',')})`
      );
      allowedClinicIds = ucRows
        .map(r => r.Ecuro_clinicId)
        .filter(Boolean);
      // Se Chatwoot tem accounts admin mas nenhum bate com unitConfigs → nega acesso
      if (allowedClinicIds.length === 0) {
        return j(403, { error: 'no_clinic_access', message: 'Seu usuário no Chatwoot não tem clínica associada como administrador no dashboard.' });
      }
    } catch (e) {
      // Se erro no lookup, NUNCA falha aberta. Sem unrestricted, bloqueia.
      console.error('unitConfigs lookup failed:', e);
      if (!isUnrestricted) return j(500, { error: 'rbac_error' });
    }
  } else if (!isUnrestricted && cwAccountIds.length === 0) {
    // Caso: Chatwoot autenticou mas user nao e admin em NENHUMA account → nega
    return j(403, { error: 'no_admin_access', message: 'Você precisa ter permissão de administrador em pelo menos uma unidade no Chatwoot para acessar o dashboard.' });
  }

  // ── 4. Emite JWT ───────────────────────────────────────────────────
  const ttlHours = parseInt(env.JWT_TTL_HOURS || '12', 10);
  const ttl = ttlHours * 3600;
  const claims = {
    sub: user.id || user.email,
    email: user.email,
    role: user.role,
    name: user.display_name || cwUser.name || user.email,
    iss: env.JWT_ISSUER || 'dash-clinics',
    auth: authedViaCw ? 'chatwoot' : 'local',
    // null = acesso a todas as clínicas; array = restrito
    allowed_clinic_ids: allowedClinicIds,
    regional: regionalOverride || null,
    // Diagnóstico (apenas pra debug — pode remover depois)
    _debug: {
      cw_admin_account_ids: cwAccountIds,
      cw_all_account_ids: Array.isArray(cwUser.all_account_ids) ? cwUser.all_account_ids : [],
      cw_is_super: !!cwUser.is_super_admin,
      cw_role: cwUser.role || null,
      cw_type: cwUser.type || null,
      unrestricted: isUnrestricted,
      regional_override: regionalOverride || null
    }
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
