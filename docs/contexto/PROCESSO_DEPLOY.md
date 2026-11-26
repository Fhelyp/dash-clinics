# Esteira: da mudança à produção

Toda mudança passa pelo GitHub, roda testes, é validada em **homolog** e só vai para **produção**
quando o Luã autoriza. Cada promoção vira uma **versão** (tag + release). Não existe deploy por fora.

```
branch ──► PR (CI: npm test) ──► homolog (testes + deploy + conferência) ──► validação
                                                                                 │ Luã autoriza
                                                                                 ▼
                         release vAAAA.MM.DD.N ◄── conferência no ar ◄── deploy prod ◄── merge no main
```

## Passo a passo (front, APIs e docs: este repo)

1. Parta do `main` atualizado: `git checkout main && git pull`, depois `git checkout -b tipo/assunto`
   (`feat/`, `fix/`, `docs/`).
2. Faça a mudança e rode `npm test` (só Node, sem instalar nada; menos de 1 s).
3. Abra o PR para o `main`. O workflow **CI** roda no PR e mostra ✔/✖.
4. Mande para homolog, de um destes jeitos:
   - Actions › **Deploy Homolog (preview)** › *Run workflow* › escolha a branch; ou
   - `git push origin tipo/assunto:homolog --force-with-lease` (a branch `homolog` é descartável: vale
     o que está deployado).

   O workflow roda os testes, publica em `https://homolog.dash-clinics.pages.dev` e confere a página
   no ar.
5. Valide em homolog: números, filtros, visão do operador (`/?ver=operador`), embed.
6. **Promoção (só com autorização do Luã):** merge do PR no `main`. O `deploy.yml`:
   1. roda os testes de novo (se falhar, nada vai ao ar);
   2. publica no Cloudflare Pages com o commit do `main`;
   3. confere produção no ar (`login.html` com `gci-sso.js`);
   4. cria a tag `vAAAA.MM.DD.N` e a release com a lista de PRs desde a versão anterior.
7. Confira em `https://dash-clinics.pages.dev`. A release fica em *Releases* no GitHub.

Dois merges seguidos não deployam juntos: o segundo espera (`concurrency: producao`).

## Funções do banco (RPCs em `db/functions/`)

O Supabase não tem homolog: o banco é um só, e funções novas valem para homolog **e** produção ao mesmo
tempo. Por isso:

- Mudança de **lógica** de número é testada antes, com `tests/sql/validar_*.py` (no banco real, só leitura),
  e comparada com um baseline: os mesmos cenários antes e depois.
- Quando possível, a função nova entra com **nome ou assinatura nova** (ex.: `funnel_v7_*` ao lado do v6).
  A tela só passa a usá-la no merge do front, e o rollback é voltar o endpoint para a função antiga.
- Mudança de assinatura: `DROP FUNCTION IF EXISTS` + `CREATE` na **mesma transação** e
  `NOTIFY pgrst, 'reload schema'`.
- Depois de aplicar: `python tests/sql/drift_funcoes.py --estrito` precisa dar `repo == banco`.
  "Só comentário" não reprova: é diferença só de comentário, e entra na próxima promoção.
- Permitido no banco: `SELECT` e `CREATE OR REPLACE FUNCTION`. Nunca alterar ou apagar dados ou tabelas.

## Sync (VPS): repositório `Forux-Digital/dash-sync-jobs` (privado)

1. Branch, PR e `npm test` (testes em `test/*.test.mjs`).
2. Merge no `main` com autorização.
3. Redeploy pelo webhook do EasyPanel (endereço **http**, no README do repo), fora do horário dos jobs
   (evitar 03h–07h30). Conferir `/status` (`GIT_SHA` novo) e o próximo ciclo dos jobs.

## Rollback

- Front: reverter o merge (`git revert -m 1 <merge>`, PR, merge). Sai uma release nova com o conteúdo
  anterior. Em emergência, o Cloudflare Pages permite "Rollback to this deployment" no painel; depois
  registrar o revert no git para o `main` continuar igual à produção.
- Funções: reaplicar a versão anterior do `.sql` (o histórico do git tem todas) ou voltar o endpoint para a
  função antiga.

## Recomendações ainda não aplicadas (precisam do dono do repositório)

- **Repositório público.** Os docs falam de regras comerciais e (até 24/11/2026) citavam pacientes. Tornar
  o repo privado, e desligar o GitHub Pages, que publica o repo inteiro em `fhelyp.github.io`. Não afeta
  o deploy (Cloudflare via Actions).
- **Aprovação obrigatória na promoção:** em Settings › Environments › `production`, adicionar o Luã como
  *required reviewer*. Assim o deploy de produção espera um clique de aprovação mesmo depois do merge.
  Em repositório privado, isso exige plano pago do GitHub.
- **Proteção do `main`:** exigir PR e o check **CI / testes** verde antes do merge.
