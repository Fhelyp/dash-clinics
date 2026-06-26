/*
 * SSO do hub GCI (gci.arvore.party / app.arvore.party).
 * Quando o dashboard é aberto embedado no hub e cai na tela de login, ele recebe a
 * credencial do Chatwoot (já validada no login único do hub), troca por uma sessão
 * via /api/sso e entra — sem pedir senha de novo.
 * Fora do hub, não faz nada: o login normal continua valendo.
 */
(function () {
  try {
    if (window.top === window.self) return;            // só dentro do hub (iframe)
    // Varredura de logout do hub: encerra a sessão do dashboard (limpa o cookie dc_session,
    // inclusive o particionado do embed). sendBeacon sobrevive ao redirect da /login (não é
    // cancelado pela navegação), garantindo que o /api/logout complete.
    if (location.search.indexOf('gci_logout') >= 0) {
      try { localStorage.removeItem('dc_embed_token'); } catch (_) {}   // limpa o token do embed
      try {
        if (navigator.sendBeacon) navigator.sendBeacon('/api/logout');
        else fetch('/api/logout', { method: 'POST', credentials: 'include' });
      } catch (_) {}
      return;
    }
    var HUB_ORIGINS = ['https://gci.arvore.party', 'https://app.arvore.party',
                       'https://hml.gci.arvore.party', 'https://gci-hub-hml.pages.dev'];
    var done = false;

    // Esconde a tela de login enquanto tenta o SSO (não pisca).
    var hide = document.createElement('style');
    hide.id = 'gci-sso-hide';
    hide.textContent = 'body{visibility:hidden}';
    document.documentElement.appendChild(hide);
    function reveal() { var s = document.getElementById('gci-sso-hide'); if (s) s.remove(); }

    window.addEventListener('message', function (e) {
      if (done || HUB_ORIGINS.indexOf(e.origin) === -1) return;
      var m = e.data || {};
      if (m.type === 'gci-sso' && (m.access_token || m.api_access_token)) {
        done = true;
        fetch('/api/sso', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cred: {
            access_token: m.access_token, token_type: m.token_type,
            client: m.client, uid: m.uid,
            api_access_token: m.api_access_token   // token pessoal (não rotaciona) — validação robusta
          } })
        }).then(function (r) {
          if (!r.ok) { reveal(); return; }          // SSO recusado -> login normal
          return r.json().then(function (d) {
            // Guarda o token (localStorage particionado) p/ o SPA mandar via Authorization: Bearer
            // no Safari, que não envia o cookie de terceiro. No Chrome o cookie também funciona.
            try { if (d && d.token) localStorage.setItem('dc_embed_token', d.token); } catch (_) {}
            window.location.replace('/');            // sessão criada -> entra
          });
        }).catch(function () { reveal(); });
      }
    });

    try { window.top.postMessage({ type: 'gci-ready' }, '*'); } catch (_) {}
    setTimeout(function () { if (!done) reveal(); }, 2000); // hub não respondeu
  } catch (_) {}
})();
