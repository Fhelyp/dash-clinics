import { verifyJWT, readCookie } from './_lib/auth.js';

const PUBLIC_PATHS = new Set([
  '/',           // a "casca" do SPA é pública: a auth é decidida no cliente (cookie OU token no
                 // header). Sem isto, o Safari — que não manda o cookie de terceiro — entra em loop
                 // de redirect ('/'→/login→/'→…). Os dados continuam protegidos pelas APIs gated.
  '/login.html',
  '/login',
  '/api/login',
  '/api/sso',
  '/favicon.ico',
]);

function isPublicAsset(path) {
  return path === '/' || // será redirecionado pelo guard abaixo
         path.endsWith('.css') || path.endsWith('.js') ||
         path.endsWith('.png') || path.endsWith('.svg') || path.endsWith('.ico') ||
         path.endsWith('.woff') || path.endsWith('.woff2');
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PATHS.has(path)) return next();

  // Sessão por cookie OU por Authorization: Bearer. O Bearer cobre o embed cross-site no Safari,
  // que não envia o cookie de terceiro (sem CHIPS) — o SPA manda o token guardado em localStorage.
  const cookieTok = readCookie(request, 'dc_session');
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.indexOf('Bearer ') === 0 ? authHeader.slice(7).trim() : null;
  const token = cookieTok || bearer;
  const claims = token ? await verifyJWT(token, env.JWT_SECRET) : null;

  // Sem sessão válida: API → 401 JSON; HTML → redirect /login.html
  if (!claims) {
    if (path.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (isPublicAsset(path) && path !== '/') return next();
    return Response.redirect(new URL('/login.html', request.url), 302);
  }

  // Disponibiliza claims para handlers downstream
  context.data = context.data || {};
  context.data.user = claims;
  return next();
}
