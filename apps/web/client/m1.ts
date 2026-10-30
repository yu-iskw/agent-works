// Progressive enhancement for the M1 pages. Every page works without this script.
const main = document.querySelector<HTMLElement>('main[data-segment]');
const segment = main?.dataset.segment ?? '';
const draftKey = (key: string) => `aw-m1:${segment}:${key}`;

const announcer = document.createElement('div');
announcer.className = 'sr-only';
announcer.setAttribute('role', 'status');
announcer.setAttribute('aria-live', 'polite');
document.body.append(announcer);

function say(text: string): void {
  announcer.textContent = '';
  window.setTimeout(() => (announcer.textContent = text), 50);
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** One submission per form: the clicked button's value is kept, every button is disabled. */
function guardSubmit(form: HTMLFormElement): void {
  form.addEventListener('submit', (event) => {
    if (form.dataset.submitted === 'true') {
      event.preventDefault();
      return;
    }
    form.dataset.submitted = 'true';
    const submitter = event.submitter as HTMLButtonElement | null;
    if (submitter?.name) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = submitter.name;
      hidden.value = submitter.value;
      form.append(hidden);
    }
    for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) {
      button.disabled = true;
      if (button === submitter) button.dataset.pending = 'true';
    }
    const key = form.dataset.draft;
    if (key !== undefined) storage()?.removeItem(draftKey(key));
  });
}

/** Unsent text survives reloads and errors, and stays in the segment it was written in. */
function drafts(form: HTMLFormElement): void {
  const key = form.dataset.draft;
  if (key === undefined || segment === '') return;
  const fields = [
    ...form.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
      'textarea, input[type="text"], input:not([type])',
    ),
  ].filter((field) => field.name !== '');
  const saved = storage()?.getItem(draftKey(key));
  if (saved !== null && saved !== undefined) {
    try {
      const values = JSON.parse(saved) as Record<string, string>;
      for (const field of fields)
        if (field.value.trim() === '' && typeof values[field.name] === 'string')
          field.value = values[field.name] ?? '';
    } catch {
      storage()?.removeItem(draftKey(key));
    }
  }
  form.addEventListener('input', () => {
    const values = Object.fromEntries(fields.map((field) => [field.name, field.value]));
    storage()?.setItem(draftKey(key), JSON.stringify(values));
  });
}

for (const form of document.querySelectorAll<HTMLFormElement>('form')) {
  if (form.method.toLowerCase() === 'post') guardSubmit(form);
  drafts(form);
}

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (
    event.key !== 'Enter' ||
    !(event.ctrlKey || event.metaKey) ||
    target?.dataset.ctrlEnter === undefined
  )
    return;
  event.preventDefault();
  (target as HTMLTextAreaElement).form?.requestSubmit();
});

for (const radio of document.querySelectorAll<HTMLInputElement>('[data-autosubmit]'))
  radio.addEventListener('change', () => radio.form?.requestSubmit());

function syncModes(): void {
  const mode = document.querySelector<HTMLInputElement>(
    'input[name="mode"][type="radio"]:checked',
  )?.value;
  for (const block of document.querySelectorAll<HTMLElement>('[data-show-when]')) {
    const [, want] = (block.dataset.showWhen ?? '').split('=');
    block.hidden = mode !== undefined && mode !== want;
  }
}
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"][type="radio"]'))
  radio.addEventListener('change', syncModes);
syncModes();

const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
const nav = document.getElementById('sidenav');
toggle?.addEventListener('click', () => {
  const open = nav?.dataset.open !== 'true';
  if (nav !== null) nav.dataset.open = String(open);
  toggle.setAttribute('aria-expanded', String(open));
  if (open) nav?.querySelector<HTMLElement>('a')?.focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (nav?.dataset.open === 'true') {
    nav.dataset.open = 'false';
    toggle?.setAttribute('aria-expanded', 'false');
    toggle?.focus();
  }
  const open = document.querySelector<HTMLDetailsElement>('details[data-segment-switch][open]');
  if (open !== null) {
    open.open = false;
    open.querySelector('summary')?.focus();
  }
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]'))
  button.addEventListener('click', () => {
    void navigator.clipboard.writeText(button.dataset.copy ?? '').then(
      () => say('Copied'),
      () => say('Copy failed'),
    );
  });

/** True when a region holds the focused control or unsent text, so replacing it would lose work. */
function busy(region: Element): boolean {
  const active = document.activeElement;
  if (active !== null && region.contains(active) && active !== document.body) return true;
  return [...region.querySelectorAll<HTMLTextAreaElement>('textarea')].some(
    (field) => field.value.trim() !== '',
  );
}

async function refreshRegions(): Promise<string | undefined> {
  const response = await fetch(window.location.href, {
    credentials: 'same-origin',
    headers: { accept: 'text/html' },
  });
  if (!response.ok) return undefined;
  const next = new DOMParser().parseFromString(await response.text(), 'text/html');
  // A response rendered for another segment must never populate this page.
  if (next.querySelector<HTMLElement>('main[data-segment]')?.dataset.segment !== segment)
    return undefined;
  for (const region of document.querySelectorAll('[data-live]')) {
    const replacement = next.querySelector(
      `[data-live="${(region as HTMLElement).dataset.live ?? ''}"]`,
    );
    if (replacement === null) continue;
    // Localize first so unchanged timestamps compare equal to the already localized page.
    localizeTimes(replacement);
    if (replacement.innerHTML === region.innerHTML || busy(region)) continue;
    region.replaceWith(document.importNode(replacement, true));
  }
  for (const form of document.querySelectorAll<HTMLFormElement>('[data-live] form')) {
    if (form.dataset.enhanced === 'true') continue;
    form.dataset.enhanced = 'true';
    if (form.method.toLowerCase() === 'post') guardSubmit(form);
  }
  return next.querySelector('[data-live="status-line"]')?.textContent.trim();
}

const poller = document.querySelector<HTMLElement>('[data-poll]');
if (poller !== null) {
  let version = poller.dataset.taskVersion ?? '';
  let failures = 0;
  const tick = async () => {
    if (document.hidden) return schedule();
    try {
      const response = await fetch(poller.dataset.poll ?? '', { credentials: 'same-origin' });
      const state = (await response.json()) as {
        segment?: string;
        version?: number;
        status?: string;
        error?: string;
      };
      if (state.error === 'unauthenticated') {
        say('Your session ended. Sign in again to see updates.');
        return;
      }
      if (state.segment !== poller.dataset.segment) return schedule();
      failures = 0;
      if (String(state.version) !== version) {
        version = String(state.version);
        const line = await refreshRegions();
        if (line !== undefined) say(line);
      }
      if (['completed', 'cancelled', 'declined'].includes(state.status ?? '')) return;
    } catch {
      failures += 1;
      if (failures === 3) say('Connection lost. Updates will resume when it is back.');
    }
    schedule();
  };
  const schedule = () => window.setTimeout(() => void tick(), failures > 2 ? 8000 : 2500);
  schedule();
}

if (document.querySelector('[data-live="conversation"] .status-active') !== null) {
  const again = () =>
    window.setTimeout(async () => {
      // A background tab does not need the reply yet; it catches up when shown again.
      if (document.hidden) return again();
      await refreshRegions().catch(() => undefined);
      if (document.querySelector('[data-live="conversation"] .status-active') !== null) again();
      else say('Reply received');
    }, 3000);
  again();
}

// A one-time notice belongs to the request that caused it; a reload should not repeat it.
if (/[?&](notice|error)=/.test(window.location.search)) {
  const clean = new URL(window.location.href);
  clean.searchParams.delete('notice');
  clean.searchParams.delete('error');
  window.history.replaceState(null, '', clean.toString());
}

/** Ticks only the sources the chosen specialist can use, and greys out the rest. */
/** A newly picked specialist ticks every source it can use; on load the member's ticks stay. */
function syncSources(select: HTMLSelectElement, keepTicks: boolean): void {
  const usable = new Set(
    (select.selectedOptions.item(0)?.dataset.sources ?? '').split(' ').filter(Boolean),
  );
  const picked = select.value !== '';
  for (const box of document.querySelectorAll<HTMLInputElement>(
    `[data-sources-for="${select.id}"] input[type="checkbox"]`,
  )) {
    box.disabled = picked && !usable.has(box.value);
    box.checked = picked && usable.has(box.value) && (!keepTicks || box.checked);
  }
}
for (const fieldset of document.querySelectorAll<HTMLElement>('[data-sources-for]')) {
  const select = document.getElementById(fieldset.dataset.sourcesFor ?? '');
  if (!(select instanceof HTMLSelectElement)) continue;
  select.addEventListener('change', () => syncSources(select, false));
  if (select.value !== '') syncSources(select, true);
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Shows each timestamp in the viewer's time zone; the UTC value stays in the tooltip. */
function localizeTimes(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLTimeElement>('time[data-local]')) {
    const date = new Date(element.dateTime);
    if (Number.isNaN(date.getTime())) continue;
    // The server renders the UTC text; keep it as the tooltip.
    element.title = element.textContent;
    element.textContent = timeFormat.format(date);
    delete element.dataset.local;
  }
}
localizeTimes(document);
