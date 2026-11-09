// Testes dos endpoints do bloco "Ações do CRC" com fetch/caches simulados. Rodar: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as statsGet } from '../functions/api/dashboard/funnel-resgate.js';
import { onRequestGet as detailGet } from '../functions/api/dashboard/funnel-resgate-detail.js';

const env = { SUPABASE_URL: 'https://supa.test', SUPABASE_SERVICE_ROLE: 'x' };
let calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => store.get(req.url)?.clone(),
  put: async (req, res) => { store.set(req.url, res); }
} };

const user = (allowed) => ({ user: { email: 'u@x', allowed_clinic_ids: allowed } });
const req = (path) => new Request('https://dash.test' + path);

test('stats: chama crc_acoes_stats e só com as unidades do escopo', async () => {
  calls = []; store.clear();
  const r = await statsGet({ request: req('/api/dashboard/funnel-resgate?start=2026-10-01&end=2026-11-01&clinic_ids=A,Z'), env, data: user(['A','B']) });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rpc\/crc_acoes_stats$/);
  assert.deepEqual(calls[0].body.p_clinic_ids, ['A']);           // Z fora do escopo é descartada
  assert.equal(calls[0].body.p_agent_mode, 'ALL');
  assert.equal(calls[0].body.p_creators, null);
});

test('stats: sem filtro de unidade usa o escopo inteiro; fora do escopo vira __none__', async () => {
  calls = []; store.clear();
  await statsGet({ request: req('/api/dashboard/funnel-resgate?start=2026-10-01&end=2026-11-01'), env, data: user(['A','B']) });
  assert.deepEqual(calls[0].body.p_clinic_ids, ['A','B']);
  await statsGet({ request: req('/api/dashboard/funnel-resgate?start=2026-10-01&end=2026-11-01&clinic_ids=Z'), env, data: user(['A','B']) });
  assert.deepEqual(calls[1].body.p_clinic_ids, ['__none__']);
});

test('stats: repassa operador (creators com |) e agent_mode', async () => {
  calls = []; store.clear();
  await statsGet({ request: req('/api/dashboard/funnel-resgate?start=2026-10-01&end=2026-11-01&creators=Ana%20Paula|Maria,%20Jr&agent_mode=HUM'), env, data: user(null) });
  assert.deepEqual(calls[0].body.p_creators, ['Ana Paula', 'Maria, Jr']);
  assert.equal(calls[0].body.p_agent_mode, 'HUM');
  assert.equal(calls[0].body.p_clinic_ids, null);
});

test('stats: cache isola por escopo (mesma URL, usuários diferentes não compartilham)', async () => {
  calls = []; store.clear();
  const path = '/api/dashboard/funnel-resgate?start=2026-10-01&end=2026-11-01';
  const a = await statsGet({ request: req(path), env, data: user(['A']) });
  const b = await statsGet({ request: req(path), env, data: user(['B']) });
  const a2 = await statsGet({ request: req(path), env, data: user(['A']) });
  assert.equal(a.headers.get('X-Cache'), 'MISS');
  assert.equal(b.headers.get('X-Cache'), 'MISS');
  assert.equal(a2.headers.get('X-Cache'), 'HIT');
  assert.equal(calls.length, 2);
});

test('stats: datas inválidas dão 400 sem chamar o banco', async () => {
  calls = [];
  const r = await statsGet({ request: req('/api/dashboard/funnel-resgate?start=2026-10-01&end=amanha'), env, data: user(['A']) });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('detail: vertente/etapa fora da lista dão 400', async () => {
  calls = [];
  for (const q of ['bucket=lead_campanha&stage=agendados', 'bucket=resgate&stage=leads', 'bucket=x;drop&stage=agendados']) {
    const r = await detailGet({ request: req('/api/dashboard/funnel-resgate-detail?start=2026-10-01&end=2026-11-01&' + q), env, data: user(['A']) });
    assert.equal(r.status, 400, q);
  }
  assert.equal(calls.length, 0);
});

test('detail: chama crc_acoes_detail com escopo, operador e limite saneado', async () => {
  calls = [];
  const r = await detailGet({ request: req('/api/dashboard/funnel-resgate-detail?start=2026-10-01&end=2026-11-01&bucket=lead_organico&stage=receita&clinic_ids=B,Q&limit=999999&offset=-5&agent_mode=MC'), env, data: user(['A','B']) });
  assert.equal(r.status, 200);
  assert.match(calls[0].url, /\/rpc\/crc_acoes_detail$/);
  assert.equal(calls[0].body.p_bucket, 'lead_organico');
  assert.equal(calls[0].body.p_stage, 'receita');
  assert.deepEqual(calls[0].body.p_clinic_ids, ['B']);
  assert.equal(calls[0].body.p_agent_mode, 'MC');
  assert.equal(calls[0].body.p_limit, 1000);
  assert.equal(calls[0].body.p_offset, 0);
});

// ── Filtros de 09/11: Origem no funil; Especialidade e Origem nas ações do CRC ──
import { onRequestGet as funnelGet } from '../functions/api/dashboard/funnel.js';
import { onRequestGet as funnelDetailGet } from '../functions/api/dashboard/funnel-detail.js';

test('funil: repassa a Origem (canal do paciente) e não a confunde com o canal do drill', async () => {
  calls = []; store.clear();
  await funnelGet({ request: req('/api/dashboard/funnel?start=2026-10-01&end=2026-11-01&origem=CRC,Fachada'), env, data: user(['A']) });
  assert.deepEqual(calls[0].body.p_origem, ['CRC', 'Fachada']);
  calls = [];
  await funnelDetailGet({ request: req('/api/dashboard/funnel-detail?start=2026-10-01&end=2026-11-01&stage=agendados&origem=Fachada&canal=CRC'), env, data: user(['A']) });
  assert.deepEqual(calls[0].body.p_origem, ['Fachada']);          // filtro global
  assert.deepEqual(calls[0].body.p_origem_channels, ['CRC']);     // chips do drill
});

test('funil: sem filtro de origem manda null (resultado igual ao de antes)', async () => {
  calls = []; store.clear();
  await funnelGet({ request: req('/api/dashboard/funnel?start=2026-10-01&end=2026-11-01'), env, data: user(['A']) });
  assert.equal(calls[0].body.p_origem, null);
});

test('CRC: repassa Especialidade e Origem (stats e drill); a chave de cache muda com o filtro', async () => {
  calls = []; store.clear();
  const base = '/api/dashboard/funnel-resgate?start=2026-10-01&end=2026-11-01';
  await statsGet({ request: req(base), env, data: user(['A']) });
  await statsGet({ request: req(base + '&specialty_ids=7f945176-078f-448e-aa9b-6d5cd95961e7&origem=Indica%C3%A7ao'), env, data: user(['A']) });
  assert.equal(calls.length, 2);                                   // não serviu o 2º do cache do 1º
  assert.equal(calls[0].body.p_specialty_ids, null);
  assert.deepEqual(calls[1].body.p_specialty_ids, ['7f945176-078f-448e-aa9b-6d5cd95961e7']);
  assert.deepEqual(calls[1].body.p_origem, ['Indicaçao']);
  calls = [];
  await detailGet({ request: req('/api/dashboard/funnel-resgate-detail?start=2026-10-01&end=2026-11-01&bucket=resgate_orto&stage=contatos&origem=CRC'), env, data: user(['A']) });
  assert.deepEqual(calls[0].body.p_origem, ['CRC']);
  assert.equal(calls[0].body.p_bucket, 'resgate_orto');
});
