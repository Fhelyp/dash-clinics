export async function onRequestGet({ data }) {
  const u = data?.user;
  return new Response(JSON.stringify({
    email: u.email,
    role: u.role,
    name: u.name,
    sub: u.sub,
    auth_source: u.auth || null,
    allowed_clinic_ids: u.allowed_clinic_ids ?? null,
    regional: u.regional || null,
    _debug: u._debug || null
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
