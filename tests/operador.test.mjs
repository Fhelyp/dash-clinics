// Visão do operador (05/11/2026): quem é só AGENTE no Chatwoot entra como 'operador', vê só
// Marketing + Auditoria das suas unidades e nenhum valor em R$. Rodar: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';
import { onRequestPost as loginPost } from '../functions/api/login.js';
import { signJWT, verifyJWT } from '../functions/_lib/auth.js';
import { semValores, paraUsuario, OPERADOR_APIS } from '../functions/_lib/acesso.js';
import { onRequestGet as resgateGet } from '../functions/api/dashboard/funnel-resgate.js';

const SECRET = 'test-secret-local';
const env = { JWT_SECRET: SECRET, SUPABASE_URL: 'https://supa.test', SUPABASE_SERVICE_ROLE: 'x',
              CHATWOOT_BASE_URL: 'https://cw.test', JWT_TTL_HOURS: '12' };

async function mw(path, claims) {
  const request = new Request('https://dash.test' + path, { headers: { Authorization: 'Bearer ' + await signJWT(claims, SECRET, 3600) } });
  const res = await onRequest({ request, env, data: {}, next: async () => new Response('NEXT') });
  return res.status;
}
const OPER = { email: 'op@x', role: 'operador', allowed_clinic_ids: ['c1'] };

test('middleware: operador só alcança as APIs de Marketing e Auditoria', async () => {
  for (const p of OPERADOR_APIS) assert.equal(await mw(p, OPER), 200, p);
  for (const p of ['/api/dashboard/stats', '/api/change-password', '/api/dashboard/qualquer-nova', '/api/data/BI%20Payments'])
    assert.equal(await mw(p, OPER), 403, p);
});

test('middleware: admin/líder continua com tudo (stats inclusive)', async () => {
  assert.equal(await mw('/api/dashboard/stats', { email: 'l@x', role: 'viewer', allowed_clinic_ids: ['c1'] }), 200);
  assert.equal(await mw('/api/dashboard/stats', { email: 'a@x', role: 'admin', allowed_clinic_ids: null }), 200);
});

test('semValores tira R$ em qualquer profundidade e mantém as quantidades', () => {
  const x = { funnel: { agendados: 3, venderam: 2, receita_total: 900 },
              buckets: { lead_organico: { agendados: 5, venderam: 1, receita: 10, pagamentos: 2 } },
              rows: [{ nome: 'A', pago: 5, total_pago: 7, n_pgto: 1 }], total_pago: 7 };
  assert.deepEqual(semValores(x), { funnel: { agendados: 3, venderam: 2 },
              buckets: { lead_organico: { agendados: 5, venderam: 1, pagamentos: 2 } },
              rows: [{ nome: 'A', n_pgto: 1 }] });
});

test('paraUsuario: só o operador perde os valores', () => {
  const txt = JSON.stringify({ funnel: { agendados: 1, receita_total: 50 } });
  assert.equal(paraUsuario(txt, { role: 'viewer' }), txt);
  assert.equal(paraUsuario(txt, null), txt);
  assert.deepEqual(JSON.parse(paraUsuario(txt, { role: 'operador' })), { funnel: { agendados: 1 } });
});

test('endpoint: operador recebe o bloco do CRC sem R$, também quando vem do cache', async () => {
  const store = new Map();
  globalThis.caches = { default: { match: async r => store.get(r.url)?.clone(), put: async (r, res) => { store.set(r.url, res); } } };
  globalThis.fetch = async () => new Response(JSON.stringify({ buckets: { indicacao: { agendados: 4, receita: 99.5 } } }));
  const req = () => new Request('https://dash.test/api/dashboard/funnel-resgate?start=2026-10-01&end=2026-11-01');
  const lider = await (await resgateGet({ request: req(), env, data: { user: { role: 'viewer', allowed_clinic_ids: ['c1'] } } })).json();
  assert.equal(lider.buckets.indicacao.receita, 99.5);
  const r = await resgateGet({ request: req(), env, data: { user: OPER } });   // mesmo escopo → HIT
  assert.equal(r.headers.get('X-Cache'), 'HIT');
  assert.deepEqual(await r.json(), { buckets: { indicacao: { agendados: 4 } } });
});

// ── login: Chatwoot + Supabase simulados ──
function mockLogin({ accounts, authUser = { id: 'u1', email: 'op@x', role: 'viewer', active: true }, units }) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); seen.push(u);
    if (u.endsWith('/auth/sign_in'))
      return new Response(JSON.stringify({ data: { id: 9, email: 'op@x', name: 'Operadora X', accounts } }), { status: 200 });
    if (u.includes('/rest/v1/auth_users?')) return new Response(JSON.stringify(authUser ? [authUser] : []), { status: 200 });
    if (u.includes('/rest/v1/unitConfigs?')) {
      const m = /chatwoot_account_id=in\.\(([^)]*)\)/.exec(decodeURIComponent(u));
      const ids = m ? m[1].split(',').map(Number) : [];
      return new Response(JSON.stringify(units.filter(x => ids.includes(x.chatwoot_account_id))), { status: 200 });
    }
    return new Response('', { status: 201 });  // auth_sessions / last_login_at
  };
  return seen;
}
async function login() {
  const request = new Request('https://dash.test/api/login', { method: 'POST', body: JSON.stringify({ email: 'op@x', password: 'senha-de-teste' }) });
  const res = await loginPost({ request, env });
  const body = await res.json();
  const cookie = res.headers.get('Set-Cookie') || '';
  const tok = /dc_session=([^;]+)/.exec(cookie)?.[1];
  return { status: res.status, body, claims: tok ? await verifyJWT(tok, SECRET) : null };
}
const UNITS = [{ Ecuro_clinicId: 'c1', chatwoot_account_id: 1 }, { Ecuro_clinicId: 'c2', chatwoot_account_id: 2 }, { Ecuro_clinicId: 'c3', chatwoot_account_id: 3 }];

test('login: agente no Chatwoot entra como operador, só nas contas em que atende', async () => {
  mockLogin({ accounts: [{ id: 1, role: 'agent', status: 'active' }, { id: 3, role: 'agent', status: 'active' }, { id: 2, role: 'agent', status: 'inactive' }], units: UNITS });
  const r = await login();
  assert.equal(r.status, 200);
  assert.equal(r.claims.role, 'operador');
  assert.deepEqual(r.claims.allowed_clinic_ids.sort(), ['c1', 'c3']);   // conta 2 inativa fica fora
  assert.equal(r.body.user.role, 'operador');
});

test('login: admin de uma conta continua líder (não vira operador)', async () => {
  mockLogin({ accounts: [{ id: 1, role: 'administrator', status: 'active' }, { id: 2, role: 'agent', status: 'active' }], units: UNITS });
  const r = await login();
  assert.equal(r.status, 200);
  assert.equal(r.claims.role, 'viewer');
  assert.deepEqual(r.claims.allowed_clinic_ids, ['c1']);
});

test('login: agente de conta sem unidade no dash é negado', async () => {
  mockLogin({ accounts: [{ id: 77, role: 'agent', status: 'active' }], units: UNITS });
  const r = await login();
  assert.equal(r.status, 403);
  assert.equal(r.claims, null);
});

test('login: usuário desativado continua bloqueado mesmo sendo agente', async () => {
  mockLogin({ accounts: [{ id: 1, role: 'agent', status: 'active' }], units: UNITS, authUser: { id: 'u2', email: 'op@x', role: 'viewer', active: false } });
  const r = await login();
  assert.equal(r.status, 403);
});

test('login: escopo salvo (allowed_clinic_ids) ainda vence o de agente', async () => {
  mockLogin({ accounts: [{ id: 1, role: 'agent', status: 'active' }], units: UNITS,
              authUser: { id: 'u3', email: 'op@x', role: 'viewer', active: true, allowed_clinic_ids: ['c9'] } });
  const r = await login();
  assert.equal(r.status, 200);
  assert.equal(r.claims.role, 'viewer');
  assert.deepEqual(r.claims.allowed_clinic_ids, ['c9']);
});

// ── SSO do hub GCI (caminho das operadoras no embed) ──
import { onRequestPost as ssoPost } from '../functions/api/sso.js';
test('sso: agente entra como operador; admin continua líder', async () => {
  for (const [accounts, papel, escopo] of [
    [[{ id: 2, role: 'agent', status: 'active' }], 'operador', ['c2']],
    [[{ id: 1, role: 'administrator', status: 'active' }, { id: 2, role: 'agent', status: 'active' }], 'viewer', ['c1']],
  ]) {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/profile')) return new Response(JSON.stringify({ id: 9, email: 'op@x', name: 'Op', accounts }), { status: 200 });
      if (u.includes('/rest/v1/auth_users?')) return new Response(JSON.stringify([{ id: 'u1', email: 'op@x', role: 'viewer', active: true }]), { status: 200 });
      if (u.includes('/rest/v1/unitConfigs?')) {
        const m = /chatwoot_account_id=in\.\(([^)]*)\)/.exec(decodeURIComponent(u));
        const ids = m ? m[1].split(',').map(Number) : [];
        return new Response(JSON.stringify(UNITS.filter(x => ids.includes(x.chatwoot_account_id))), { status: 200 });
      }
      return new Response('', { status: 201 });
    };
    const res = await ssoPost({ request: new Request('https://dash.test/api/sso', { method: 'POST', body: JSON.stringify({ cred: { api_access_token: 'tok-teste' } }) }), env });
    assert.equal(res.status, 200);
    const body = await res.json();
    const claims = await verifyJWT(body.token, SECRET);
    assert.equal(claims.role, papel);
    assert.deepEqual(claims.allowed_clinic_ids, escopo);
  }
});
