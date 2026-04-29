import { verifyPassword, signJWT, makeAuthCookie, sha256Hex } from '../_lib/auth.js';
import { supaSelect, supaInsert, supaUpdate } from '../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return j(400, { error: 'invalid_json' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return j(400, { error: 'missing_fields' });

  const rows = await supaSelect(
    env, 'auth_users',
    `select=id,email,password_hash,role,active,must_change_password,display_name&email=eq.${encodeURIComponent(email)}`
  );
  const user = rows[0];
  if (!user || !user.active) return j(401, { error: 'invalid_credentials' });

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return j(401, { error: 'invalid_credentials' });

  const ttlHours = parseInt(env.JWT_TTL_HOURS || '12', 10);
  const ttl = ttlHours * 3600;
  const claims = {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.display_name || user.email,
    iss: env.JWT_ISSUER || 'dash-clinics'
  };
  const token = await signJWT(claims, env.JWT_SECRET, ttl);
  const tokenHash = await sha256Hex(token);

  const ua = request.headers.get('user-agent') || null;
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || null;

  await supaInsert(env, 'auth_sessions', [{
    user_id: user.id,
    token_hash: tokenHash,
    user_agent: ua,
    ip,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString()
  }], 'return=minimal');

  await supaUpdate(env, 'auth_users', `id=eq.${user.id}`, { last_login_at: new Date().toISOString() });

  return new Response(JSON.stringify({
    ok: true,
    user: { email: user.email, role: user.role, name: claims.name, must_change_password: user.must_change_password }
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
