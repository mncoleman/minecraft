// Shared page shell: top tab bar + consistent dark theme. Every server-rendered
// page uses shell(); the static play client mirrors the same markup/CSS.

import { pendingFriendRequestCount } from "./db.ts";

export function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ── inline SVG icons (replace emoji platform-wide) ────────────────────────────
// Lucide-style, monochrome via currentColor so they inherit text color. Sized to
// 1em so they flow with text. A few get subtle CSS animation (see ICON_CSS).
const ICONS: Record<string, string> = {
  pickaxe:
    '<path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912"/><path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393"/><path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z"/><path d="M19.686 8.314a12.501 12.501 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  sparkles:
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  bug: '<ellipse cx="12" cy="13" rx="5" ry="6"/><path d="M12 7v12"/><path d="m5 8 2 2"/><path d="m19 8-2 2"/><path d="M3 14h4"/><path d="M17 14h4"/><path d="m5 19 2-2"/><path d="m19 19-2-2"/><path d="M9 4 7.5 2.5"/><path d="m15 4 1.5-1.5"/>',
  note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  map: '<path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z"/><path d="M9 3v15"/><path d="M15 6v15"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

export function icon(name: string, cls = ""): string {
  const p = ICONS[name];
  if (!p) return "";
  // width/height="1em" make it self-size even on standalone pages that don't
  // load ICON_CSS; .ic (when present) refines sizing + vertical alignment.
  return `<svg class="ic ic-${name}${cls ? " " + cls : ""}" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// Shared icon CSS + subtle animations. Reused by the static pages too (kept in
// sync there). Animations are gentle (hover lift, brand "mine" wiggle, FAB bob,
// sparkle twinkle) so they read as alive without being distracting.
export const ICON_CSS = `
.ic{display:inline-block;width:1em;height:1em;vertical-align:-.14em;flex:none}
.pill .ic,.tab .ic{transition:transform .2s ease}
.pill:hover .ic{transform:translateY(-1px) scale(1.12)}
.ic-pickaxe{color:#46d17f;transition:transform .3s ease}
.brand:hover .ic-pickaxe{animation:ic-mine .6s ease}
@keyframes ic-mine{0%,100%{transform:rotate(0)}25%{transform:rotate(-20deg)}55%{transform:rotate(10deg)}}
.ic-sparkles{transform-origin:center;animation:ic-twinkle 2.6s ease-in-out infinite}
@keyframes ic-twinkle{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.88)}}
.ic-megaphone{transform-origin:left center;animation:ic-shout 3.2s ease-in-out infinite}
@keyframes ic-shout{0%,92%,100%{transform:rotate(0)}4%{transform:rotate(-9deg)}8%{transform:rotate(0)}}`;

export const SHARED_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#e8eaed;
  background:radial-gradient(1100px 520px at 50% -8%,#16241c 0%,transparent 55%),#0b0d10;min-height:100vh}
a{color:#7fb3ff;text-decoration:none}
.nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:.4rem;padding:.6rem 1rem;
  background:rgba(13,15,18,.85);backdrop-filter:blur(8px);border-bottom:1px solid #1c2230}
.brand{display:inline-flex;align-items:center;gap:.4rem;font-weight:700;letter-spacing:-.02em;margin-right:.6rem;white-space:nowrap}
.tabs{display:flex;gap:.2rem;flex:1;flex-wrap:wrap}
.tab{padding:.4rem .75rem;border-radius:8px;color:#aeb6c2;font-weight:600;font-size:.92rem}
.tab:hover{background:#161b24;color:#e8eaed}
.tab.active{background:#21402f;color:#dcf5e6}
.tab-btn{background:none;border:none;font:inherit;padding:.4rem .75rem;border-radius:8px;color:#aeb6c2;font-weight:600;font-size:.92rem;cursor:pointer}
.tab-btn:hover{background:#161b24;color:#e8eaed}
.acct{display:flex;align-items:center;gap:.6rem;color:#8b95a3;font-size:.88rem;white-space:nowrap}
.acct b{color:#e8eaed}
.acct .badge{font-size:.62rem}
.wrap{max-width:860px;margin:1.6rem auto;padding:0 1rem 4rem}
h1{font-size:1.5rem;margin:.2rem 0 .2rem}
h2{font-size:1.05rem;margin:2rem 0 .6rem;color:#cdd6e2}
.sub{color:#8b95a3;margin:0 0 1.2rem}
.card{background:#14171d;border:1px solid #232a35;border-radius:14px;padding:1.1rem 1.2rem;margin:.6rem 0}
.muted,.hint{color:#8b95a3}.hint{font-size:.88rem}
code{background:#0f1217;border:1px solid #232a35;border-radius:6px;padding:.1rem .4rem;font-family:ui-monospace,monospace;font-size:.84rem;color:#a8e6c0}
input,select,button,textarea{font:inherit;padding:.55rem .7rem;border-radius:9px;border:1px solid #2c333f;background:#161a22;color:#e8eaed}
input:focus,select:focus,textarea:focus{outline:none;border-color:#3a7a57;box-shadow:0 0 0 3px rgba(58,122,87,.18)}
input::placeholder{color:#6b7585}
/* custom-caret select (replaces the native OS dropdown chrome) */
select{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:1.95rem;
  background:#161a22 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b95a3' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E") no-repeat right .65rem center}
select:hover{border-color:#39414f}
/* toggle switch (styled checkbox) */
.switch{position:relative;display:inline-flex;align-items:center;gap:.55rem;cursor:pointer;user-select:none;color:#cdd6e2;font-size:.9rem;white-space:nowrap}
.switch input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.switch .track{position:relative;flex:none;width:40px;height:22px;border-radius:999px;background:#2c333f;border:1px solid #39414f;transition:background .15s,border-color .15s}
.switch .track::after{content:"";position:absolute;top:50%;left:2px;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;background:#cdd6e2;transition:left .15s,background .15s}
.switch:hover .track{border-color:#4a5365}
.switch input:checked + .track{background:#2f6f4f;border-color:#357a57}
.switch input:checked + .track::after{left:20px;background:#fff}
.switch input:focus-visible + .track{box-shadow:0 0 0 3px rgba(47,111,79,.45)}
/* label + control pairs sitting inline in a row */
.inline-field{display:inline-flex;align-items:center;gap:.45rem;color:#8b95a3;font-size:.9rem;white-space:nowrap}
textarea{width:100%;min-height:320px;font-family:ui-monospace,monospace;font-size:.9rem;line-height:1.5;resize:vertical}
button{cursor:pointer;font-weight:600}
.pill{display:inline-block;background:#1b2029;border:1px solid #2c333f;border-radius:8px;padding:.35rem .65rem;color:#cdd6e2;font-size:.83rem;font-weight:600}
.pill:hover{background:#222834;color:#fff}
.btn-primary{background:#2f6f4f;border-color:#357a57;color:#fff}
.btn-primary:hover{background:#357f5a}
.btn-ghost{background:#1b2029;border-color:#2c333f}
.btn-danger{background:#5a2230;border-color:#7a2f40;font-size:.85rem;padding:.35rem .6rem}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.4rem 0}
.row input,.row select{flex:1;min-width:140px}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:.45rem .5rem;border-bottom:1px solid #20252f;vertical-align:middle}
th{color:#8b95a3;font-size:.74rem;text-transform:uppercase;letter-spacing:.05em}
/* Pill badges. Base carries ALL the shape (padding, radius, font); variants
   only recolor — so a variant must always be paired with the base .badge. */
.badge{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.02em;line-height:1.4;
  background:#2f4f7f;color:#dce8ff;padding:.12rem .5rem;border-radius:999px;vertical-align:middle;white-space:nowrap}
.badge-ok{background:#234e36;color:#bff0d0}
.badge-owner{background:#4a3a1e;color:#ffd98a}
.badge-admin{background:#234e36;color:#bff0d0}
.badge-member{background:#222a35;color:#9aa4b2}
.badge-muted{background:#3a2a2f;color:#e6b9c4}
.dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;background:#3a4250;margin-right:.35rem;vertical-align:middle}
.dot.on{background:#46d17f;box-shadow:0 0 6px #46d17f}
@keyframes dotpulse{0%{box-shadow:0 0 0 0 rgba(70,209,127,.55)}70%{box-shadow:0 0 0 5px rgba(70,209,127,0)}100%{box-shadow:0 0 0 0 rgba(70,209,127,0)}}
.dot.pulse{animation:dotpulse 1.5s ease-out infinite}
.flash{background:#1d3a28;border:1px solid #2f6f4f;color:#cdeede;padding:.55rem .85rem;border-radius:9px;margin:.6rem 0;word-break:break-word}
.flash-err{background:#3a1d24;border:1px solid #6b2c39;color:#ffb3c0}
.world{background:#14171d;border:1px solid #232a35;border-radius:12px;padding:.9rem 1rem;margin:.55rem 0}
/* confirmation modal (type-to-confirm destructive actions) */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.62);display:none;place-items:center;z-index:100;padding:1rem}
.modal-overlay.open{display:grid}
.modal{background:#14171d;border:1px solid #2c333f;border-radius:14px;padding:1.3rem 1.4rem;max-width:430px;width:100%;box-shadow:0 24px 70px rgba(0,0,0,.6)}
.modal h3{margin:0 0 .6rem;font-size:1.1rem}
/* wider container for dense admin tables (desktop) */
.wrap.wide{max-width:1120px}
.nowrap{white-space:nowrap}
/* invite-status filter tabs */
.filters{display:flex;gap:.35rem;flex-wrap:wrap;margin:.2rem 0 .6rem}
.filters a{padding:.3rem .65rem;border-radius:999px;border:1px solid #2c333f;color:#aeb6c2;font-size:.83rem;font-weight:600}
.filters a:hover{background:#161b24;color:#e8eaed}
.filters a.on{background:#21402f;border-color:#357a57;color:#dcf5e6}
/* ── phones ─────────────────────────────────────────────────────────────── */
@media (max-width:640px){
  .nav{flex-wrap:wrap;gap:.35rem;padding:.55rem .8rem}
  .brand{order:1;margin-right:auto}
  .acct{order:2}
  .tabs{order:3;width:100%;margin-top:.15rem}
  .wrap{margin:1.1rem auto;padding:0 .8rem 3rem}
  h1{font-size:1.3rem}
  /* opt-in stacked-card tables: each row becomes a labelled card */
  table.adm thead{position:absolute;left:-9999px}
  table.adm tr{display:block;border:1px solid #232a35;border-radius:11px;padding:.5rem .75rem;margin:.55rem 0;background:#14171d}
  table.adm td{display:flex;justify-content:space-between;gap:.75rem;align-items:center;border:0;padding:.3rem 0;text-align:right;word-break:break-word}
  table.adm td::before{content:attr(data-label);color:#8b95a3;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;text-align:left;flex:none}
  table.adm td:empty{display:none}
  table.adm td[data-label=""]::before{content:""}
  table.adm td > div{flex-wrap:wrap;justify-content:flex-end}
}
`;

// Floating feedback widget: a small FAB that opens a compact popup version of
// the Feedback form, submitting to /feedback over fetch (X-Feedback-Widget: 1 →
// the route answers with JSON instead of redirecting). Fully self-contained
// (namespaced `fbw-` styles + ids) so it can be dropped into any page, including
// the static Play client. Shown on every page EXCEPT the Feedback tab itself.
export function feedbackWidget(): string {
  return `
<style>
.fbw-fab{position:fixed;right:18px;bottom:18px;z-index:90;display:inline-flex;align-items:center;gap:.4rem;padding:.6rem .9rem;border-radius:999px;border:1px solid #357a57;background:#2f6f4f;color:#fff;font:600 .9rem ui-sans-serif,system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.fbw-fab:hover{background:#357f5a}
.fbw-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:120;display:none;align-items:flex-end;justify-content:flex-end;padding:1rem}
.fbw-overlay.open{display:flex}
.fbw-modal{width:100%;max-width:380px;background:#14171d;border:1px solid #2c333f;border-radius:14px;padding:1.05rem 1.15rem;box-shadow:0 24px 70px rgba(0,0,0,.6);color:#e8eaed;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;margin:0 0 64px}
.fbw-modal h3{margin:0 0 .15rem;font-size:1.08rem}
.fbw-sub{color:#8b95a3;font-size:.84rem;margin:0 0 .7rem}
.fbw-modal label{display:block;color:#8b95a3;font-size:.8rem;margin:.55rem 0 .25rem}
.fbw-modal select,.fbw-modal textarea,.fbw-modal input{width:100%;font:inherit;padding:.5rem .65rem;border-radius:9px;border:1px solid #2c333f;background:#161a22;color:#e8eaed;box-sizing:border-box}
.fbw-modal textarea{min-height:88px;resize:vertical;font-family:inherit;font-size:.95rem}
.fbw-modal select:focus,.fbw-modal textarea:focus,.fbw-modal input:focus{outline:none;border-color:#3a7a57;box-shadow:0 0 0 3px rgba(58,122,87,.18)}
.fbw-actions{display:flex;gap:.5rem;justify-content:flex-end;align-items:center;margin-top:.9rem}
.fbw-btn{font:600 .9rem ui-sans-serif,system-ui,-apple-system,sans-serif;padding:.5rem .8rem;border-radius:9px;cursor:pointer;border:1px solid #2c333f;background:#1b2029;color:#cdd6e2}
.fbw-btn.primary{background:#2f6f4f;border-color:#357a57;color:#fff}
.fbw-btn.primary:hover{background:#357f5a}
.fbw-btn:disabled{opacity:.6;cursor:default}
.fbw-note{font-size:.86rem;margin-top:.6rem;border-radius:9px;padding:.5rem .7rem;display:none;word-break:break-word}
.fbw-note.ok{display:block;background:#1d3a28;border:1px solid #2f6f4f;color:#cdeede}
.fbw-note.err{display:block;background:#3a1d24;border:1px solid #6b2c39;color:#ffb3c0}
.fbw-x{position:absolute;top:.7rem;right:.85rem;background:none;border:none;color:#8b95a3;font-size:1.3rem;line-height:1;cursor:pointer}
.fbw-modal{position:relative}
.fbw-fab .ic{display:inline-block;width:1.05em;height:1.05em;vertical-align:-.16em;flex:none;animation:fbw-bob 2.6s ease-in-out infinite}
@keyframes fbw-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@media (max-width:640px){.fbw-fab{right:12px;bottom:12px}.fbw-overlay{padding:0}.fbw-modal{max-width:none;border-radius:14px 14px 0 0;margin-bottom:0}}
</style>
<button type="button" class="fbw-fab" id="fbw-open" aria-haspopup="dialog" aria-label="Send feedback">${icon("message")} Feedback</button>
<div class="fbw-overlay" id="fbw-overlay">
  <div class="fbw-modal" role="dialog" aria-modal="true" aria-label="Send feedback">
    <button type="button" class="fbw-x" id="fbw-close" aria-label="Close">&times;</button>
    <h3>Send feedback</h3>
    <p class="fbw-sub">Idea, feature request, or bug — we'll get it.</p>
    <form id="fbw-form">
      <label for="fbw-kind">Type</label>
      <select id="fbw-kind" name="kind">
        <option value="general">General feedback</option>
        <option value="feature">Feature request</option>
        <option value="bug">Bug report</option>
      </select>
      <label for="fbw-message">Tell us about it</label>
      <textarea id="fbw-message" name="message" required maxlength="4000" placeholder="What's on your mind…"></textarea>
      <label for="fbw-page">Where? <span style="opacity:.7">(optional)</span></label>
      <input id="fbw-page" name="page" maxlength="200" autocomplete="off" placeholder="e.g. the Worlds tab"/>
      <div class="fbw-note" id="fbw-note"></div>
      <div class="fbw-actions">
        <button type="button" class="fbw-btn" id="fbw-cancel">Cancel</button>
        <button type="submit" class="fbw-btn primary" id="fbw-submit">Send</button>
      </div>
    </form>
  </div>
</div>
<script>(function(){
  var o=document.getElementById("fbw-overlay"),openB=document.getElementById("fbw-open"),
      closeB=document.getElementById("fbw-close"),cancelB=document.getElementById("fbw-cancel"),
      form=document.getElementById("fbw-form"),note=document.getElementById("fbw-note"),
      submit=document.getElementById("fbw-submit");
  if(!o||!form)return;
  function openM(){o.classList.add("open");var t=document.getElementById("fbw-message");if(t)setTimeout(function(){t.focus();},60);}
  function closeM(){o.classList.remove("open");}
  openB&&openB.addEventListener("click",openM);
  closeB&&closeB.addEventListener("click",closeM);
  cancelB&&cancelB.addEventListener("click",closeM);
  o.addEventListener("click",function(e){if(e.target===o)closeM();});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&o.classList.contains("open"))closeM();});
  form.addEventListener("submit",function(e){
    e.preventDefault();
    note.className="fbw-note";note.textContent="";
    submit.disabled=true;submit.textContent="Sending…";
    fetch("/feedback",{method:"POST",headers:{"X-Feedback-Widget":"1"},body:new FormData(form),credentials:"same-origin"})
      .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};},function(){return{ok:r.ok,j:null};});})
      .then(function(res){
        submit.disabled=false;submit.textContent="Send";
        if(res.j&&res.j.ok){
          note.className="fbw-note ok";note.textContent=res.j.message||"Thanks! Your feedback was sent.";
          form.reset();setTimeout(closeM,2400);
        }else{
          note.className="fbw-note err";note.textContent=(res.j&&res.j.error)||"Something went wrong. Please try again.";
        }
      })
      .catch(function(){
        submit.disabled=false;submit.textContent="Send";
        note.className="fbw-note err";note.textContent="Network error. Please try again.";
      });
  });
})();</script>`;
}

interface ShellOpts {
  title: string;
  active: string; // play | worlds | friends | admin | guide | feedback | profile
  username: string;
  admin: boolean;
  body: string;
  msg?: string | null;
  err?: string | null;
  wide?: boolean; // use the wider container (dense admin tables)
}

export function shell(o: ShellOpts): string {
  const tab = (id: string, href: string, label: string, key?: string) =>
    `<a class="tab${o.active === id ? " active" : ""}" href="${href}"${key ? ` title="Shortcut: ${key}"` : ""}>${label}</a>`;
  // Pulsing dot on the Friends tab when the viewer has pending incoming requests.
  const friendReqs = pendingFriendRequestCount(o.username);
  const friendsLabel = "Friends" + (friendReqs > 0
    ? ' <span class="dot on pulse" title="You have new friend requests" style="margin:0 0 0 .35rem"></span>'
    : "");
  // Single-key nav shortcuts (ignored while typing). 'a' only for admins.
  const navKeys: Record<string, string> = { w: "/worlds", f: "/friends", g: "/help", b: "/feedback", p: "/profile", y: "/" };
  if (o.admin) navKeys.a = "/admin";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"/><link rel="apple-touch-icon" href="/email-logo.png"/>
<title>${esc(o.title)}</title><style>${SHARED_CSS}${ICON_CSS}</style></head><body>
<nav class="nav">
  <span class="brand">${icon("pickaxe")} Minecraft</span>
  <div class="tabs">
    ${tab("play", "/", "Play", "Y")}
    ${tab("worlds", "/worlds", "Worlds", "W")}
    ${tab("friends", "/friends", friendsLabel, "F")}
    ${o.admin ? tab("admin", "/admin", "Admin", "A") : ""}
    ${tab("guide", "/help", "Guide", "G")}
    ${tab("feedback", "/feedback", "Feedback", "B")}
    ${tab("profile", "/profile", "Profile", "P")}
  </div>
  <div class="acct"><span><b>${esc(o.username)}</b>${o.admin ? ' <span class="badge badge-admin">admin</span>' : ""}</span><form method="post" action="/logout" style="margin:0;display:inline"><button class="tab-btn" type="submit">Log out</button></form></div>
</nav>
<div class="wrap${o.wide ? " wide" : ""}">
  ${o.msg ? `<div class="flash">${esc(o.msg)}</div>` : ""}
  ${o.err ? `<div class="flash flash-err">${esc(o.err)}</div>` : ""}
  ${o.body}
</div>
<script>(function(){var m=${JSON.stringify(navKeys)};document.addEventListener("keydown",function(e){if(e.ctrlKey||e.metaKey||e.altKey)return;var t=e.target||{},n=(t.tagName||"").toUpperCase();if(n==="INPUT"||n==="TEXTAREA"||n==="SELECT"||t.isContentEditable)return;var d=m[(e.key||"").toLowerCase()];if(d){e.preventDefault();location.href=d;}});})();</script>
${o.active !== "feedback" ? feedbackWidget() : ""}
</body></html>`;
}
