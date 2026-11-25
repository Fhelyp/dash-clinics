// Sessão revogável (functions/_lib/sessao.js + _middleware.js + api/logout.js), com fetch e Cache API simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';
import { onRequestPost as logout } from '../functions/api/logout.js';
import { signJWT, sha256Hex } from '../functions/_lib/auth.js';
import { sessaoRevogada } from '../functions/_lib/sessao.js';

const SECRET = 'test-secret-local';
const env = { JWT_SECRET: SECRET, SUPABASE_URL: 'https://supa.test', SUPABASE_SERVICE_ROLE: 'x' };
const claims = { email: 'a@x', role: 'viewer', allowed_clinic_ids: ['c1'] };

// Estado simulado: hashes revogados no "banco", chamadas feitas e o cache.
let revogados, chamadas, store, modo;
function reset() {
  revogados = new Set(); chamadas = []; store = new Map(); modo = 'normal';
  globalThis.caches = { default: {
    match: async (r) => store.get(r.url)?.clone(),
    put: async (r, res) => { store.set(r.url, res); },
    delete: async (r) => store.delete(r.url),
  } };
  globalThis.fetch = async (url, init = {}) => {
    chamadas.push({ url, method: init.method || 'GET' });
    if (modo === 'fora') throw new Error('rede');
    if (modo === '500') return new Response('erro', { status: 500 });
    if (modo === 'lixo') return new Response(JSON.stringify([{ id: 1 }, { email: 'z' }]));
    if (modo === 'objeto') return new Response(JSON.stringify({ message: 'x' }));
    const m = /token_hash=eq\.([0-9a-f]+)/.exec(url);
    if ((init.method || 'GET') === 'PATCH') { revogados.add(m[1]); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify(m && revogados.has(m[1]) ? [{ token_hash: m[1] }] : []));
  };
}

async function api(path, token) {
  const request = new Request('https://dash.test' + path, { headers: { Authorization: 'Bearer ' + token } });
  const res = await onRequest({ request, env, data: {}, next: async () => new Response('NEXT') });
  return { status: res.status, body: await res.text() };
}

test('sessão ativa passa; a consulta vai para o cache', async () => {
  reset();
  const tok = await signJWT(claims, SECRET, 3600);
  assert.equal((await api('/api/dashboard/funnel', tok)).status, 200);
  assert.equal((await api('/api/dashboard/stats', tok)).status, 200);
  assert.equal(chamadas.length, 1, 'segunda requisição sai do cache');
});

test('depois do logout a mesma sessão recebe 401 (session_revoked)', async () => {
  reset();
  const tok = await signJWT(claims, SECRET, 3600);
  assert.equal((await api('/api/dashboard/funnel', tok)).status, 200); // põe "ativa" no cache
  const out = await logout({ request: new Request('https://dash.test/api/logout', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok } }), env });
  assert.equal(out.status, 200);
  assert.ok(revogados.has(await sha256Hex(tok)), 'logout revoga o token Bearer');
  const r = await api('/api/dashboard/funnel', tok);
  assert.equal(r.status, 401);
  assert.match(r.body, /session_revoked/);
});

test('logout revoga cookie e Bearer quando vêm os dois', async () => {
  reset();
  const a = await signJWT({ ...claims, n: 1 }, SECRET, 3600);
  const b = await signJWT({ ...claims, n: 2 }, SECRET, 3600);
  await logout({ request: new Request('https://dash.test/api/logout', {
    method: 'POST', headers: { cookie: 'dc_session=' + a, Authorization: 'Bearer ' + b } }), env });
  assert.ok(revogados.has(await sha256Hex(a)) && revogados.has(await sha256Hex(b)));
});

test('revogada não bloqueia /api/logout nem páginas', async () => {
  reset();
  const tok = await signJWT(claims, SECRET, 3600);
  revogados.add(await sha256Hex(tok));
  assert.equal((await api('/api/logout', tok)).status, 200);
  assert.equal((await api('/regras-de-negocio.html', tok)).status, 200);
});

test('banco fora, erro 500 ou resposta estranha: não derruba ninguém', async () => {
  for (const m of ['fora', '500', 'objeto', 'lixo']) {
    reset(); modo = m;
    const tok = await signJWT(claims, SECRET, 3600);
    assert.equal((await api('/api/dashboard/funnel', tok)).status, 200, m);
    // falha não vai para o cache; lista sem a sessão é resposta válida ("ativa")
    assert.equal(store.size, m === 'lixo' ? 1 : 0, m);
  }
});

test('sem configuração do Supabase (ambiente de teste/local) não consulta', async () => {
  reset();
  const tok = await signJWT(claims, SECRET, 3600);
  assert.equal(await sessaoRevogada({ JWT_SECRET: SECRET }, tok), false);
  assert.equal(chamadas.length, 0);
});

test('sem Cache API ainda funciona (consulta toda vez)', async () => {
  reset();
  delete globalThis.caches;
  const tok = await signJWT(claims, SECRET, 3600);
  revogados.add(await sha256Hex(tok));
  assert.equal(await sessaoRevogada(env, tok), true);
  assert.equal(await sessaoRevogada(env, tok), true);
  assert.equal(chamadas.length, 2);
});
