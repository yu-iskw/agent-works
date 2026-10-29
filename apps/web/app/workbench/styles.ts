export const styles = String.raw`
:root {
  color-scheme: light;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-2: #f0f2f5;
  --surface-3: #e6e9ee;
  --border: #d9dde4;
  --border-strong: #b9c0cb;
  --text: #16191f;
  --text-2: #464e5b;
  --text-3: #5d6676;
  --accent: #2f54d6;
  --accent-strong: #2341ad;
  --accent-soft: #e8edfc;
  --on-accent: #ffffff;
  --ok: #17703d;
  --ok-soft: #e3f4ea;
  --warn: #8a5300;
  --warn-soft: #fdf1dc;
  --danger: #b3261e;
  --danger-soft: #fbe7e5;
  --info: #255fa8;
  --info-soft: #e5effa;
  --sim: #6b3fb5;
  --sim-soft: #f1eafb;
  --focus: #2f54d6;
  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 1px 2px rgb(16 24 40 / 6%), 0 1px 3px rgb(16 24 40 / 8%);
  --shadow-lg: 0 12px 32px rgb(16 24 40 / 18%);
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px;
  --nav-w: 240px;
  --aside-w: 380px;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0f1216;
    --surface: #171b21;
    --surface-2: #1d222a;
    --surface-3: #262c36;
    --border: #2c333e;
    --border-strong: #3d4653;
    --text: #e8ebf0;
    --text-2: #bcc3ce;
    --text-3: #9aa3b1;
    --accent: #7d9bff;
    --accent-strong: #a3b8ff;
    --accent-soft: #1f2a4d;
    --on-accent: #0b1020;
    --ok: #5fd08e; --ok-soft: #13301f;
    --warn: #f0b34f; --warn-soft: #33260f;
    --danger: #ff8a80; --danger-soft: #3a1714;
    --info: #79b0f5; --info-soft: #132a45;
    --sim: #c3a2ff; --sim-soft: #2a1f42;
    --focus: #a3b8ff;
    --shadow: 0 1px 2px rgb(0 0 0 / 40%);
    --shadow-lg: 0 12px 32px rgb(0 0 0 / 55%);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; font: 15px/1.5 var(--font); color: var(--text); background: var(--bg); }
h1, h2, h3, h4 { line-height: 1.25; margin: 0; }
h1 { font-size: 1.5rem; font-weight: 650; letter-spacing: -0.01em; }
h2 { font-size: 1.05rem; font-weight: 650; }
h3 { font-size: 0.95rem; font-weight: 650; }
p { margin: 0; }
a { color: var(--accent); text-underline-offset: 2px; }
a:hover { color: var(--accent-strong); }
code, .mono { font-family: var(--mono); font-size: 0.86em; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
/* Sections focused as jump targets are not controls; the scroll position already shows them. */
[tabindex="-1"]:focus { outline: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: var(--space-3); top: -48px; z-index: 100; padding: var(--space-2) var(--space-4); background: var(--accent); color: var(--on-accent); border-radius: var(--radius-sm); }
.skip-link:focus { top: var(--space-3); }
.icon { width: 18px; height: 18px; flex: none; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.icon-sm { width: 15px; height: 15px; }

/* Shell */
.shell { background: linear-gradient(to right, var(--surface) calc(var(--nav-w) - 1px), var(--border) calc(var(--nav-w) - 1px), var(--border) var(--nav-w), transparent var(--nav-w)); display: grid; grid-template-columns: var(--nav-w) minmax(0, 1fr); grid-template-rows: auto 1fr; min-height: 100vh; }
.topbar { grid-column: 1 / -1; display: flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-5); height: 56px; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20; }
.brand { white-space: nowrap; display: flex; align-items: center; gap: var(--space-2); font-weight: 700; color: var(--text); text-decoration: none; letter-spacing: -0.01em; }
.brand-mark { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, var(--accent), #7a5cf0); display: grid; place-items: center; color: #fff; font-size: 0.8rem; font-weight: 800; }
.topbar-spacer { flex: 1; }
.env-badges { display: flex; gap: var(--space-2); flex-wrap: nowrap; min-width: 0; }
.user-chip { display: flex; align-items: center; gap: var(--space-2); font-size: 0.85rem; color: var(--text-2); }
.avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-strong); display: grid; place-items: center; font-weight: 700; font-size: 0.8rem; text-transform: uppercase; }
.sidenav { background: var(--surface); border-right: 1px solid var(--border); padding: var(--space-4) var(--space-3); position: sticky; top: 56px; height: calc(100vh - 56px); overflow-y: auto; }
.sidenav ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.nav-group { margin-top: var(--space-5); }
.nav-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); padding: 0 var(--space-3) var(--space-2); font-weight: 650; }
.nav-link { display: flex; align-items: center; gap: var(--space-3); padding: 8px var(--space-3); border-radius: var(--radius-sm); color: var(--text-2); text-decoration: none; font-weight: 550; }
.nav-link:hover { background: var(--surface-2); color: var(--text); }
.nav-link[aria-current="page"] { background: var(--accent-soft); color: var(--accent-strong); }
.nav-count { margin-left: auto; min-width: 22px; padding: 0 6px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); font-size: 0.75rem; font-weight: 700; text-align: center; }
.main { min-width: 0; padding: var(--space-5) var(--space-6) var(--space-6); }
.page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-5); }
.page-head p { color: var(--text-2); margin-top: var(--space-1); }
.breadcrumbs { font-size: 0.82rem; color: var(--text-3); margin-bottom: var(--space-2); }
.breadcrumbs ol { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; }
.breadcrumbs li + li::before { content: "/"; margin-right: var(--space-2); color: var(--border-strong); }
.breadcrumbs a { color: var(--text-2); }

/* Components */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.card-body { padding: var(--space-5); }
.card + .card { margin-top: var(--space-4); }
.stack > * + * { margin-top: var(--space-4); }
.stack-sm > * + * { margin-top: var(--space-2); }
.muted { color: var(--text-2); }
.subtle { color: var(--text-3); font-size: 0.85rem; }
.row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 0.75rem; font-weight: 650; border: 1px solid transparent; white-space: nowrap; }
.badge-sim { background: var(--sim-soft); color: var(--sim); border-color: color-mix(in srgb, var(--sim) 30%, transparent); }
.badge-model { background: var(--info-soft); color: var(--info); }
.badge-stub { background: var(--warn-soft); color: var(--warn); border-color: var(--warn); }
.badge-neutral { background: var(--surface-2); color: var(--text-2); border-color: var(--border); }
.status { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; white-space: nowrap; }
.status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.status-active { background: var(--info-soft); color: var(--info); }
.status-active::before { animation: pulse 1.4s ease-in-out infinite; }
.status-wait { background: var(--warn-soft); color: var(--warn); }
.status-ok { background: var(--ok-soft); color: var(--ok); }
.status-bad { background: var(--danger-soft); color: var(--danger); }
.status-neutral { background: var(--surface-2); color: var(--text-2); }
@keyframes pulse { 50% { opacity: 0.35; } }
@keyframes shimmer { 100% { background-position: -200% 0; } }
@keyframes spin { to { transform: rotate(360deg); } }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); min-height: 40px; padding: 0 var(--space-4); border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
.btn:hover { background: var(--surface-2); color: var(--text); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn-primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); color: var(--on-accent); }
.btn-approve { background: var(--ok); border-color: var(--ok); color: #fff; }
.btn-approve:hover { filter: brightness(0.92); background: var(--ok); color: #fff; }
.btn-danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--text-2); }
.btn-sm { min-height: 32px; padding: 0 var(--space-3); font-size: 0.85rem; }
.btn[disabled], .btn[aria-disabled="true"] { opacity: 0.6; cursor: not-allowed; }
.btn .spinner { display: none; }
.topbar .menu-button { display: none; }
.btn[data-pending="true"] .spinner { display: inline-block; }
.spinner { width: 15px; height: 15px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }

.alert { display: flex; gap: var(--space-3); padding: var(--space-4); border-radius: var(--radius); border: 1px solid; }
.alert .icon { margin-top: 2px; }
.alert-info { background: var(--info-soft); border-color: color-mix(in srgb, var(--info) 30%, transparent); }
.alert-warn { background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
.alert-danger { background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
.alert-ok { background: var(--ok-soft); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
.alert-sim { background: var(--sim-soft); border-color: color-mix(in srgb, var(--sim) 30%, transparent); }
.alert h2, .alert h3 { font-size: 0.95rem; margin-bottom: 2px; }
.alert .actions { margin-top: var(--space-3); }

/* Composer */
.composer { padding: var(--space-5); }
.composer label { display: block; font-weight: 650; margin-bottom: var(--space-2); }
.composer textarea { width: 100%; min-height: 132px; resize: vertical; padding: var(--space-3) var(--space-4); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; line-height: 1.55; }
.composer textarea:focus-visible { outline-offset: 0; }
.composer textarea[aria-invalid="true"] { border-color: var(--danger); }
.composer-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-3); }
.field-error { color: var(--danger); font-weight: 600; margin-top: var(--space-2); }
.kbd { font-family: var(--mono); font-size: 0.78rem; padding: 1px 6px; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px; background: var(--surface-2); }
.suggestions { display: grid; gap: var(--space-2); margin-top: var(--space-4); }
.suggestion { text-align: left; padding: var(--space-3) var(--space-4); border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); background: transparent; color: var(--text-2); font: inherit; cursor: pointer; }
.suggestion:hover { border-color: var(--accent); color: var(--text); background: var(--accent-soft); }

/* Task list */
.task-list { list-style: none; margin: 0; padding: 0; }
.task-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2) var(--space-4); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
.task-item:first-child { border-top: 0; }
.task-item a.task-title { font-weight: 650; color: var(--text); text-decoration: none; overflow-wrap: anywhere; }
.task-item a.task-title:hover { color: var(--accent); text-decoration: underline; }
.task-meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--space-3); color: var(--text-3); font-size: 0.82rem; }
.empty { text-align: center; padding: var(--space-6) var(--space-5); }
.empty .icon { width: 36px; height: 36px; color: var(--text-3); margin-bottom: var(--space-3); }
.empty h2 { margin-bottom: var(--space-2); }

/* Task detail */
.task-layout { display: grid; grid-template-columns: minmax(0, 1fr) var(--aside-w); gap: var(--space-5); align-items: start; }
.task-aside { display: grid; gap: var(--space-4); }
.jump { display: none; }
.turn { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--space-3); }
.turn + .turn { margin-top: var(--space-4); }
.turn-avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-size: 0.75rem; font-weight: 800; }
.turn-user .turn-avatar { background: var(--surface-3); color: var(--text-2); }
.turn-agent .turn-avatar { background: linear-gradient(135deg, var(--accent), #7a5cf0); color: #fff; }
.turn-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); font-size: 0.85rem; color: var(--text-3); margin-bottom: var(--space-1); }
.turn-head strong { color: var(--text); }
.bubble { padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); white-space: pre-wrap; overflow-wrap: anywhere; }
.turn-user .bubble { background: var(--surface-2); }
.progress-line { display: flex; align-items: center; gap: var(--space-2); color: var(--text-2); }
.oneshot-note { margin-top: var(--space-4); font-size: 0.82rem; color: var(--text-3); display: flex; gap: var(--space-2); align-items: flex-start; }

.report { margin-top: var(--space-5); }
.report-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--space-3); padding: var(--space-5); border-bottom: 1px solid var(--border); }
.report-head h2 { font-size: 1.2rem; }
.report-body { padding: var(--space-5); }
.report-body section + section { margin-top: var(--space-5); }
.report-body h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); margin-bottom: var(--space-3); }
.report-body ul { margin: 0; padding-left: 1.2rem; }
.report-body li + li { margin-top: var(--space-2); }
.cause { padding: var(--space-4); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius-sm); background: var(--surface); }
.cause + .cause { margin-top: var(--space-3); }
.cause h4 { font-size: 0.98rem; margin-bottom: var(--space-1); }
.cite { display: inline-flex; align-items: center; margin-left: 4px; padding: 0 6px; border-radius: 4px; background: var(--accent-soft); color: var(--accent-strong); font-size: 0.75rem; font-weight: 700; text-decoration: none; vertical-align: 1px; }
.cite:hover { background: var(--accent); color: var(--on-accent); }
.report-foot { display: flex; flex-wrap: wrap; gap: var(--space-2); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); background: var(--surface-2); border-radius: 0 0 var(--radius) var(--radius); }
.model-meta { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); font-size: 0.8rem; color: var(--text-3); }
.skeleton { border-radius: 6px; background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 37%, var(--surface-2) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
.skeleton-line { height: 12px; }
.skeleton-line + .skeleton-line { margin-top: 10px; }
.skeleton-title { height: 20px; width: 55%; margin-bottom: 18px; }

.panel h2 { display: flex; align-items: center; gap: var(--space-2); font-size: 0.95rem; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-4) var(--space-4) var(--space-3); }
.panel-body { padding: 0 var(--space-4) var(--space-4); }
.timeline { list-style: none; margin: 0; padding: 0; position: relative; }
.timeline li { position: relative; padding: 0 0 var(--space-3) 26px; }
.timeline li::before { content: ""; position: absolute; left: 7px; top: 18px; bottom: -2px; width: 2px; background: var(--border); }
.timeline li:last-child::before { display: none; }
.dot { position: absolute; left: 0; top: 3px; width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--surface); background: var(--text-3); box-shadow: 0 0 0 1px var(--border); }
.dot-ok { background: var(--ok); } .dot-bad { background: var(--danger); } .dot-wait { background: var(--warn); } .dot-info { background: var(--info); } .dot-sim { background: var(--sim); }
.tl-summary { font-size: 0.88rem; font-weight: 550; overflow-wrap: anywhere; }
.tl-meta { font-size: 0.76rem; color: var(--text-3); }
.evidence { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.ev { padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); scroll-margin-top: 80px; }
.ev:target { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.ev-head { display: flex; gap: var(--space-2); align-items: flex-start; }
.ev-id { flex: none; padding: 0 6px; border-radius: 4px; background: var(--accent-soft); color: var(--accent-strong); font-size: 0.75rem; font-weight: 800; line-height: 1.6; }
.ev-title { font-weight: 650; font-size: 0.9rem; overflow-wrap: anywhere; }
.ev-meta { font-size: 0.76rem; color: var(--text-3); margin: 4px 0 6px; }
.ev-excerpt { font-size: 0.84rem; color: var(--text-2); overflow-wrap: anywhere; }
.ev details summary { cursor: pointer; font-size: 0.8rem; color: var(--accent); margin-top: 4px; }
.ev-links { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-2); font-size: 0.8rem; }
.blocked { color: var(--danger); font-weight: 600; }
.approval { border: 2px solid var(--warn); }
.approval.decided-approved { border-color: var(--ok); }
.approval.decided-rejected, .approval.decided-void { border-color: var(--border-strong); }
.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px var(--space-3); margin: 0; font-size: 0.86rem; }
.kv dt { color: var(--text-3); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.preview { max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: 0.8rem; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.risks { margin: 0; padding-left: 1.1rem; font-size: 0.84rem; color: var(--text-2); }
.decision-actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); margin-top: var(--space-4); }
.receipt { display: flex; gap: var(--space-2); align-items: flex-start; font-size: 0.88rem; }

.grid-2 > .card + .card { margin-top: 0; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4); }
.state-ready { color: var(--ok); } .state-error { color: var(--danger); } .state-warn { color: var(--warn); }
.doc-page { max-width: 820px; }
.doc-page .bubble { white-space: normal; }
.footer-note { margin-top: var(--space-6); font-size: 0.8rem; color: var(--text-3); }

/* Responsive */
@media (max-width: 1199px) {
  .task-layout { grid-template-columns: minmax(0, 1fr); }
  .jump { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-4); }
}
@media (max-width: 899px) {
  .shell { grid-template-columns: minmax(0, 1fr); background: none; }
  .topbar .menu-button { display: inline-flex; }
  .sidenav { position: fixed; top: 56px; left: 0; bottom: 0; height: auto; width: min(300px, 86vw); z-index: 30; transform: translateX(-102%); visibility: hidden; transition: transform 0.2s ease, visibility 0.2s; box-shadow: var(--shadow-lg); }
  .sidenav[data-open="true"] { transform: none; visibility: visible; }
  .scrim { position: fixed; inset: 56px 0 0 0; background: rgb(0 0 0 / 35%); z-index: 25; }
  .main { padding: var(--space-4); }
  .env-badges .badge-hide-sm { display: none; }
}
@media (max-width: 599px) {
  .topbar { padding: 0 var(--space-3); gap: var(--space-2); }
  .user-chip .user-email { display: none; }
  .env-badges { display: none; }
  .card-body, .composer, .report-head, .report-body { padding: var(--space-4); }
  .task-item { padding: var(--space-3) var(--space-4); }
  .decision-actions { grid-template-columns: 1fr; }
  h1 { font-size: 1.3rem; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }
}
`;
