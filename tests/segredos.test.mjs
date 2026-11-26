// O repositório é PÚBLICO: nenhum arquivo versionado pode ter credencial.
// Procura padrões de segredo reais (JWT do Supabase, token da Anthropic/GitHub, DSN com senha) em
// tudo que o git versiona. Placeholders de exemplo (usuario:senha) não casam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PADROES = [
  ['JWT (service_role/anon do Supabase)', /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['token da Anthropic', /sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{30,}/],
  ['token do GitHub', /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{30,}/],
  ['DSN do Postgres com senha', /postgres(ql)?:\/\/[^:\s/]+:(?!senha@|password@|\*+@|<)[^@\s]{8,}@[^\s]*supabase/],
  ['senha do pooler em texto', /password\s*=\s*['"](?!\*)[^'"\s]{12,}['"][^\n]*pooler/i],
  ['chave privada', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

function arquivosVersionados() {
  try {
    return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return null; // sem git (ex.: tarball): o teste é pulado
  }
}

test('nenhum segredo nos arquivos versionados', (t) => {
  const arquivos = arquivosVersionados();
  if (!arquivos) return t.skip('git indisponível');
  const achados = [];
  for (const arq of arquivos) {
    if (/\.(png|jpe?g|gif|ico|pdf|woff2?|lock)$/i.test(arq)) continue;
    let txt;
    try { txt = readFileSync(arq, 'utf8'); } catch { continue; }
    for (const [nome, re] of PADROES) {
      const m = txt.match(re);
      if (m) achados.push(`${arq}: ${nome} (${m[0].slice(0, 12)}…)`);
    }
  }
  assert.deepEqual(achados, []);
});
