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
    var HUB_ORIGINS = ['https://gci.arvore.party', 'https://app.arvore.party'];
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
      if (m.type === 'gci-sso' && m.access_token) {
        done = true;
        fetch('/api/sso', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cred: {
            access_token: m.access_token, token_type: m.token_type,
            client: m.client, uid: m.uid
          } })
        }).then(function (r) {
          if (r.ok) window.location.replace('/');   // sessão criada -> entra
          else reveal();                            // SSO recusado -> login normal
        }).catch(function () { reveal(); });
      }
    });

    try { window.top.postMessage({ type: 'gci-ready' }, '*'); } catch (_) {}
    setTimeout(function () { if (!done) reveal(); }, 2000); // hub não respondeu
  } catch (_) {}
})();
