# Funções SQL do dashboard (Supabase)

Estas funções vivem no Postgres do Supabase (projeto reeuuxkeqosiyjntyzma) e são a
LÓGICA REAL do dashboard — o funil, os KPIs, os drill-downs, o rollup.

Ate 27/07/2026 elas NAO estavam versionadas em git nenhum (só existiam no banco).
Este dump fecha essa lacuna. Snapshot tirado direto de pg_get_functiondef.

Para aplicar uma: rodar o conteudo do .sql no SQL Editor do Supabase (é CREATE OR REPLACE).
