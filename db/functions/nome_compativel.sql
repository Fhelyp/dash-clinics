CREATE OR REPLACE FUNCTION public.nome_compativel(p_a text, p_b text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- Compativel se o PRIMEIRO nome de um aparece em qualquer parte do nome do outro (igual ou
  -- prefixo, >=3 letras). Ignora acento, caixa, emoji/numero, "dos/das" e o sufixo
  -- "(era ..., mudou ...)" do Ecuro. Usado pela atribuicao de campanha quando o MESMO telefone
  -- tem varios pacientes (familia): so conta quem bate com o nome do lead.
  -- Ex.: "Ana Paula Alves" x "paula" = sim; "Maisa Sena Cunha" x "Maria do Socorro Sena Cunha" = nao.
  WITH n AS (
    SELECT regexp_split_to_array(btrim(regexp_replace(lower(public.immutable_unaccent(split_part(coalesce(p_a,''),'(era',1))),'[^a-z]+',' ','g')),' ') ra,
           regexp_split_to_array(btrim(regexp_replace(lower(public.immutable_unaccent(split_part(coalesce(p_b,''),'(era',1))),'[^a-z]+',' ','g')),' ') rb),
  t AS (
    SELECT ARRAY(SELECT x FROM unnest(ra) x WHERE length(x) >= 3 AND x NOT IN ('dos','das')) ta,
           ARRAY(SELECT x FROM unnest(rb) x WHERE length(x) >= 3 AND x NOT IN ('dos','das')) tb
    FROM n)
  SELECT COALESCE(
       (ta[1] IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(tb) y WHERE y LIKE ta[1] || '%' OR ta[1] LIKE y || '%'))
    OR (tb[1] IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(ta) x WHERE x LIKE tb[1] || '%' OR tb[1] LIKE x || '%')),
    false)
  FROM t
$function$;
