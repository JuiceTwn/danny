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
  // Invite form. Set window.DANNY_INVITE_URL when the VPS endpoint exists; until then say so plainly.
  document.querySelectorAll("form.invite").forEach(function(f){
    var msg=f.parentNode.querySelector(".invite-msg");
    f.addEventListener("submit",function(e){
      e.preventDefault();
      var url=window.DANNY_INVITE_URL;
      if(!url){msg.textContent="Preview build: invite requests aren't connected yet. Nothing was saved.";return}
      fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:f.email.value})})
        .then(function(r){msg.textContent=r.ok?"Got it. You'll hear from us if you're in.":"That didn't go through. Try again."})
        .catch(function(){msg.textContent="That didn't go through. Try again."});
    });
  });
})();
