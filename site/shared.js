(function(){
  var ua=navigator.userAgent, d=document.documentElement;
  var ios=/iPhone|iPad|iPod/.test(ua)||(/Mac/.test(ua)&&navigator.maxTouchPoints>1);
  d.dataset.device=ios?"ios":/Android/.test(ua)?"android":"desktop";
  document.querySelectorAll("[data-toggle-all]").forEach(function(b){
    b.addEventListener("click",function(){var on=d.classList.toggle("show-all");b.textContent=on?"Show only my device":"Not your device? Show all"});
  });
  var deferred;
  window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();deferred=e;document.querySelectorAll("[data-install]").forEach(function(b){b.hidden=false})});
  document.querySelectorAll("[data-install]").forEach(function(b){
    b.hidden=true;
    b.addEventListener("click",function(){if(deferred){deferred.prompt();deferred=null;b.hidden=true}});
  });
  // The app lives on app.<this domain>. Set window.DANNY_APP_ORIGIN to override (local previews have no app).
  var host=location.hostname.replace(/^www\./,"");
  var local=/^(localhost|127\.|\[|\d+\.\d+\.\d+\.\d+$)/.test(host)||host.indexOf(".")<0;
  var appOrigin=window.DANNY_APP_ORIGIN||(local?"":location.protocol+"//app."+host);
  document.querySelectorAll("[data-app-link]").forEach(function(a){if(appOrigin)a.href=appOrigin+(a.getAttribute("data-app-link")||"/");else a.hidden=true});
  // Invite form. Posts to the app's API; on a local preview there is none, so say so plainly.
  document.querySelectorAll("form.invite").forEach(function(f){
    var msg=f.parentNode.querySelector(".invite-msg");
    f.addEventListener("submit",function(e){
      e.preventDefault();
      var url=window.DANNY_INVITE_URL||(appOrigin&&appOrigin+"/v1/invite-requests");
      if(!url){msg.textContent="Preview build: the list isn't connected here. Nothing was saved.";return}
      fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:f.email.value})})
        .then(function(r){msg.textContent=r.ok?"You're on the list. We'll email you when your spot opens.":"That didn't go through. Try again."})
        .catch(function(){msg.textContent="That didn't go through. Try again."});
    });
  });
})();
