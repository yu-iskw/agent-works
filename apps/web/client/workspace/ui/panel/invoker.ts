// The control that opened the panel, so closing it can hand focus back. One slot: a panel opened
// from another panel's control keeps the original invoker, which is where the member started.

let invoker: HTMLElement | null = null;

export function rememberInvoker(element: EventTarget | null | undefined): void {
  if (invoker === null && element instanceof HTMLElement) invoker = element;
}

export function restoreInvoker(): void {
  const target = invoker;
  invoker = null;
  if (target !== null && target.isConnected) target.focus();
}
