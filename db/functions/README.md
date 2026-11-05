# Funções SQL do dashboard (Supabase)

Estas funções vivem no Postgres do Supabase (projeto reeuuxkeqosiyjntyzma) e são a
LÓGICA REAL do dashboard — o funil, os KPIs, os drill-downs, o rollup.

Ate 27/07/2026 elas NAO estavam versionadas em git nenhum (só existiam no banco).
Este dump fecha essa lacuna. Snapshot tirado direto de pg_get_functiondef.

Para aplicar uma: rodar o conteudo do .sql no SQL Editor do Supabase (é CREATE OR REPLACE).

## Ações do CRC (05/11/2026)

`crc_acoes.sql`: `crc_acao_bucket`, `crc_creator_key`, `crc_acoes_base` (base única: agendamentos e
pagamentos atribuídos), `crc_acoes_stats` e `crc_acoes_detail`. Substituem `funnel_resgate_followup`
e `funnel_resgate_detail` no front (que ficam no banco como rollback). Validação contra o banco:
`tests/sql/validar_crc_acoes.py`. Regras: `docs/DECISOES_2026-11-05.md`.
