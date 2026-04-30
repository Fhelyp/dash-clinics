export async function onRequestGet({ data }) {
  const u = data?.user;
  return new Response(JSON.stringify({
    email: u.email,
    role: u.role,
    name: u.name,
    sub: u.sub,
    auth_source: u.auth || null,
    // RBAC: null = todas as clínicas; array = só essas
    allowed_clinic_ids: u.allowed_clinic_ids ?? null
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
