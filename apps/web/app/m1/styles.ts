import { styles as base } from '../workbench/styles.js';

/** P0 design tokens and components, plus the M1 surfaces. */
export const m1Styles = `${base}
:root { --seg: var(--accent); --seg-soft: var(--accent-soft); }
[data-segment-tone="alpha"] { --seg: #0f766e; --seg-soft: #dff4f1; }
[data-segment-tone="beta"] { --seg: #7c3aed; --seg-soft: #efe7fd; }
@media (prefers-color-scheme: dark) {
  [data-segment-tone="alpha"] { --seg: #5eead4; --seg-soft: #0f2e2b; }
  [data-segment-tone="beta"] { --seg: #c4b5fd; --seg-soft: #2a1f47; }
}
.segment-bar { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); padding: 6px var(--space-5); background: var(--seg-soft); border-bottom: 2px solid var(--seg); font-size: 0.86rem; position: sticky; top: 56px; z-index: 19; }
.segment-bar strong { color: var(--seg); }
.check-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.check-list li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px var(--space-3); align-items: center; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.check-list li p { grid-column: 2; overflow-wrap: anywhere; }
.mode-labels { display: inline-flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.form-grid > .btn { justify-self: start; }
.activity-more summary { cursor: pointer; color: var(--accent); font-size: 0.85rem; padding: 0 var(--space-4) var(--space-4); }
.segment-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--seg); flex: none; }
.segment-switch { position: relative; }
.segment-switch summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-2); padding: 4px 10px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--surface); font-weight: 650; font-size: 0.86rem; color: var(--text); }
.segment-switch summary > span:last-child { max-width: 34vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Anchored decision cards land below the sticky header and segment bar. */
[id='decision'], .ev { scroll-margin-top: 110px; }
.segment-switch summary::-webkit-details-marker { display: none; }
.segment-switch[open] summary { border-color: var(--seg); }
.segment-menu { position: absolute; left: 0; top: calc(100% + 6px); min-width: 260px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-lg); padding: var(--space-2); z-index: 40; }
.segment-menu a { display: flex; gap: var(--space-2); align-items: center; padding: 8px var(--space-3); border-radius: var(--radius-sm); color: var(--text); text-decoration: none; }
.segment-menu a:hover, .segment-menu a:focus-visible { background: var(--surface-2); }
.segment-menu a[aria-current="true"] { background: var(--seg-soft); }
.segment-menu p { font-size: 0.78rem; color: var(--text-3); padding: var(--space-2) var(--space-3) 0; }
.sidenav { top: 92px; height: calc(100vh - 92px); }
.nav-new { margin: 0 var(--space-3) var(--space-4); display: flex; }
.nav-new .btn { flex: 1; }
.badge-seg { background: var(--seg-soft); color: var(--seg); border-color: color-mix(in srgb, var(--seg) 40%, transparent); }
.badge-test { background: var(--warn-soft); color: var(--warn); border-color: var(--warn); }
.badge-ok { background: var(--ok-soft); color: var(--ok); }
.badge-bad { background: var(--danger-soft); color: var(--danger); }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-4); }
.cards > .card + .card { margin-top: 0; }
.tm-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.tm-card h2 a { color: var(--text); text-decoration: none; }
.tm-card h2 a:hover { color: var(--accent); text-decoration: underline; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); font-size: 0.78rem; color: var(--text-2); }
.chip-on { background: var(--ok-soft); border-color: color-mix(in srgb, var(--ok) 35%, transparent); color: var(--ok); }
.chip-off { background: var(--surface-2); color: var(--text-3); text-decoration: line-through; }
.form-grid { display: grid; gap: var(--space-4); }
.field label, .field legend { display: block; font-weight: 650; margin-bottom: var(--space-1); }
.field .hint { font-size: 0.8rem; color: var(--text-3); margin-top: 2px; }
.field input[type="text"], .field input[type="number"], .field input:not([type]), .field select, .field textarea { width: 100%; min-height: 40px; padding: 8px var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; }
.field textarea { min-height: 96px; resize: vertical; line-height: 1.5; }
fieldset.field, .field fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.choice { display: flex; gap: var(--space-2); align-items: flex-start; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; }
.choice:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.choice input { margin-top: 4px; }
.choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-2); }
.checks { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
.checks label { display: inline-flex; gap: 6px; align-items: center; font-weight: 500; }
.assign-row .field textarea { min-height: 64px; }
.assign-row { padding: var(--space-4); border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); display: grid; gap: var(--space-3); }
.section-title { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); font-weight: 700; margin-bottom: var(--space-3); }

.decision { border: 2px solid var(--warn); }
.decision-ok { border-color: var(--ok); }
.decision-bad { border-color: var(--danger); }
.decision-info { border-color: var(--info); }
.decision h2 { display: flex; align-items: center; gap: var(--space-2); }
.plan-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.plan-item { padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
.plan-item h3 { margin-bottom: 4px; }

.assignments { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-3); }
.asg { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); border-top: 3px solid var(--border-strong); }
.asg[data-status="running"] { border-top-color: var(--info); }
.asg[data-status="succeeded"] { border-top-color: var(--ok); }
.asg[data-status="failed"], .asg[data-status="timed_out"] { border-top-color: var(--danger); }
.asg[data-status="needs_input"] { border-top-color: var(--warn); }
.asg-head { display: flex; justify-content: space-between; gap: var(--space-2); align-items: flex-start; margin-bottom: var(--space-2); }
.asg-times { font-size: 0.76rem; color: var(--text-3); font-variant-numeric: tabular-nums; }

.stmt { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.stmt li { padding: var(--space-2) var(--space-3); border-left: 3px solid var(--border-strong); background: var(--surface); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; overflow-wrap: anywhere; }
.stmt li[data-kind="fact"], .stmt li[data-kind="calculation"] { border-left-color: var(--accent); }
.stmt li[data-kind="hypothesis"], .stmt li[data-kind="assumption"] { border-left-color: var(--warn); background: color-mix(in srgb, var(--warn-soft) 45%, var(--surface)); }
.stmt li[data-kind="question"] { border-left-color: var(--info); }
.stmt li[data-kind="recommendation"], .stmt li[data-kind="proposed_action"] { border-left-color: var(--ok); }
.stmt li[data-support="unsupported"] { border-left-style: dashed; border-left-color: var(--danger); }
.kind { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 800; color: var(--text-3); margin-right: 6px; }
.unverified { font-size: 0.72rem; font-weight: 700; color: var(--danger); margin-left: 6px; }
.result-section + .result-section { margin-top: var(--space-5); }
.result-section h3 { font-size: 1rem; margin-bottom: var(--space-3); }
.limitations { margin: 0; padding-left: 1.2rem; color: var(--text-2); }
.calc-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; font-variant-numeric: tabular-nums; }
.calc-table th, .calc-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
.calc-table td.num, .calc-table th.num { text-align: right; }
.table-wrap { overflow-x: auto; }
.diff-add { background: var(--ok-soft); border-left: 3px solid var(--ok); padding: var(--space-2) var(--space-3); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; overflow-wrap: anywhere; }
.diff-del { background: var(--danger-soft); border-left: 3px solid var(--danger); padding: var(--space-2) var(--space-3); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--danger) 60%, transparent); overflow-wrap: anywhere; }
.diff-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.msgs { display: grid; gap: var(--space-3); max-height: 520px; overflow-y: auto; padding-right: var(--space-2); }
.msg { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--space-3); }
.msg-system .bubble { background: var(--info-soft); border-color: color-mix(in srgb, var(--info) 25%, transparent); font-size: 0.88rem; }
.msg-member .bubble { background: var(--surface-2); }
.card-link { display: inline-flex; gap: 6px; align-items: center; margin-top: var(--space-2); font-weight: 650; }
.inbox-group + .inbox-group { margin-top: var(--space-5); }
.inbox-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-3); align-items: start; padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
.inbox-item:first-child { border-top: 0; }
.inbox-kind { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; background: var(--surface-2); }
.inbox-kind[data-kind="approval"], .inbox-kind[data-kind="plan_review"], .inbox-kind[data-kind="question"] { background: var(--warn-soft); color: var(--warn); }
.inbox-kind[data-kind="failed"], .inbox-kind[data-kind="uncertain"] { background: var(--danger-soft); color: var(--danger); }
.inbox-kind[data-kind="completed"] { background: var(--ok-soft); color: var(--ok); }
.inbox-item a.title { font-weight: 650; color: var(--text); text-decoration: none; overflow-wrap: anywhere; }
.inbox-item a.title:hover { color: var(--accent); text-decoration: underline; }
.code-block { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 0.8rem; max-height: 420px; overflow: auto; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.notice { margin-bottom: var(--space-4); }
.signin { max-width: 460px; margin: 10vh auto; padding: 0 var(--space-4); }
.signin .card-body > * + * { margin-top: var(--space-4); }
.provider-btn { width: 100%; }
@media (max-width: 899px) {
  /* Visible at once when opening, so focus can move into the menu; hide only after closing. */
  .sidenav[data-open="true"] { transition: transform 0.2s ease, visibility 0s; }
  .sidenav { top: 92px; }
  .segment-bar { padding: 6px var(--space-4); }
}
@media (max-width: 599px) {
  .brand > span:last-child { display: none; }
  .segment-switch summary > span:last-child { max-width: 28vw; }
  .segment-bar { top: 56px; font-size: 0.8rem; }
  .segment-bar .hide-sm { display: none; }
  .inbox-item { grid-template-columns: auto minmax(0, 1fr); padding: var(--space-3) var(--space-4); }
  .inbox-item > :last-child { grid-column: 2; }
}
`;
