// Visão do operador (reunião de 05/11/2026 — Anne, Ramon, Isa, Luã).
// Quem é AGENTE (não administrador) no Chatwoot das unidades passa a entrar no dash vendo só
// Marketing (funil de campanha e ações do CRC) e Auditoria, só das unidades que atende, e só
// quantidades: a comissão do operador é por % de agendamento/comparecimento ("só a quantidade",
// Ramon). Tudo aplicado no SERVIDOR; o front só esconde o que o servidor já não manda.
//
// Desligar a visão de vez: OPERADOR_LIBERADO = false e deploy. Quem já tem sessão de operador
// recebe 403 na hora (o middleware confere), sem esperar o token expirar.
import { supaSelect } from './supabase.js';

export const OPERADOR_LIBERADO = true;
// false = o operador não recebe nenhum valor em R$ (receita, pago, total_pago...)
export const OPERADOR_VE_VALORES = false;

// Únicas APIs que o operador pode chamar (o resto dá 403): funil de campanha, ações do CRC,
// auditoria, unidades e a própria sessão. /api/dashboard/stats (Overview e Financeiro) fica fora.
export const OPERADOR_APIS = new Set([
  '/api/me',
  '/api/logout',
  '/api/dashboard/lookups',
  '/api/dashboard/funnel',
  '/api/dashboard/funnel-detail',
  '/api/dashboard/funnel-resgate',
  '/api/dashboard/funnel-resgate-detail',
  '/api/dashboard/appointments',
  '/api/dashboard/audit-events',
]);

export function ehOperador(user) {
  return !!user && user.role === 'operador';
}

// Unidades (Dash=true) das contas do Chatwoot em que a pessoa está ativa (agente/supervisor).
// Mesmo mapa do admin: unitConfigs.chatwoot_account_id ↔ Ecuro_clinicId. Lança erro se a
// consulta falhar (quem chama responde 500 — nunca falha aberta).
export async function unidadesDasContas(env, accountIds) {
  const ids = (accountIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return [];
  const rows = await supaSelect(
    env, 'unitConfigs',
    `select=Ecuro_clinicId,chatwoot_account_id&chatwoot_account_id=in.(${ids.join(',')})&Dash=is.true`
  );
  return rows.map(r => r.Ecuro_clinicId).filter(Boolean);
}

const CHAVES_VALOR = new Set(['receita', 'receita_total', 'total_pago', 'pago', 'amount', 'valor', 'revenue']);

// Remove, em qualquer profundidade, os campos em R$ de uma resposta JSON.
export function semValores(x) {
  if (Array.isArray(x)) return x.map(semValores);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      if (CHAVES_VALOR.has(k)) continue;
      out[k] = semValores(v);
    }
    return out;
  }
  return x;
}

// Texto JSON da RPC → texto que pode ir para este usuário.
export function paraUsuario(txt, user) {
  if (!ehOperador(user) || OPERADOR_VE_VALORES) return txt;
  try { return JSON.stringify(semValores(JSON.parse(txt))); }
  catch (_) { return JSON.stringify({ error: 'resposta_invalida' }); }
}
