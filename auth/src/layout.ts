// Shared page shell: a dashboard frame (sidebar nav on desktop, top bar on
// phones) + the dark theme and building blocks (tiles, panels, server split)
// every server-rendered page uses. Home (/) is rendered here too, so the static
// clients/index.html is no longer the Play page.

import { pendingFriendRequestCount } from "./db.ts";
import type { ServerId } from "./servers.ts";

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
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
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
:root{color-scheme:dark;
  --bg:#0a0c10;--panel:#11151b;--panel2:#161b23;--sunk:#0d1015;--line:#212935;--line2:#2c3542;
  --text:#e6e9ee;--muted:#8b95a3;--dim:#6b7585;--link:#7fb3ff;
  --accent:#46d17f;--accent-d:#2f6f4f;--accent-b:#357a57;
  --c18:#46d17f;--c18-bg:rgba(70,209,127,.09);--c18-line:#24503a;
  --c26:#5aa9ff;--c26-bg:rgba(90,169,255,.09);--c26-line:#244666;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;--side:228px}
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--text);background:var(--bg);min-height:100vh}
a{color:var(--link);text-decoration:none}
.codeblock{position:relative;margin:.2rem 0 .6rem}
.codeblock code{display:block;word-break:break-all;padding:.55rem 4.6rem .55rem .7rem;line-height:1.5}
.codeblock .copy-btn{position:absolute;top:.35rem;right:.35rem;padding:.25rem .6rem;font-size:.78rem;border-radius:6px;background:#1f2631;color:#d7dde6;border:1px solid var(--line2);cursor:pointer}
.codeblock .copy-btn:hover{background:#273040}
.codeblock .copy-btn.done{background:var(--accent-d);border-color:var(--accent-d);color:#fff}
code[data-copy]{cursor:pointer}
/* ── app frame: sidebar (desktop) / top bar (phones) ─────────────────────── */
.app{display:grid;grid-template-columns:var(--side) minmax(0,1fr);min-height:100vh}
.nav{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:.2rem;padding:1rem .75rem;
  background:linear-gradient(180deg,#0f1318,#0b0e12);border-right:1px solid var(--line);overflow-y:auto}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:800;letter-spacing:-.02em;font-size:1.02rem;padding:.25rem .55rem .9rem;white-space:nowrap;color:var(--text)}
.brand .ic{font-size:1.25rem}
.brand small{display:block;font:600 .62rem/1.2 var(--mono);color:var(--dim);letter-spacing:.12em;text-transform:uppercase}
.tabs{display:flex;flex-direction:column;gap:.15rem;flex:1}
.tabs .sect{font:700 .62rem var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);padding:.8rem .6rem .3rem}
.tab{display:flex;align-items:center;gap:.6rem;padding:.48rem .6rem;border-radius:8px;color:#aeb6c2;font-weight:600;font-size:.9rem;border:1px solid transparent;position:relative}
.tab .ic{font-size:1.02rem;opacity:.85}
.tab kbd{margin-left:auto;font:600 .64rem var(--mono);color:var(--dim);border:1px solid var(--line2);border-radius:4px;padding:0 .3rem;line-height:1.5}
.tab:hover{background:var(--panel2);color:var(--text)}
.tab.active{background:linear-gradient(90deg,rgba(70,209,127,.16),rgba(70,209,127,.04));border-color:#244a36;color:#dcf5e6}
.tab.active::before{content:"";position:absolute;left:-.75rem;top:22%;bottom:22%;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.tab.active .ic{opacity:1;color:var(--accent)}
.tab-btn{background:none;border:1px solid var(--line2);font:inherit;padding:.3rem .6rem;border-radius:7px;color:#aeb6c2;font-weight:600;font-size:.8rem;cursor:pointer}
.tab-btn:hover{background:var(--panel2);color:var(--text)}
.acct{display:flex;align-items:center;justify-content:space-between;gap:.5rem;color:var(--muted);font-size:.86rem;white-space:nowrap;
  border-top:1px solid var(--line);padding:.8rem .35rem 0;margin-top:.6rem}
.acct b{color:var(--text)}
.acct .badge{font-size:.6rem}
.main{min-width:0}
.wrap{max-width:1180px;margin:0 auto;padding:1.6rem 1.6rem 5rem}
.wrap.wide{max-width:1320px}
/* ── page furniture ──────────────────────────────────────────────────────── */
h1{font-size:1.6rem;letter-spacing:-.025em;margin:.1rem 0 .2rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
h2{font:700 .72rem var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:2rem 0 .7rem;display:flex;align-items:center;gap:.5rem}
h2::after{content:"";flex:1;height:1px;background:var(--line)}
h2 .hint,h2 .badge{text-transform:none;letter-spacing:0;font-family:ui-sans-serif,system-ui,sans-serif}
h3{font-size:1rem;margin:0 0 .5rem}
.sub{color:var(--muted);margin:0 0 1.2rem;max-width:72ch}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:0 0 1.3rem;padding-bottom:1.1rem;border-bottom:1px solid var(--line)}
.page-head .sub{margin:.25rem 0 0}
.page-head .eyebrow{font:700 .66rem var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.page-head .actions{display:flex;gap:.5rem;flex-wrap:wrap}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1.05rem 1.15rem;margin:.6rem 0}
.card > table:not(.adm){display:block;overflow-x:auto}
.card td code{white-space:nowrap}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:.6rem 0;overflow:hidden}
.panel-h{display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.7rem 1rem;border-bottom:1px solid var(--line);background:var(--panel2)}
.panel-h h3{margin:0;font-size:.92rem;display:flex;align-items:center;gap:.45rem}
.panel-b{padding:.9rem 1rem}
.muted,.hint{color:var(--muted)}.hint{font-size:.88rem}
/* stat tiles */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.7rem;margin:0 0 1.2rem}
.tile{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.85rem 1rem;overflow:hidden}
.tile .k{font:700 .64rem var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:.4rem}
.tile .v{font:800 1.9rem/1.15 var(--mono);letter-spacing:-.03em;margin:.3rem 0 .1rem;color:var(--text)}
.tile .v.sm{font-size:1.15rem;margin:.55rem 0 .25rem;overflow-wrap:anywhere}
.tile .f{font-size:.8rem;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile::after{content:"";position:absolute;inset:auto 0 0 0;height:2px;background:var(--line2)}
.tile.t18::after{background:var(--c18)}.tile.t26::after{background:var(--c26)}.tile.tacc::after{background:#e3b34a}
.tile.t18 .v{color:#c9f3da}.tile.t26 .v{color:#cfe5ff}
/* card grid + 1.8/26 split */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.7rem;margin:.6rem 0}
.grid > .card,.grid > .world,.grid > .panel{margin:0}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem;align-items:start}
.cols > *{min-width:0}
.cols-3{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:1rem;align-items:start}
.cols-3 > *{min-width:0}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:1rem;margin:.6rem 0}
.srv{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;min-width:0}
.srv-h{display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.85rem 1rem;border-bottom:1px solid var(--line)}
.srv-h .name{display:flex;align-items:center;gap:.55rem;font-weight:800;font-size:1.05rem;letter-spacing:-.01em}
.srv-h .ver{font:700 .62rem var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.srv-b{padding:.75rem 1rem 1rem}
.srv-18{border-color:var(--c18-line)}.srv-18 .srv-h{background:linear-gradient(90deg,var(--c18-bg),transparent)}
.srv-26{border-color:var(--c26-line)}.srv-26 .srv-h{background:linear-gradient(90deg,var(--c26-bg),transparent)}
.srv .chip{font:700 .7rem var(--mono);padding:.15rem .5rem;border-radius:999px;border:1px solid var(--line2);color:var(--muted);white-space:nowrap}
.srv-18 .chip.live{color:#bff0d0;border-color:var(--c18-line);background:var(--c18-bg)}
.srv-26 .chip.live{color:#cfe5ff;border-color:var(--c26-line);background:var(--c26-bg)}
.srv .sect{font:700 .62rem var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--dim);margin:.9rem 0 .35rem}
.srv .sect:first-child{margin-top:.1rem}
/* world rows / cards */
.world{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:.7rem .85rem;margin:.45rem 0}
.world:hover{border-color:var(--line2)}
.wname{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;min-width:0}
.wname b{font-size:.98rem}
.wmeta{font-size:.8rem;color:var(--dim);margin-top:.15rem}
.wacts{display:flex;gap:.35rem;flex-wrap:wrap;align-items:center;margin-top:.55rem}
.empty{border:1px dashed var(--line2);border-radius:10px;padding:.8rem .9rem;color:var(--muted);font-size:.88rem;margin:.45rem 0}
code{background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:.1rem .4rem;font-family:var(--mono);font-size:.82rem;color:#a8e6c0}
input,select,button,textarea{font:inherit;padding:.55rem .7rem;border-radius:9px;border:1px solid var(--line2);background:#141920;color:var(--text)}
input:focus,select:focus,textarea:focus{outline:none;border-color:#3a7a57;box-shadow:0 0 0 3px rgba(58,122,87,.18)}
input::placeholder{color:var(--dim)}
select{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:1.95rem;
  background:#141920 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b95a3' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E") no-repeat right .65rem center}
select:hover{border-color:#39414f}
.switch{position:relative;display:inline-flex;align-items:center;gap:.55rem;cursor:pointer;user-select:none;color:#cdd6e2;font-size:.9rem;white-space:nowrap}
.switch input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.switch .track{position:relative;flex:none;width:40px;height:22px;border-radius:999px;background:#2c333f;border:1px solid #39414f;transition:background .15s,border-color .15s}
.switch .track::after{content:"";position:absolute;top:50%;left:2px;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;background:#cdd6e2;transition:left .15s,background .15s}
.switch:hover .track{border-color:#4a5365}
.switch input:checked + .track{background:var(--accent-d);border-color:var(--accent-b)}
.switch input:checked + .track::after{left:20px;background:#fff}
.switch input:focus-visible + .track{box-shadow:0 0 0 3px rgba(47,111,79,.45)}
.inline-field{display:inline-flex;align-items:center;gap:.45rem;color:var(--muted);font-size:.9rem;white-space:nowrap}
textarea{width:100%;min-height:320px;font-family:var(--mono);font-size:.9rem;line-height:1.5;resize:vertical}
button{cursor:pointer;font-weight:600}
button:hover{border-color:#3a4352}
.pill{display:inline-flex;align-items:center;gap:.3rem;background:#1a2029;border:1px solid var(--line2);border-radius:8px;padding:.3rem .6rem;color:#cdd6e2;font-size:.82rem;font-weight:600;white-space:nowrap}
.pill:hover{background:#222a35;color:#fff}
.btn-primary{background:var(--accent-d);border-color:var(--accent-b);color:#fff}
.btn-primary:hover{background:#357f5a}
.btn-ghost{background:#1a2029;border-color:var(--line2)}
.btn-ghost:hover{background:#222a35}
.btn-danger{background:#4a1d28;border-color:#7a2f40;font-size:.85rem;padding:.35rem .6rem}
.btn-danger:hover{background:#5a2230}
/* big launch buttons (Home) */
.launch{display:flex;align-items:center;justify-content:center;gap:.55rem;width:100%;padding:.9rem 1rem;border-radius:11px;border:1px solid var(--accent-b);
  background:var(--accent-d);color:#fff;font-weight:800;font-size:1.05rem}
.launch:hover{background:#357f5a;color:#fff}
.launch.l26{border-color:#2f5f8f;background:#24527f}.launch.l26:hover{background:#2b5f92}
.launch .rec{font:700 .62rem var(--mono);letter-spacing:.08em;text-transform:uppercase;background:rgba(255,255,255,.16);padding:.12rem .4rem;border-radius:5px}
.spinner{display:inline-block;width:1em;height:1em;border:2px solid currentColor;border-right-color:transparent;
  border-radius:50%;animation:spin .7s linear infinite;vertical-align:-.15em}
@keyframes spin{to{transform:rotate(360deg)}}
.progress-wrap{display:none;margin:.5rem 0}
.progress-wrap.active{display:block}
.progress-track{height:8px;border-radius:999px;background:#1b2029;border:1px solid var(--line2);overflow:hidden}
.progress-fill{height:100%;width:0%;background:var(--accent-d);transition:width .2s ease}
.progress-fill.indeterminate{width:35%;animation:progress-slide 1.1s ease-in-out infinite}
@keyframes progress-slide{0%{margin-left:0%}50%{margin-left:65%}100%{margin-left:0%}}
.progress-label{font-size:.85rem;color:var(--muted);margin-top:.35rem}
.progress-label.err{color:#e8a3ae}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.4rem 0}
.row input,.row select{flex:1;min-width:140px}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:.5rem .55rem;border-bottom:1px solid #1d242e;vertical-align:middle}
th{color:var(--muted);font:700 .64rem var(--mono);text-transform:uppercase;letter-spacing:.12em}
tbody tr:hover td{background:rgba(255,255,255,.015)}
.badge{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.02em;line-height:1.4;
  background:#2f4f7f;color:#dce8ff;padding:.12rem .5rem;border-radius:999px;vertical-align:middle;white-space:nowrap}
.badge-ok{background:#234e36;color:#bff0d0}
.badge-owner{background:#4a3a1e;color:#ffd98a}
.badge-admin{background:#234e36;color:#bff0d0}
.badge-member{background:#222a35;color:#9aa4b2}
.badge-muted{background:#3a2a2f;color:#e6b9c4}
.ed{font-family:var(--mono);letter-spacing:.02em}
.ed-18{background:var(--c18-bg);color:#bff0d0;box-shadow:inset 0 0 0 1px var(--c18-line)}
.ed-26{background:var(--c26-bg);color:#cfe5ff;box-shadow:inset 0 0 0 1px var(--c26-line)}
.dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;background:#3a4250;margin-right:.35rem;vertical-align:middle}
.dot.on{background:#46d17f;box-shadow:0 0 6px #46d17f}
@keyframes dotpulse{0%{box-shadow:0 0 0 0 rgba(70,209,127,.55)}70%{box-shadow:0 0 0 5px rgba(70,209,127,0)}100%{box-shadow:0 0 0 0 rgba(70,209,127,0)}}
.dot.pulse{animation:dotpulse 1.5s ease-out infinite}
.flash{background:#13291d;border:1px solid var(--accent-d);color:#cdeede;padding:.6rem .9rem;border-radius:10px;margin:0 0 1rem;word-break:break-word}
.flash-err{background:#2c151b;border:1px solid #6b2c39;color:#ffb3c0}
/* scrollable feed box (What's new) */
.feed{max-height:340px;overflow-y:auto;overscroll-behavior:contain;padding-right:.3rem;scrollbar-width:thin;scrollbar-color:#2c3542 transparent}
.feed.open{max-height:min(70vh,640px)}
.feed .rel{padding:.75rem 0;border-top:1px solid var(--line)}
.feed .rel:first-child{border-top:0;padding-top:0}
.feed .when{font:700 .64rem var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.feed .title{font-weight:700;margin:.15rem 0 .35rem}
.feed ul{margin:0;padding-left:1.1rem;color:#c2cad6;font-size:.88rem}
.feed li{margin:.25rem 0}
.feed .rel.old{display:none}
.feed.open .rel.old{display:block}
.feed-more{width:100%;margin-top:.7rem;background:#1a2029;border-color:var(--line2);font-size:.85rem}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.62);display:none;place-items:center;z-index:100;padding:1rem}
.modal-overlay.open{display:grid}
.modal{background:var(--panel);border:1px solid var(--line2);border-radius:14px;padding:1.3rem 1.4rem;max-width:430px;width:100%;box-shadow:0 24px 70px rgba(0,0,0,.6)}
.modal h3{margin:0 0 .6rem;font-size:1.1rem}
.nowrap{white-space:nowrap}
.filters{display:flex;gap:.35rem;flex-wrap:wrap;margin:.2rem 0 .6rem}
.filters a{padding:.3rem .65rem;border-radius:999px;border:1px solid var(--line2);color:#aeb6c2;font-size:.83rem;font-weight:600}
.filters a:hover{background:var(--panel2);color:var(--text)}
.filters a.on{background:#21402f;border-color:var(--accent-b);color:#dcf5e6}
/* ── tablets: narrower sidebar, stacked columns ─────────────────────────── */
@media (max-width:1100px){
  .cols,.cols-3{grid-template-columns:minmax(0,1fr)}
}
/* ── phones + small tablets: sidebar becomes a top bar ──────────────────── */
@media (max-width:900px){
  .app{grid-template-columns:minmax(0,1fr)}
  .nav{position:sticky;top:0;z-index:10;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:.35rem;padding:.55rem .8rem .45rem;
    background:rgba(11,14,18,.92);backdrop-filter:blur(8px);border-right:0;border-bottom:1px solid var(--line);overflow:visible}
  .brand{order:1;margin-right:auto;padding:.1rem .2rem}
  .brand small{display:none}
  .acct{order:2;border-top:0;padding:0;margin:0;gap:.55rem}
  .tabs{order:3;flex-direction:row;flex:0 0 100%;width:100%;overflow-x:auto;scrollbar-width:none;gap:.2rem;padding-bottom:.1rem}
  .tabs::-webkit-scrollbar{display:none}
  .tabs .sect{display:none}
  .tab{flex:none;padding:.38rem .65rem;font-size:.88rem}
  .tab kbd{display:none}
  .tab.active::before{display:none}
  .wrap{padding:1.1rem .8rem 4.5rem}
  h1{font-size:1.35rem}
  .tile .v{font-size:1.55rem}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem}
  /* opt-in stacked-card tables: each row becomes a labelled card */
  table.adm thead{position:absolute;left:-9999px}
  table.adm tr{display:block;border:1px solid var(--line);border-radius:11px;padding:.5rem .75rem;margin:.55rem 0;background:var(--panel)}
  table.adm td{display:flex;justify-content:space-between;gap:.75rem;align-items:center;border:0;padding:.3rem 0;text-align:right;word-break:break-word}
  table.adm td::before{content:attr(data-label);color:var(--muted);font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;text-align:left;flex:none}
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
  active: string; // play | worlds | friends | claude | admin | guide | feedback | profile
  username: string;
  admin: boolean;
  body: string;
  msg?: string | null;
  err?: string | null;
  wide?: boolean; // use the wider container (dense admin tables)
  /** Extra single-key shortcuts for this page (override the nav map). */
  keys?: Record<string, string>;
}

// ── dashboard building blocks (shared by every page) ─────────────────────────
/** Edition tag shown on every world/player row: 1.8 green, 26 blue. */
export function edBadge(srv: ServerId): string {
  return srv === "26"
    ? `<span class="badge ed ed-26" title="Minecraft 26 server">26</span>`
    : `<span class="badge ed ed-18" title="Minecraft 1.8 server">1.8</span>`;
}
/** Page header: eyebrow + title + one-line description, optional right-side actions. */
export function pageHead(o: { eyebrow?: string; title: string; sub?: string; actions?: string }): string {
  return `<div class="page-head"><div>${o.eyebrow ? `<div class="eyebrow">${esc(o.eyebrow)}</div>` : ""}<h1>${o.title}</h1>${o.sub ? `<p class="sub">${o.sub}</p>` : ""}</div>${o.actions ? `<div class="actions">${o.actions}</div>` : ""}</div>`;
}
export interface Tile { k: string; v: string | number; f?: string; tone?: "18" | "26" | "acc"; icon?: string; sm?: boolean }
/** Row of stat tiles. Values are escaped; `f` (footnote) may contain markup. */
export function tiles(list: Tile[]): string {
  return `<div class="stats">${list.map((t) => `<div class="tile${t.tone ? " t" + t.tone : ""}"><div class="k">${t.icon ? icon(t.icon) : ""}${esc(t.k)}</div><div class="v${t.sm ? " sm" : ""}">${esc(String(t.v))}</div>${t.f ? `<div class="f">${t.f}</div>` : ""}</div>`).join("")}</div>`;
}
/** Card with a header bar. */
export function panel(title: string, inner: string, right = ""): string {
  return `<div class="panel"><div class="panel-h"><h3>${title}</h3>${right}</div><div class="panel-b">${inner}</div></div>`;
}

export function shell(o: ShellOpts): string {
  const tab = (id: string, href: string, label: string, ic: string, key?: string) =>
    `<a class="tab${o.active === id ? " active" : ""}" href="${href}"${o.active === id ? ' aria-current="page"' : ""}${key ? ` title="Shortcut: ${key}"` : ""}>${icon(ic)}<span>${label}</span>${key ? `<kbd>${key}</kbd>` : ""}</a>`;
  // Pulsing dot on the Friends tab when the viewer has pending incoming requests.
  const friendReqs = pendingFriendRequestCount(o.username);
  const friendsLabel = "Friends" + (friendReqs > 0
    ? ' <span class="dot on pulse" title="You have new friend requests" style="margin:0 0 0 .35rem"></span>'
    : "");
  // Single-key nav shortcuts (ignored while typing). 'a' only for admins.
  const navKeys: Record<string, string> = { w: "/worlds", f: "/friends", c: "/claude", g: "/help", b: "/feedback", p: "/profile", y: "/" };
  if (o.admin) navKeys.a = "/admin";
  Object.assign(navKeys, o.keys || {});
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"/><link rel="apple-touch-icon" href="/email-logo.png"/>
<title>${esc(o.title)} · Minecraft</title><style>${SHARED_CSS}${ICON_CSS}</style></head><body>
<div class="app">
<nav class="nav" aria-label="Panel">
  <a class="brand" href="/">${icon("pickaxe")}<span>Minecraft<small>Command center</small></span></a>
  <div class="tabs">
    <div class="sect">Play</div>
    ${tab("play", "/", "Home", "home", "Y")}
    ${tab("worlds", "/worlds", "Worlds", "globe", "W")}
    ${tab("friends", "/friends", friendsLabel, "users", "F")}
    ${tab("claude", "/claude", "Claude", "sparkles", "C")}
    <div class="sect">Help</div>
    ${tab("guide", "/help", "Guide", "book", "G")}
    ${tab("feedback", "/feedback", "Feedback", "message", "B")}
    ${tab("profile", "/profile", "Profile", "user", "P")}
    ${o.admin ? `<div class="sect">Manage</div>${tab("admin", "/admin", "Admin", "shield", "A")}` : ""}
  </div>
  <div class="acct"><span><b>${esc(o.username)}</b>${o.admin ? ' <span class="badge badge-admin">admin</span>' : ""}</span><form method="post" action="/logout" style="margin:0;display:inline"><button class="tab-btn" type="submit">Log out</button></form></div>
</nav>
<main class="main"><div class="wrap${o.wide ? " wide" : ""}">
  ${o.msg ? `<div class="flash">${esc(o.msg)}</div>` : ""}
  ${o.err ? `<div class="flash flash-err">${esc(o.err)}</div>` : ""}
  ${o.body}
</div></main>
</div>
<script>(function(){var m=${JSON.stringify(navKeys)};document.addEventListener("keydown",function(e){if(e.ctrlKey||e.metaKey||e.altKey)return;var t=e.target||{},n=(t.tagName||"").toUpperCase();if(n==="INPUT"||n==="TEXTAREA"||n==="SELECT"||t.isContentEditable)return;var d=m[(e.key||"").toLowerCase()];if(!d)return;e.preventDefault();if(d.charAt(0)==="#"){var el=document.querySelector(d);if(el)el.click();return;}location.href=d;});})();</script>
<script>(function(){
  function copy(text, done){
    function ok(){ done(true); }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
    function fallback(){ var t=document.createElement("textarea"); t.value=text; t.style.position="fixed"; t.style.opacity="0"; document.body.appendChild(t); t.select(); try{ document.execCommand("copy"); ok(); }catch(e){ done(false); } document.body.removeChild(t); }
  }
  // Block code: <div class="codeblock"><code>…</code></div> gets a Copy button.
  document.querySelectorAll(".codeblock").forEach(function(box){
    var code = box.querySelector("code"); if (!code) return;
    var b = document.createElement("button"); b.type="button"; b.className="copy-btn"; b.textContent="Copy";
    b.addEventListener("click", function(){ copy(code.textContent, function(ok){ b.textContent = ok ? "Copied" : "Copy failed"; b.classList.toggle("done", ok); setTimeout(function(){ b.textContent="Copy"; b.classList.remove("done"); }, 1600); }); });
    box.appendChild(b);
  });
  // Inline code with data-copy: click to copy.
  document.querySelectorAll("code[data-copy]").forEach(function(c){
    var orig = c.textContent, busy = false;
    c.addEventListener("click", function(){ if (busy) return; copy(orig, function(ok){ if(!ok) return; busy = true; c.textContent="copied"; setTimeout(function(){ c.textContent=orig; busy = false; }, 1000); }); });
  });
})();</script>
${o.active !== "feedback" ? feedbackWidget() : ""}
</body></html>`;
}
