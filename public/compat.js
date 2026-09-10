/* ============================================================
   COMPATIBILIDADE — injetado no topo das páginas antigas.
   Faz duas coisas e só isso:

   1. Todo fetch de escrita passa a levar o cabeçalho X-CSRF-Token.
      Sem isso o servidor novo recusa a gravação (403). O token vem
      do cookie 'csrf', que o servidor coloca ao entregar a página.

   2. Substitui os antigos onclick="..." inline, que a nova política
      de CSP bloqueia. Os botões agora usam data-act e este handler
      delegado dispara a mesma função de antes.
============================================================ */
(function(){
  function cookie(nome){
    var partes = (document.cookie || "").split(";");
    for(var i=0;i<partes.length;i++){
      var p = partes[i], k = p.indexOf("=");
      if(k>0 && p.slice(0,k).trim() === nome){
        try { return decodeURIComponent(p.slice(k+1).trim()); } catch(e){ return null; }
      }
    }
    return null;
  }

  var fetchOriginal = window.fetch;

  /* Só embrulha se houver o que embrulhar. Navegador antigo (ou
     ambiente de teste sem fetch) não deve derrubar a página inteira
     por causa disto — o resto do shim continua valendo. */
  if (typeof fetchOriginal === "function") {
    window.fetch = function(entrada, opcoes){
      opcoes = opcoes || {};
      var metodo = String(opcoes.method || "GET").toUpperCase();
      var mesmaOrigem = typeof entrada === "string" &&
        (entrada.charAt(0) === "/" || entrada.indexOf(location.origin) === 0);

      if(mesmaOrigem && metodo !== "GET" && metodo !== "HEAD"){
        var token = cookie("csrf");
        if(token){
          var h = opcoes.headers || {};
          if(typeof Headers !== "undefined" && h instanceof Headers) h.set("X-CSRF-Token", token);
          else { h = Object.assign({}, h); h["X-CSRF-Token"] = token; }
          opcoes.headers = h;
        }
        if(!opcoes.credentials) opcoes.credentials = "same-origin";
      }
      return fetchOriginal.call(window, entrada, opcoes);
    };
  }

  document.addEventListener("click", function(ev){
    var alvo = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
    if(!alvo) return;
    var acao = alvo.getAttribute("data-act") || "";
    var i = acao.indexOf(":");
    if(i < 0) return;
    var tipo = acao.slice(0, i), arg = acao.slice(i + 1);

    if(tipo === "click"){
      var el = document.getElementById(arg);
      if(el) el.click();
    } else if(tipo === "fn"){
      var fn = window[arg];
      if(typeof fn === "function") fn();
    }
  });
})();
