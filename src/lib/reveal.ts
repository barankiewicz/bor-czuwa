import { sineInOut } from 'svelte/easing';
import { slide } from 'svelte/transition';

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Grows or shrinks an element's height while fading it, so what sits below travels
 * instead of jumping and nothing shows at full opacity in its first frame. */
export function reveal(node: Element, { duration = 200, easing }: { duration?: number; easing?: (t: number) => number } = {}) {
  const grow = slide(node, { duration: still() ? 0 : duration, easing });
  return { ...grow, css: (step: number, rest: number) => `${grow.css?.(step, rest) ?? ''};opacity: ${step};` };
}

/** For a tall reveal: the default ease starts at three times its average speed, so a few hundred
 * pixels of growth would move what sits below by a large step in the first frame. This starts and
 * ends at rest. */
export const unfold = { duration: 320, easing: sineInOut };

/** A line whose text changes keeps its place while the old text fades out and the new one fades in. */
export const textIn = (_node: Element) => ({ duration: still() ? 0 : 180, css: (x: number) => `opacity: ${x}` });
export const textOut = (_node: Element) => ({ duration: still() ? 0 : 140, css: (x: number) => `opacity: ${x}` });
/** textOut for a line of plain text whose leaving words must not be read out: a status line is read
 * whole, and the old words must not be read with the new ones while they fade. Only for text: a
 * leaving node that holds controls would leave them focusable inside aria-hidden. */
export const lineOut = (node: Element) => {
  node.setAttribute('aria-hidden', 'true');
  return textOut(node);
};

/** Lets an element follow its content's height over 200 ms, so a crossfade between rows of
 * different heights moves what sits below instead of snapping it when the old row leaves. */
export function followHeight(node: HTMLElement) {
  const content = node.firstElementChild as HTMLElement;
  let height = 0;
  const settle = () => { for (const property of ['transition', 'height', 'overflow']) node.style.removeProperty(property); };
  const observer = new ResizeObserver(() => {
    const next = content.offsetHeight;
    if (height && next !== height && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // From where the card is painted: mid-transition its animated height, else the old content's,
      // since an unpinned card has already taken the new content's height by now.
      const from = node.style.height ? node.getBoundingClientRect().height : height;
      settle();
      node.style.height = `${from}px`;
      node.style.overflow = 'hidden';
      void node.offsetHeight;
      node.style.transition = 'height 200ms ease-out';
      node.style.height = `${next}px`;
    } else settle();
    height = next;
  });
  const ended = (event: TransitionEvent) => { if (event.target === node && event.propertyName === 'height') settle(); };
  node.addEventListener('transitionend', ended);
  node.addEventListener('transitioncancel', ended);
  observer.observe(content);
  return { destroy() { observer.disconnect(); node.removeEventListener('transitionend', ended); node.removeEventListener('transitioncancel', ended); } };
}
