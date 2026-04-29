import { hashPassword, verifyPassword } from '../_lib/auth.js';
import { supaSelect, supaUpdate } from '../_lib/supabase.js';

export async function onRequestPost({ request, env, data }) {
  let body;
  try { body = await request.json(); } catch { return j(400, { error: 'invalid_json' }); }
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 8) return j(400, { error: 'weak_password' });

  const rows = await supaSelect(
    env, 'auth_users',
    `select=id,password_hash&id=eq.${data.user.sub}`
  );
  const u = rows[0];
  if (!u) return j(404, { error: 'not_found' });

  const ok = await verifyPassword(oldPassword, u.password_hash);
  if (!ok) return j(401, { error: 'invalid_old_password' });

  const newHash = await hashPassword(newPassword);
  await supaUpdate(env, 'auth_users', `id=eq.${u.id}`, {
    password_hash: newHash, must_change_password: false, updated_at: new Date().toISOString()
  });
  return j(200, { ok: true });
}

function j(s, b) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }
