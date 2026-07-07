import { Router, sendError, sendJson } from '../router';
import { tokenMatches } from '../tokenCheck';
import { getConfig } from '../../storage/configStore';
import { saveCapturedDoc } from '../../storage/knowledgeStore';

/**
 * Página-ponte para sites cuja CSP (connect-src) bloqueia o fetch do
 * bookmarklet direto para 127.0.0.1. O bookmarklet abre esta página num popup
 * e manda o conteúdo por postMessage — que nenhuma CSP bloqueia; daqui o POST
 * para /api/capture é same-origin. A autenticação continua sendo o token
 * dentro do payload, validado na rota de captura.
 */
const BRIDGE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>AI Portal — captura</title></head>
<body style="font:14px/1.5 system-ui,sans-serif;background:#16294b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div id="s" style="text-align:center;padding:0 18px">Recebendo a página…</div>
<script>
(function(){
  var s=document.getElementById('s');
  function show(t,err){s.textContent=t;s.style.color=err?'#ff9d8f':'#fff'}
  function reply(d){try{if(window.opener)window.opener.postMessage(d,'*')}catch(_){}}
  if(!window.opener){show('Esta janela é aberta pelo favorito "Enviar para o portal" na página que você quer capturar.',1);return}
  window.addEventListener('message',function(e){
    var d=e.data;
    if(!d||d.type!=='aiportal-capture')return;
    show('Salvando página no portal…');
    fetch('/api/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d.payload)})
      .then(function(r){return r.json()})
      .then(function(r){
        if(r&&r.ok){
          show('✓ Salvo: '+r.doc+' — base "'+r.base+'"');
          reply({type:'aiportal-capture-result',ok:true,doc:r.doc,base:r.base});
          setTimeout(function(){window.close()},2200);
        }else{
          var m=(r&&r.error)||'Erro ao salvar';
          show(m,1);
          reply({type:'aiportal-capture-result',ok:false,error:m});
        }
      })
      .catch(function(){show('Erro ao contatar o portal',1);reply({type:'aiportal-capture-result',ok:false,error:'Erro ao contatar o portal'})});
  });
  window.opener.postMessage({type:'aiportal-bridge-ready'},'*');
})();
</script></body></html>`;

/**
 * Recebe páginas do bookmarklet "Enviar para o portal". A requisição chega de
 * uma origem externa (SharePoint, intranet…) como POST text/plain — simples,
 * sem preflight — e por isso o token do portal vem no CORPO, não no header
 * (o httpServer isenta esta rota da checagem de header e do filtro de origem).
 * Quando a CSP da página bloqueia até esse fetch, o bookmarklet cai para a
 * página-ponte abaixo (popup + postMessage).
 */
export function registerCaptureRoutes(router: Router): void {
  router.get('/api/capture/bridge', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(BRIDGE_HTML);
  });

  router.post('/api/capture', ({ res, body }) => {
    const input = (body ?? {}) as {
      token?: string;
      title?: string;
      url?: string;
      html?: string;
      text?: string;
    };
    if (!tokenMatches(input.token, getConfig().token)) {
      sendError(res, 401, 'Token inválido — gere o bookmarklet de novo na página Conhecimento');
      return;
    }
    if (!input.html?.trim() && !input.text?.trim()) {
      sendError(res, 400, 'Envie o conteúdo da página (html ou text)');
      return;
    }
    try {
      const saved = saveCapturedDoc(input);
      sendJson(res, 201, { ok: true, base: saved.baseName, doc: saved.docName });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });
}
