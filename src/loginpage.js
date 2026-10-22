// Sign-up / log-in page (served by accounts.js).
const esc = (s) =>
	String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function loginPage(next, signupMode, freeMinutes) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log in | Moox Proxy</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#fff;color:#111;max-width:400px;margin:10vh auto;padding:0 1rem}
h1{text-align:center;margin-bottom:.2rem}
.sub{text-align:center;color:#666;margin-top:0}
.tabs{display:flex;gap:.4rem;margin:1.2rem 0}
.tabs button{flex:1;padding:.6rem;border:1px solid #888;background:transparent;color:inherit;border-radius:6px;cursor:pointer;font-size:1rem}
.tabs button[aria-pressed=true]{background:#2563eb;color:#fff;border-color:#2563eb}
form{display:flex;flex-direction:column;gap:.6rem}
label{font-size:.9rem}
input{width:100%;padding:.7rem;font-size:1rem;border:1px solid #888;border-radius:6px;margin-top:.2rem}
.go{padding:.75rem;font-size:1rem;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
.go:disabled{opacity:.6}
.err{color:#b91c1c;min-height:1.2em;margin:.2rem 0}
.hint{font-size:.85rem;color:#666}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
[hidden]{display:none!important}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}input{background:#1b1b1b;color:#eee;border-color:#555}.sub,.hint{color:#aaa}.err{color:#f87171}}
</style></head><body>
<h1>Moox Proxy</h1>
<p class="sub">Log in or make an account</p>
<div class="tabs">
<button type="button" id="t-login" aria-pressed="true">Log in</button>
<button type="button" id="t-signup" aria-pressed="false">Sign up</button>
</div>
<form id="f" autocomplete="on">
<label>Username<input id="u" name="username" autocomplete="username" maxlength="20" required autofocus></label>
<label>Password<input id="p" name="password" type="password" autocomplete="current-password" minlength="8" required></label>
<label id="codewrap" hidden><span id="codelabel">Access code (optional)</span><input id="c" name="code" autocomplete="off" maxlength="25" placeholder="XXXX-XXXX-XXXX-XXXX"></label>
<div class="hp" aria-hidden="true"><label>Website<input id="w" name="website" tabindex="-1" autocomplete="off"></label></div>
<p class="err" id="err" role="alert"></p>
<button class="go" id="go" type="submit">Log in</button>
<p class="hint" id="hint" hidden></p>
</form>
<script>
(function(){
var NEXT=${JSON.stringify(next)}, MODE=${JSON.stringify(signupMode)}, FREE=${JSON.stringify(freeMinutes)};
var mode="login";
var $=function(i){return document.getElementById(i)};
function set(m){
  mode=m;
  $("t-login").setAttribute("aria-pressed",String(m==="login"));
  $("t-signup").setAttribute("aria-pressed",String(m==="signup"));
  $("go").textContent=m==="login"?"Log in":"Create account";
  $("p").autocomplete=m==="login"?"current-password":"new-password";
  var showCode=m==="signup"&&MODE!=="closed";
  $("codewrap").hidden=!showCode;
  $("codelabel").textContent=MODE==="code"?"Access code (required)":"Access code (optional)";
  $("c").required=showCode&&MODE==="code";
  var h=$("hint");
  if(m==="signup"){
    h.hidden=false;
    h.textContent=MODE==="closed"?"Sign-ups are closed right now.":"Free accounts get "+FREE+" minutes of browsing a day. A code gives unlimited time. There is no password reset, so remember your password.";
  } else h.hidden=true;
  $("err").textContent="";
}
$("t-login").onclick=function(){set("login")};
$("t-signup").onclick=function(){set("signup")};

$("f").onsubmit=function(e){
  e.preventDefault();
  var b=$("go");b.disabled=true;$("err").textContent="";
  var body={username:$("u").value,password:$("p").value,next:NEXT};
  if(mode==="signup"){body.code=$("c").value;body.website=$("w").value;}
  fetch(mode==="login"?"/api/login":"/api/signup",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify(body)})
   .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
   .then(function(x){
     if(x.ok&&x.j.ok){location.href=x.j.next||"/";return;}
     $("err").textContent=x.j.error||"Something went wrong.";b.disabled=false;
   })
   .catch(function(){$("err").textContent="Could not reach the server. Try again.";b.disabled=false;});
};
var qc=new URLSearchParams(location.search).get("code");
if(qc){set("signup");$("c").value=qc.slice(0,25);}
else set(location.hash==="#signup"?"signup":"login");
})();
</script>
</body></html>`;
}
