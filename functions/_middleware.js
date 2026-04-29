import { verifyJWT, readCookie } from './_lib/auth.js';

const PUBLIC_PATHS = new Set([
  '/login.html',
  '/login',
  '/api/login',
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

  const token = readCookie(request, 'dc_session');
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
