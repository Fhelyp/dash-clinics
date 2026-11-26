// Guardas das páginas estáticas (public/*.html), rodam no CI antes de qualquer deploy.
//  1. Todo <script> inline compila: o index.html tem milhares de linhas de JS; um erro de sintaxe
//     deixa o dash em branco e nenhum outro teste pega.
//  2. login.html carrega /gci-sso.js: sem ele o embed do hub GCI cai na tela de login
//     (incidente 10–14/09/2026).
//  3. gci-sso.js existe (o login.html aponta para ele).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const PUB = new URL('../public/', import.meta.url);
const paginas = readdirSync(PUB).filter((f) => f.endsWith('.html'));

function scriptsInline(html) {
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["']?(application\/(ld\+)?json|text\/template)/i.test(attrs)) continue;
    const linha = html.slice(0, m.index).split('\n').length;
    out.push({ codigo: m[2], linha, modulo: /type\s*=\s*["']?module/i.test(attrs) });
  }
  return out;
}

test('há páginas para checar', () => {
  assert.ok(paginas.includes('index.html') && paginas.includes('login.html'), paginas.join(','));
});

for (const pagina of paginas) {
  test(`${pagina}: scripts inline compilam`, () => {
    const html = readFileSync(new URL(pagina, PUB), 'utf8');
    for (const s of scriptsInline(html)) {
      if (s.modulo) continue; // vm.Script não aceita import/export; não temos módulos inline hoje
      try {
        new vm.Script(s.codigo, { filename: `${pagina}:${s.linha}` });
      } catch (e) {
        assert.fail(`${pagina}, <script> da linha ${s.linha}: ${e.message}`);
      }
    }
  });
}

test('login.html carrega o SSO do embed (gci-sso.js)', () => {
  const html = readFileSync(new URL('login.html', PUB), 'utf8');
  assert.match(html, /<script\s+src=["']\/gci-sso\.js["']\s*>\s*<\/script>/);
  assert.ok(existsSync(new URL('gci-sso.js', PUB)), 'public/gci-sso.js não existe');
});
