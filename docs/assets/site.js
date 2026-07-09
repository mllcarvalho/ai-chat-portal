/* Casca compartilhada da documentação: navegação lateral (fonte única),
   menu mobile e botões de copiar dos terminais. Sem dependências. */
(function () {
  'use strict';

  /* A ordem é o caminho de adoção — numerada de propósito. */
  var NAV = [
    { href: 'index.html', label: 'Visão geral' },
    { href: 'instalacao.html', label: 'Como instalar' },
    { href: 'como-usar.html', label: 'Como usar' },
    { href: 'bmad-method.html', label: 'BMAD Method' },
    { href: 'mcps.html', label: 'MCPs' },
    { href: 'arquitetura.html', label: 'Arquitetura' },
    { href: 'quem-somos.html', label: 'Quem somos' },
    { href: 'faq.html', label: 'FAQ' },
    { href: 'release-notes.html', label: 'Release Notes' }
  ];

  function currentPage() {
    var file = location.pathname.split('/').pop();
    if (file === '') return 'index.html';
    // subpáginas do guia de uso (uso-*.html) pertencem ao item "Como usar"
    if (file.indexOf('uso-') === 0) return 'como-usar.html';
    return file;
  }

  var navEl = document.getElementById('nav');
  if (navEl) {
    var page = currentPage();
    NAV.forEach(function (item, i) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = item.href;
      if (item.href === page) a.setAttribute('aria-current', 'page');
      var no = document.createElement('span');
      no.className = 'no';
      no.textContent = String(i + 1).padStart(2, '0');
      a.appendChild(no);
      a.appendChild(document.createTextNode(item.label));
      li.appendChild(a);
      navEl.appendChild(li);
    });
  }

  /* menu mobile */
  var side = document.getElementById('side');
  var openBtn = document.getElementById('menu-open');
  var closeBtn = document.getElementById('menu-close');
  if (side && openBtn) {
    openBtn.addEventListener('click', function () { side.classList.add('open'); });
  }
  if (side && closeBtn) {
    closeBtn.addEventListener('click', function () { side.classList.remove('open'); });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && side) side.classList.remove('open');
  });

  /* copiar: todo .copy-btn dentro de um .term copia o conteúdo do .term-body */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* sem clipboard */ }
    document.body.removeChild(ta);
  }
  window.copyText = function (text, btn) {
    function feedback() {
      var old = btn.textContent;
      btn.textContent = 'Copiado ✓';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = old; btn.classList.remove('copied'); }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(feedback, function () { legacyCopy(text); feedback(); });
    } else {
      legacyCopy(text); feedback();
    }
  };
  Array.prototype.slice.call(document.querySelectorAll('.term .copy-btn')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var term = btn.closest('.term');
      var body = term && term.querySelector('.term-body');
      if (body) window.copyText(body.textContent, btn);
    });
  });
})();
