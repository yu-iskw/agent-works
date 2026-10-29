// Progressive enhancement only: every page works as plain forms and links without this file.

const pollMs = 1500;

function announce(text: string): void {
  const region = document.getElementById('announcer');
  if (region === null) return;
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = text;
  }, 50);
}

function localTimes(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLTimeElement>('time[data-local]')) {
    const date = new Date(element.dateTime);
    if (Number.isNaN(date.getTime())) continue;
    element.textContent =
      element.dataset.local === 'time'
        ? date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
        : date.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
  }
}

function menu(): void {
  const toggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
  const nav = document.getElementById('sidenav');
  if (toggle === null || nav === null) return;
  let scrim: HTMLDivElement | undefined;
  const close = (focusToggle: boolean) => {
    nav.dataset.open = 'false';
    toggle.setAttribute('aria-expanded', 'false');
    scrim?.remove();
    scrim = undefined;
    if (focusToggle) toggle.focus();
  };
  toggle.addEventListener('click', () => {
    if (nav.dataset.open === 'true') return close(true);
    nav.dataset.open = 'true';
    toggle.setAttribute('aria-expanded', 'true');
    scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.addEventListener('click', () => close(true));
    document.body.append(scrim);
    nav.querySelector<HTMLElement>('a')?.focus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.dataset.open === 'true') close(true);
  });
}

function pending(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button === null) return;
  button.disabled = true;
  button.dataset.pending = 'true';
  button.setAttribute('aria-busy', 'true');
}

function composer(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-composer]');
  if (form === null) return;
  const field = form.querySelector<HTMLTextAreaElement>('textarea');
  if (field === null) return;
  const counter = form.querySelector<HTMLElement>('[data-counter]');
  const max = field.maxLength;
  const count = () => {
    if (counter !== null)
      counter.textContent = `${field.value.length.toLocaleString()} / ${max.toLocaleString()} characters.`;
  };
  count();
  field.addEventListener('input', () => {
    field.removeAttribute('aria-invalid');
    count();
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  let submitted = false;
  form.addEventListener('submit', (event) => {
    if (submitted || field.value.trim().length === 0) {
      event.preventDefault();
      if (!submitted) {
        field.setAttribute('aria-invalid', 'true');
        field.focus();
        announce('Enter an objective before starting the task.');
      }
      return;
    }
    submitted = true;
    pending(form);
    const label = form.querySelector<HTMLElement>('[data-label]');
    if (label !== null) label.textContent = 'Starting…';
    announce('Starting task');
  });
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-fill]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      field.value = link.dataset.fill ?? '';
      count();
      field.focus();
    });
  }
}

function onceForms(root: ParentNode): void {
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-once]')) {
    form.addEventListener('submit', (event) => {
      if (form.dataset.sent === 'true') {
        event.preventDefault();
        return;
      }
      form.dataset.sent = 'true';
      for (const other of document.querySelectorAll<HTMLFormElement>('form[data-once]')) {
        if (other !== form) other.dataset.sent = 'true';
      }
      pending(form);
    });
  }
}

function copyButtons(root: ParentNode): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    const target = document.querySelector<HTMLElement>(button.dataset.copy ?? '');
    // Clipboard is a secure-context attribute, so it is absent entirely over plain http.
    if (target === null || !('clipboard' in navigator)) continue;
    button.hidden = false;
    button.addEventListener('click', () => {
      const label = button.querySelector<HTMLElement>('[data-label]');
      navigator.clipboard.writeText(target.innerText).then(
        () => {
          if (label !== null) label.textContent = 'Copied';
          announce('Report copied to the clipboard');
        },
        () => announce('Copy failed. Select the text and copy it manually.'),
      );
    });
  }
}

function enhance(root: ParentNode): void {
  localTimes(root);
  onceForms(root);
  copyButtons(root);
}

function live(): void {
  const container = document.getElementById('task-live');
  if (container === null) return;
  let version = container.dataset.version ?? '';
  let status = container.dataset.status ?? '';
  let active = container.dataset.poll === 'true';
  let failures = 0;
  const swap = async (response: Response): Promise<void> => {
    const nextVersion = response.headers.get('x-task-version') ?? '';
    if (nextVersion === version) return;
    const focusedId = document.activeElement?.id;
    container.innerHTML = await response.text();
    version = nextVersion;
    container.dataset.version = version;
    enhance(container);
    if (focusedId) document.getElementById(focusedId)?.focus();
    const nextStatus = response.headers.get('x-task-status') ?? '';
    if (nextStatus !== status) {
      status = nextStatus;
      container.dataset.status = status;
      announce(`Task status: ${response.headers.get('x-task-status-label') ?? status}`);
    }
  };
  const tick = async () => {
    if (!active) return;
    if (document.visibilityState === 'hidden') {
      later();
      return;
    }
    try {
      const response = await fetch(`${window.location.pathname}?fragment=1`, {
        headers: { accept: 'text/html' },
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(String(response.status));
      // A redirect (for example to sign-in after the session ended) is not a task fragment.
      if (response.redirected || !response.headers.has('x-task-version')) {
        active = false;
        announce('Live updates stopped: your session changed. Reload the page.');
        return;
      }
      failures = 0;
      active = response.headers.get('x-task-live') === 'true';
      await swap(response);
    } catch {
      failures += 1;
      if (failures === 3)
        announce('Live updates paused: the server is not responding. Reload to retry.');
      if (failures >= 3) active = false;
    }
    if (active) later();
  };
  function later(): void {
    window.setTimeout(() => void tick(), pollMs);
  }
  if (active) later();
}

menu();
composer();
enhance(document);
live();
