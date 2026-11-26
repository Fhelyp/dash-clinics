# O produto: Dash Clínicas

## Em uma frase

O Dash Clínicas é o **número oficial** de marketing, comercial e auditoria da rede de clínicas
odontológicas atendida pela Clínicas Inteligentes (Árvore IA): mostra, por unidade e período, quantos
leads chegaram, quantos agendaram, compareceram e compraram, e quanto entrou de receita, com as regras
que a gerência aprovou.

Desde a reunião de lançamento de **05/11/2026**, a gerência usa o dash como fonte única ("sem controles
paralelos"). Regra nova ou exceção só entra com aprovação do Paulo/diretoria (Ramon, 05/11).

## Quem usa

| Perfil | O que vê | Como entra |
|---|---|---|
| Admin (Luã, Isa, conta Árvore IA) | Tudo, SP e GO | Login do Chatwoot ou SSO do hub GCI |
| Gerência (Ramon) | Tudo, SP e GO | Idem |
| Líderes regionais (Edina, Ellen, Cleber, Ingrid, Anne) e gerentes de unidade | Unidades da regional, só SP | Idem; chips "Regional <líder>" no filtro |
| Operador(a) do CRC | Só Marketing e Auditoria, só as unidades em que atende, **sem R$** | Agente/supervisor do Chatwoot sem conta admin (desde 05/11) |

Detalhe do controle de acesso: `functions/_lib/acesso.js`, `functions/_middleware.js` e
[AI_START_HERE](../AI_START_HERE.md).

## O que tem na tela

- **Overview:** KPIs da rede/unidade (agendamentos, comparecimentos, receita), pelo rollup diário.
- **Marketing:**
  - **Funil de campanha (v7):** leads → agendados → compareceram → venderam → receita, com duas
    visões: **Comissão** (cada etapa no mês em que aconteceu) e **Safra** (só os leads do mês).
  - **Resgate & Follow-up** e **Ações do CRC:** Resgate, Resgate Orto, Follow-Up Campanha/Orgânico,
    Lead Orgânico e Indicação, cada um com agendados, confirmados, compareceram, venderam e receita.
- **Financeiro:** receita vendida por origem e tipo.
- **Auditoria:** lista de agendamentos e eventos, para conferir caso a caso (com busca por telefone).
- **Regras de negócio** (`/regras-de-negocio.html`): todas as regras em linguagem de gestor + FAQ.

## As regras (fonte da verdade)

- Decisões da gerência: [DECISOES_2026-10-27](../DECISOES_2026-10-27.md) (10 temas) e
  [DECISOES_2026-11-05](../DECISOES_2026-11-05.md) (orgânico/indicação, orto, operador, mesmo dia).
- Regras técnicas: [BUSINESS_RULES](../BUSINESS_RULES.md).
- Página pública das regras: `public/regras-de-negocio.html`.
- Regra só muda pela gerência. Quem implementa registra no doc de decisões **e** na página de regras.

## Como os dados chegam

```
Ecuro (prontuário/agenda/financeiro) ──┐
                                       ├─► VPS EasyPanel «dash-sync-jobs» ─► Supabase ─► RPCs ─► Pages Functions ─► navegador
Chatwoot (leads, etiquetas, anúncio) ──┘    (crons noturnos, BRT)            (tabelas BI,   (funil, CRC,   (auth, RBAC,
                                                                              rollup)        stats)         sem R$ p/ operador)
```

- Atualização: **D-1**. O sync roda de madrugada; o dia de hoje só aparece amanhã.
- Tudo é calculado **no servidor** (RPCs no Supabase). O navegador nunca baixa a base, só recebe agregados
  (cláusula pétrea do projeto).
- Goiás (GO) não usa Chatwoot de propósito: funil zerado de leads em GO é esperado.
- Unidade com `Dash=false` na configuração não entra no sync, no rollup nem na tela.

## Onde está cada coisa

| Camada | Onde | Deploy |
|---|---|---|
| Front + APIs de auth | Este repo, Cloudflare Pages `dash-clinics` | PR → homolog → (autorização) → `main` |
| Números (funil, CRC, KPIs, rollup) | RPCs no Supabase, versionadas em `db/functions/` | Aplicadas no banco na promoção; `tests/sql/drift_funcoes.py` prova repo == banco |
| Sync | VPS EasyPanel, repo privado `Forux-Digital/dash-sync-jobs` | Merge no `main` + webhook do EasyPanel |

Mais: [OPERACAO](OPERACAO.md) (runbook), [PROCESSO_DEPLOY](PROCESSO_DEPLOY.md) (esteira),
[ROADMAP](ROADMAP.md), [BACKLOG](BACKLOG.md).
