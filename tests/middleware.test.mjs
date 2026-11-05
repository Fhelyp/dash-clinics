// Testes do _middleware.js (escopo de acesso). Rodar: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';
import { signJWT } from '../functions/_lib/auth.js';

const SECRET = 'test-secret-local';
const env = { JWT_SECRET: SECRET };

async function call(path, claims, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (claims) headers.Authorization = 'Bearer ' + await signJWT(claims, SECRET, 3600);
  const request = new Request('https://dash.test' + path, { headers });
  const ctx = { request, env, data: {}, next: async () => new Response('NEXT', { status: 200 }) };
  const res = await onRequest(ctx);
  return { status: res.status, body: await res.text(), ctx };
}

test('sem token: API dá 401', async () => {
  const r = await call('/api/dashboard/funnel', null);
  assert.equal(r.status, 401);
});

test('escopo com unidades: passa e expõe o usuário', async () => {
  const r = await call('/api/dashboard/funnel', { email: 'a@x', role: 'viewer', allowed_clinic_ids: ['c1'] });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'NEXT');
  assert.deepEqual(r.ctx.data.user.allowed_clinic_ids, ['c1']);
});

test('unrestricted (null): passa', async () => {
  const r = await call('/api/dashboard/stats', { email: 'adm@x', role: 'admin', allowed_clinic_ids: null });
  assert.equal(r.status, 200);
});

test('escopo VAZIO não vira acesso total: 403 na API', async () => {
  for (const scope of [[], [null], ['']]) {
    const r = await call('/api/dashboard/stats', { email: 'b@x', role: 'viewer', allowed_clinic_ids: scope });
    assert.equal(r.status, 403, JSON.stringify(scope));
    assert.match(r.body, /no_clinic_access/);
  }
});

test('escopo vazio ainda consegue sair (logout)', async () => {
  const r = await call('/api/logout', { email: 'b@x', role: 'viewer', allowed_clinic_ids: [] });
  assert.equal(r.status, 200);
});
