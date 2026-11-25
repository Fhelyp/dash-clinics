"""Divergência entre as funções SQL do repositório (db/functions/*.sql) e as que estão no banco.

O banco é um só (produção) e as funções são aplicadas à mão (CREATE OR REPLACE); este script prova
que o git é a fonte da verdade: cada função do repo tem de existir no banco com o MESMO corpo.

Uso (credencial NUNCA no repo):
    set DASH_PG_DSN=host=... port=6543 dbname=postgres user=... password=...
    python tests/sql/drift_funcoes.py            # relatório
    python tests/sql/drift_funcoes.py --estrito  # sai com 1 se houver diferença (para CI/rotina)

Arquivos marcados como legado (LEGADO abaixo) são só reportados, não reprovam.
"""
import os, re, sys, glob
import psycopg2

DSN = os.environ.get('DASH_PG_DSN')
if not DSN:
    sys.exit('defina DASH_PG_DSN')
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ESTRITO = '--estrito' in sys.argv
RAIZ = os.path.join(os.path.dirname(__file__), '..', '..', 'db', 'functions')

# versões antigas mantidas como referência/rollback; não estão no caminho do dash
LEGADO = {'funnel_stats.sql', 'funnel_stats_v5.sql', 'funnel_stats_v6.sql', 'funnel_detail.sql',
          'funnel_resgate_followup.sql', 'funnel_resgate_detail.sql', 'dashboard_stats.sql'}

DEF_RE = re.compile(r'CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?(\w+)\s*\((.*?)\)\s*RETURNS.*?\$function\$(.*?)\$function\$',
                    re.S | re.I)

def norm(s):
    return re.sub(r'\s+', ' ', s).strip()

def sem_comentario(s):
    """Corpo sem comentários de linha: diferença só em comentário não muda o que a função faz."""
    return norm(re.sub(r'--[^\n]*', '', s))

def tipos(args):
    """Assinatura só com os tipos, como o pg devolve em pg_get_function_identity_arguments."""
    out = []
    for a in re.split(r',(?![^()]*\))', args):
        a = re.sub(r'\s+DEFAULT\s+.*$', '', a.strip(), flags=re.I | re.S)
        if not a:
            continue
        partes = a.split(None, 1)
        out.append(norm(partes[1] if len(partes) > 1 else partes[0]).lower())
    return out

conn = psycopg2.connect(DSN)
cur = conn.cursor()
cur.execute("""SELECT p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid)
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace""")
banco = {}
for nome, ident, fdef in cur.fetchall():
    corpo = re.search(r'\$function\$(.*?)\$function\$', fdef, re.S)
    sig = [norm(re.sub(r'^\w+\s+', '', x.strip(), count=1)).lower() for x in ident.split(',') if x.strip()] if ident else []
    banco.setdefault(nome, []).append((sig, corpo.group(1) if corpo else None))

problemas = 0
verificadas = 0
so_comentario = 0
for arq in sorted(glob.glob(os.path.join(RAIZ, '*.sql'))):
    base = os.path.basename(arq)
    txt = open(arq, encoding='utf-8').read()
    for nome, args, corpo in DEF_RE.findall(txt):
        sig = tipos(args)
        verificadas += 1
        versoes = banco.get(nome, [])
        alvo = next((v for v in versoes if v[0] == sig), None)
        if alvo is None:
            status = 'AUSENTE NO BANCO' if not versoes else f'ASSINATURA DIFERENTE (banco: {[v[0] for v in versoes]})'
        elif alvo[1] is not None and norm(alvo[1]) == norm(corpo):
            status = 'igual'
        elif alvo[1] is not None and sem_comentario(alvo[1]) == sem_comentario(corpo):
            status = 'só comentário (código igual; aplicar na próxima promoção)'
            so_comentario += 1
        else:
            status = 'CORPO DIFERENTE'
        if status != 'igual':
            legado = base in LEGADO
            if not legado and not status.startswith('só comentário'):
                problemas += 1
            print(f'{"(legado) " if legado else ""}{base}: {nome}({", ".join(sig)}) -> {status}')
extra = f' ({so_comentario} só em comentário)' if so_comentario else ''
print(f'\n{verificadas} funções verificadas. RESULTADO: {"repo == banco" if problemas == 0 else f"{problemas} divergência(s) fora do legado"}{extra}')
sys.exit(1 if (ESTRITO and problemas) else 0)
