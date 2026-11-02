// The draggable, keyboard-operable edge between the conversation and the panel (desktop only).

import { useEffect, useRef } from 'preact/hooks';

import { panelBounds, separatorKey, widthFromPointer } from '../../store/panel-resize.js';
import { useWorkspace } from '../context.js';

import type { PanelBounds } from '../../store/panel-resize.js';
import type { JSX } from 'preact';

const COMMIT_DELAY_MS = 400;

function boundsNow(): PanelBounds {
  const side = document.getElementById('sidebar')?.offsetWidth ?? 0;
  return panelBounds(window.innerWidth, side);
}

export function PanelSeparator(): JSX.Element {
  const { store, effects } = useWorkspace();
  const width = store.panel.value.width;
  const commitTimer = useRef<number | undefined>(undefined);
  const commitSoon = () => {
    window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(
      () => void effects.panel.commitWidth(),
      COMMIT_DELAY_MS,
    );
  };
  useEffect(() => {
    const clamp = () => {
      const bounds = boundsNow();
      const current = store.peek().panel.width;
      if (current > bounds.max) effects.panel.setWidth(bounds.max);
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => {
      window.removeEventListener('resize', clamp);
      window.clearTimeout(commitTimer.current);
    };
  }, [effects, store]);
  const bounds = boundsNow();
  return (
    <div
      class="pn-sep"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuetext={`${width} pixels wide`}
      tabIndex={0}
      onKeyDown={(event) => {
        const next = separatorKey(event.key, store.peek().panel.width, boundsNow());
        if (next === undefined) return;
        event.preventDefault();
        effects.panel.setWidth(next);
        commitSoon();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = 'true';
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.dataset.dragging !== 'true') return;
        effects.panel.setWidth(widthFromPointer(event.clientX, window.innerWidth, boundsNow()));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.dataset.dragging !== 'true') return;
        delete event.currentTarget.dataset.dragging;
        event.currentTarget.releasePointerCapture(event.pointerId);
        void effects.panel.commitWidth();
      }}
      onPointerCancel={(event) => {
        delete event.currentTarget.dataset.dragging;
      }}
    />
  );
}
