// Cadastra (ou atualiza) o primeiro usuário admin no Supabase.
// Uso:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_ROLE=eyJhbGci... \
//   node scripts/seed-admin.mjs admin@suaclinica.com SuaSenha123
//
// Roda em Node 20+. Usa Web Crypto (crypto.subtle) que é nativo no Node 20.

const [, , emailArg, passwordArg, roleArg] = process.argv;
if (!emailArg || !passwordArg) {
  console.error('Uso: node scripts/seed-admin.mjs <email> <senha> [role=admin]');
  process.exit(1);
}
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE no ambiente.');
  process.exit(1);
}

const enc = new TextEncoder();
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ITER = 210000;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${ITER}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

const email = emailArg.trim().toLowerCase();
const role = roleArg || 'admin';
const password_hash = await hashPassword(passwordArg);

// Upsert por email
const url = `${SUPABASE_URL}/rest/v1/auth_users?on_conflict=email`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation'
  },
  body: JSON.stringify([{
    email, password_hash, role, active: true,
    must_change_password: false,
    display_name: email.split('@')[0]
  }])
});
const txt = await res.text();
if (!res.ok) {
  console.error(`Falhou (${res.status}):`, txt);
  process.exit(1);
}
console.log(`✅ Usuário ${email} criado/atualizado como ${role}.`);
