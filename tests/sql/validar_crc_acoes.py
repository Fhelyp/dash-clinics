"""Validação do bloco "Ações do CRC" (db/functions/crc_acoes.sql) contra o banco real.

Uso (credencial NUNCA no repo):
    set DASH_PG_DSN=postgresql://usuario:senha@host:6543/postgres
    python tests/sql/validar_crc_acoes.py

Confere, para vários períodos e filtros:
  1. Resgate + Resgate Orto e os dois Follow-Ups == bloco antigo (funnel_resgate_followup).
  2. Drill == tabela: contagem e total do drill (crc_acoes_detail) == números do stats.
  3. Nenhum pagamento em dois blocos: por paciente, campanha (funnel_v7_rows) + ações do CRC
     <= total pago no período (mesmo filtro de unidade).
  4. Filtro de operador: MC + HUM == ALL em todas as vertentes.
  5. Tempo de resposta.
Sai com código 1 se algum check falhar.
"""
import os, sys, time, json
import psycopg2

DSN = os.environ.get('DASH_PG_DSN')
if not DSN:
    sys.exit('defina DASH_PG_DSN')

conn = psycopg2.connect(DSN); conn.autocommit = True
cur = conn.cursor()
cur.execute("SET statement_timeout = '300s'")

FAILS = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FALHA ') + msg)
    if not ok: FAILS.append(msg)

def q1(sql, *args):
    cur.execute(sql, args); return cur.fetchone()[0]

cur.execute("""SELECT array_agg("Ecuro_clinicId") FROM "unitConfigs"
               WHERE "Dash" IS TRUE AND regional = 'SP' AND "Ecuro_clinicId" ~ '^[0-9a-f-]{36}$'""")
SP = cur.fetchone()[0]
cur.execute("""SELECT "Ecuro_clinicId", "Unidade" FROM "unitConfigs"
               WHERE "Dash" IS TRUE AND regional = 'SP' AND "Unidade" ILIKE ANY(ARRAY['%bertioga%','%porto ferreira%','%jacare%'])""")
UNIDADES = cur.fetchall()

CASOS = [('out/26 SP', '2026-10-01', '2026-11-01', SP),
         ('set/26 SP', '2026-09-01', '2026-10-01', SP),
         ('01-05/11 SP', '2026-11-01', '2026-11-06', SP)]
CASOS += [(f'out/26 {nome}', '2026-10-01', '2026-11-01', [cid]) for cid, nome in UNIDADES]

BUCKETS = ['resgate', 'resgate_orto', 'follow_campanha', 'follow_organico', 'lead_organico', 'indicacao']
ETAPAS = ['agendados', 'confirmados', 'compareceram']

for nome, s, e, cids in CASOS:
    ps, pe = s + ' 00:00:00-03', e + ' 00:00:00-03'
    print(f'\n== {nome}')
    t0 = time.time()
    novo = q1("SELECT crc_acoes_stats(%s, %s, %s)", ps, pe, cids)
    dt = time.time() - t0
    check(dt < 30, f'tempo do stats {dt:.1f}s (< 30s)')
    antigo = q1("SELECT funnel_resgate_followup(%s, %s, %s)", ps, pe, cids)
    nb, ob = novo['buckets'], antigo['buckets']

    # 1. equivalência com o bloco antigo
    for k in ETAPAS + ['receita']:
        soma = float(nb['resgate'][k]) + float(nb['resgate_orto'][k])
        check(abs(soma - float(ob['resgate'][k])) < 0.01, f'resgate+orto {k}: {soma:.2f} == antigo {float(ob["resgate"][k]):.2f}')
        for f in ('follow_campanha', 'follow_organico'):
            check(abs(float(nb[f][k]) - float(ob[f][k])) < 0.01, f'{f} {k}: {float(nb[f][k]):.2f} == antigo {float(ob[f][k]):.2f}')
    nc, oc = novo['contatos_cw'], antigo['contatos_cw']
    # 09/11: o resgate passou a se dividir em sem orto / com orto (etiqueta orto); follow igual
    check(nc['follow'] == oc['follow'], f'contatos follow iguais ao antigo: {nc["follow"]} == {oc["follow"]}')
    check(nc['resgate'] + nc['resgate_orto'] == oc['resgate'],
          f'contatos resgate + orto == antigo: {nc["resgate"]} + {nc["resgate_orto"]} == {oc["resgate"]}')
    for bk in ['resgate', 'resgate_orto', 'lead_organico', 'indicacao']:
        d = q1("SELECT crc_acoes_detail(%s, 'contatos', %s, %s, %s, NULL, 'ALL', 1, 0)", bk, ps, pe, cids)
        check(d['count'] == nc[bk], f'drill contatos {bk}: {d["count"]} == {nc[bk]}')

    # 2. drill == tabela
    for bk in BUCKETS:
        for st in ETAPAS:
            d = q1("SELECT crc_acoes_detail(%s, %s, %s, %s, %s, NULL, 'ALL', 1, 0)", bk, st, ps, pe, cids)
            check(d['count'] == nb[bk][st], f'drill {bk}/{st}: {d["count"]} == {nb[bk][st]}')
        d = q1("SELECT crc_acoes_detail(%s, 'receita', %s, %s, %s, NULL, 'ALL', 1, 0)", bk, ps, pe, cids)
        check(d['count'] == nb[bk]['venderam'] and abs(float(d['total_pago']) - float(nb[bk]['receita'])) < 0.01,
              f'drill {bk}/receita: {d["count"]} pac R$ {float(d["total_pago"]):.2f} == {nb[bk]["venderam"]} pac R$ {float(nb[bk]["receita"]):.2f}')

    # 3. nenhum pagamento em dois blocos
    cur.execute("""
      WITH v7 AS (SELECT patient_id, total_pago FROM funnel_v7_rows(%(s)s, %(e)s, %(c)s, 'comissao', NULL, 'ALL')),
           crc AS (SELECT patient_id, SUM(amount) t FROM crc_acoes_base(%(s)s, %(e)s, %(c)s) WHERE kind = 'pg' GROUP BY 1),
           tot AS (SELECT patient_id, SUM(amount) t, SUM(GREATEST(amount, 0)) pos FROM "BI Payments"
                   WHERE deleted_at IS NULL AND date >= %(s)s AND date < %(e)s AND clinic_id = ANY(%(c)s)
                     AND NOT (btrim(COALESCE(payment_type_name,'')) ILIKE 'boleto programado' AND COALESCE(is_confirmed,false) = false)
                   GROUP BY 1)
      SELECT COUNT(*) FILTER (WHERE COALESCE(v7.total_pago,0) > 0 AND COALESCE(crc.t,0) <> 0) AS pac_nos_dois,
             -- se o mesmo pagamento estivesse nos dois blocos, a soma passaria do que o paciente pagou
             -- (positivos: estorno negativo não conta em bloco nenhum e não pode mascarar o teste)
             COUNT(*) FILTER (WHERE COALESCE(v7.total_pago,0) + COALESCE(crc.t,0) > COALESCE(tot.pos,0) + 0.01) AS excede,
             COALESCE(SUM(v7.total_pago),0), COALESCE(SUM(crc.t),0), COALESCE(SUM(tot.t),0)
      FROM tot FULL JOIN v7 USING (patient_id) FULL JOIN crc USING (patient_id)""", dict(s=ps, e=pe, c=cids))
    nos_dois, excede, sv7, scrc, stot = cur.fetchone()
    check(excede == 0, f'pagamento contado duas vezes: {excede} pacientes (pac. com receita nos dois blocos: {nos_dois})')
    print(f'       campanha R$ {float(sv7):,.2f} + CRC R$ {float(scrc):,.2f} | total pago R$ {float(stot):,.2f}')
    # teste do teste: contar a campanha duas vezes TEM que ser detectado
    cur.execute("""
      WITH v7 AS (SELECT patient_id, total_pago FROM funnel_v7_rows(%(s)s, %(e)s, %(c)s, 'comissao', NULL, 'ALL') WHERE total_pago > 0),
           tot AS (SELECT patient_id, SUM(GREATEST(amount, 0)) pos FROM "BI Payments"
                   WHERE deleted_at IS NULL AND date >= %(s)s AND date < %(e)s AND clinic_id = ANY(%(c)s)
                     AND NOT (btrim(COALESCE(payment_type_name,'')) ILIKE 'boleto programado' AND COALESCE(is_confirmed,false) = false)
                   GROUP BY 1)
      SELECT COUNT(*), COUNT(*) FILTER (WHERE 2 * v7.total_pago > COALESCE(tot.pos,0) + 0.01)
      FROM v7 LEFT JOIN tot USING (patient_id)""", dict(s=ps, e=pe, c=cids))
    n_v7, detectados = cur.fetchone()
    # (não chega a 100%: paciente com outros pagamentos grandes pode esconder um pequeno — por isso o check estrito abaixo)
    check(n_v7 == 0 or detectados >= n_v7 - max(2, 0.05 * n_v7), f'teste do teste: dupla contagem simulada detectada em {detectados} de {n_v7} pacientes')
    # estrito, por pagamento: paciente com receita de campanha não pode ter pagamento em Lead Orgânico/Indicação
    # (Follow-Up/Resgate pode: o funil de campanha tira esses pela mesma regra da última consulta)
    cur.execute("""
      WITH v7 AS (SELECT patient_id FROM funnel_v7_rows(%(s)s, %(e)s, %(c)s, 'comissao', NULL, 'ALL') WHERE total_pago <> 0)
      SELECT COUNT(*), COALESCE(SUM(b.amount),0) FROM crc_acoes_base(%(s)s, %(e)s, %(c)s) b JOIN v7 USING (patient_id)
      WHERE b.kind = 'pg' AND b.bucket IN ('lead_organico','indicacao')""", dict(s=ps, e=pe, c=cids))
    n_dup, v_dup = cur.fetchone()
    check(n_dup == 0, f'pagamentos de paciente de campanha em Lead Orgânico/Indicação: {n_dup} (R$ {float(v_dup):,.2f})')

    # 4. filtro de operador
    mc = q1("SELECT crc_acoes_stats(%s, %s, %s, NULL, 'MC')", ps, pe, cids)['buckets']
    hum = q1("SELECT crc_acoes_stats(%s, %s, %s, NULL, 'HUM')", ps, pe, cids)['buckets']
    for bk in BUCKETS:
        for k in ETAPAS + ['receita', 'venderam']:
            check(abs(float(mc[bk][k]) + float(hum[bk][k]) - float(nb[bk][k])) < 0.01,
                  f'MC+HUM {bk}/{k}: {float(mc[bk][k]):.2f}+{float(hum[bk][k]):.2f} == {float(nb[bk][k]):.2f}')

    print('  números:', json.dumps({bk: {k: nb[bk][k] for k in ['agendados', 'compareceram', 'venderam', 'receita']} for bk in BUCKETS}, ensure_ascii=False))

# 6. filtros de 09/11 (Origem no funil; Especialidade e Origem nas ações do CRC): drill == tabela
print('\n== filtros Origem/Especialidade (out/26 SP)')
ps, pe = '2026-10-01 00:00:00-03', '2026-11-01 00:00:00-03'
ORTO = '7f945176-078f-448e-aa9b-6d5cd95961e7'
for origem in (['CRC'], ['Fachada'], ['Maria Clara IA']):
    fs = q1("SELECT funnel_stats_v7(%s, %s, %s, 'comissao', NULL, 'ALL', %s)->'funnel'", ps, pe, SP, origem)
    for st in ['agendados', 'compareceram', 'venderam']:
        d = q1("SELECT funnel_detail_v7(%s, %s, %s, %s, 'comissao', NULL, 'ALL', 1, 0, NULL, NULL, %s)", st, ps, pe, SP, origem)
        check(d['count'] == fs[st], f'funil origem {origem[0]} {st}: drill {d["count"]} == {fs[st]}')
for esp, origem in (([ORTO], None), (None, ['CRC']), ([ORTO], ['Fachada'])):
    b = q1("SELECT crc_acoes_stats(%s, %s, %s, NULL, 'ALL', %s::uuid[], %s)", ps, pe, SP, esp, origem)['buckets']
    for bk in BUCKETS:
        d = q1("SELECT crc_acoes_detail(%s, 'agendados', %s, %s, %s, NULL, 'ALL', 1, 0, %s::uuid[], %s)", bk, ps, pe, SP, esp, origem)
        r = q1("SELECT crc_acoes_detail(%s, 'receita', %s, %s, %s, NULL, 'ALL', 1, 0, %s::uuid[], %s)", bk, ps, pe, SP, esp, origem)
        check(d['count'] == b[bk]['agendados'] and abs(float(r['total_pago']) - float(b[bk]['receita'])) < 0.01,
              f'CRC esp={bool(esp)} origem={origem} {bk}: drill {d["count"]}/{float(r["total_pago"]):.2f} == {b[bk]["agendados"]}/{float(b[bk]["receita"]):.2f}')
    if esp:
        check(b['resgate']['agendados'] == 0, f'com Ortodontia o Resgate comum zera: {b["resgate"]["agendados"]}')

print('\nRESULTADO:', 'TUDO OK' if not FAILS else f'{len(FAILS)} FALHA(S)')
sys.exit(1 if FAILS else 0)
