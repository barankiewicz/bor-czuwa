const duration = 180;

/** Asks a `disclosure` action to open its element, with the same motion as a tap. */
export function requestOpen(details: HTMLDetailsElement) {
  details.dispatchEvent(new CustomEvent('disclosure-open'));
}

/**
 * Opens and shuts a native disclosure over 180 ms, so its content and everything below it move
 * rather than jump. `initiallyOpen` sets the first state only; later Draft updates must not close
 * what the Reporter opened. A screen can pass an easing that starts from rest when what sits below
 * travels far enough for the default ease-out's fast start to read as a jump.
 */
export function disclosure(details: HTMLDetailsElement, setting: boolean | { initiallyOpen?: boolean; easing?: string } = false) {
  const { initiallyOpen = false, easing = 'ease-out' } = typeof setting === 'boolean' ? { initiallyOpen: setting } : setting;
  details.open = initiallyOpen;
  const summary = details.querySelector<HTMLElement>(':scope > summary')!;
  let wanted = details.open;
  let running: Animation[] = [];

  function toggle(open: boolean) {
    wanted = open;
    const from = details.getBoundingClientRect().height;
    for (const animation of running) animation.cancel();
    running = [];
    details.open = open;
    const to = details.getBoundingClientRect().height;
    if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Content stays rendered while it shuts and is removed once the height reaches the summary.
    details.open = true;
    details.style.overflow = 'clip';
    const height = details.animate({ height: [`${from}px`, `${to}px`] }, { duration, easing });
    const body = summary.nextElementSibling;
    const fade = body?.animate({ opacity: open ? [0, 1] : [1, 0] }, { duration, easing, fill: 'forwards' });
    running = fade ? [height, fade] : [height];
    height.onfinish = () => {
      details.open = open;
      details.style.overflow = '';
      fade?.cancel();
      running = [];
    };
  }
  function tap(event: MouseEvent) {
    event.preventDefault();
    toggle(!wanted);
  }
  function request() { if (!wanted) toggle(true); }
  summary.addEventListener('click', tap);
  details.addEventListener('disclosure-open', request);
  return {
    destroy() {
      summary.removeEventListener('click', tap);
      details.removeEventListener('disclosure-open', request);
    }
  };
}
