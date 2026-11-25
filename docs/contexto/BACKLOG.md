# Backlog

Lista viva, em ordem de prioridade. Cada item diz quem pode fazer: **Luã** (decisão ou acesso que só o dono
tem) ou **dev** (qualquer dev/IA, seguindo a [esteira](PROCESSO_DEPLOY.md)). Item novo entra aqui antes de
virar código.

## Regras para quem pega um item (inclusive automação)

- Só entra o que já foi combinado (reuniões, [DECISOES](../DECISOES_2026-11-05.md), este backlog) ou bug
  real com evidência. Regra de negócio nova é da gerência.
- Tudo vai para homolog. Produção só com autorização do Luã.
- Banco: só `SELECT` e `CREATE OR REPLACE FUNCTION`; consulta leve (um mês, uma rede) e fora do horário
  comercial. Chatwoot: só leitura. Nada que aumente a carga da madrugada.
- Não quebrar o que funciona: `npm test` verde, baseline antes/depois para qualquer número, drift == 0.

## P0: segurança e privacidade

| Item | Quem | Status |
|---|---|---|
| Repositório `dash-clinics` é **público** e o GitHub Pages publica tudo em `fhelyp.github.io/dash-clinics`. Tornar privado e desligar o Pages (o histórico do git ainda tem nomes de pacientes, tirados do HEAD em 24/11) | Luã | aberto |
| Trocar o `x-admin-token` da VPS e o webhook do EasyPanel, que estão em texto no README do `dash-sync-jobs` | Luã (EasyPanel) | aberto |
| Tópico do ntfy com nome previsível: alertas (nomes de unidade, contagens) legíveis por quem souber o nome. Usar nome aleatório ou token | Luã + dev | aberto |

## P1: confiabilidade e pedidos combinados

| Item | Quem | Status |
|---|---|---|
| Aplicar no banco os comentários sem nome de paciente de `nome_compativel` e `refresh_campaign_attribution` (código igual) | dev, na próxima promoção | aberto |
| Campos do Jordão sem dado: ID do Ecuro inválido em `unitConfigs` (read-only para nós) | Luã → quem mantém a Maria Clara | aberto |
| Visão do operador "só o meu" (casar usuário do Chatwoot ↔ criador no Ecuro) | dev | aberto |
| Funil/CRC ~16 s sem cache: pré-cálculo no rollup | dev (medir antes; não pesar a madrugada) | aberto |
| Sessão revogável (`auth_sessions.revoked_at` não é consultado) | dev | aberto |
| Data do lead: anúncios ainda só com data (sem mensagem no dia) | dev (só leitura) | ✅ verificado 24/11: out–nov, 38 de 7.484 (0,5%); 19 entram na conta; 1 por mês no dia 1º (único com risco de mudar de mês) |

## P2: dívida técnica

| Item | Quem | Status |
|---|---|---|
| `workers/` (sync antigo na Cloudflare) e `index.html` da raiz são legado: confirmar que nada usa e remover | dev | aberto |
| Funções legadas em `db/functions/` (v5, v6, `funnel_stats`, `dashboard_stats`): manter só o rollback (v6) | dev | aberto |
| `docs/HANDOFF.md` e `docs/NIGHT_SHIFT_2026-05-01.md` descrevem o estado de maio | dev | ✅ marcados como histórico (24/11) |
| CI no `dash-sync-jobs` (testes no PR, como aqui) | dev | PR Forux-Digital/dash-sync-jobs#24 (verde), aguarda merge |

## Feito recentemente

- 24/11: esteira (CI em PR, testes antes de cada deploy, conferência no ar, release por promoção); guardas de
  JS inline, SSO e segredos; drift das funções; docs de contexto; nomes de pacientes fora do HEAD.
- 24/11: alertas da VPS: cadastro inválido não é erro; `sync-chatwoot-agg` desligado; `validate-counts`
  só valida dia já sincronizado.
