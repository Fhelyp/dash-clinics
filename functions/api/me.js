export async function onRequestGet({ data }) {
  const u = data?.user;
  return new Response(JSON.stringify({
    email: u.email, role: u.role, name: u.name, sub: u.sub
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
