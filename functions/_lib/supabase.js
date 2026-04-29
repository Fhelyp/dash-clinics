// Cliente Supabase mínimo via PostgREST direto. Sem SDK.
// Uso: supabaseFetch(env, 'auth_users', { select: 'id,email,role,active', filter: 'email=eq.x' })

export function supaHeaders(env, prefer = '') {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
}

export async function supaSelect(env, table, query = '') {
  const url = `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}${query ? '?' + query : ''}`;
  const res = await fetch(url, { headers: supaHeaders(env) });
  if (!res.ok) throw new Error(`Supabase select ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function supaInsert(env, table, rows, prefer = 'return=representation') {
  const url = `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: supaHeaders(env, prefer),
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Supabase insert ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function supaUpsert(env, table, rows, onConflict = 'id') {
  const url = `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: supaHeaders(env, 'resolution=merge-duplicates,return=minimal'),
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table}: ${res.status} ${await res.text()}`);
}

export async function supaUpdate(env, table, query, patch) {
  const url = `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?${query}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: supaHeaders(env, 'return=minimal'),
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`Supabase update ${table}: ${res.status} ${await res.text()}`);
}
