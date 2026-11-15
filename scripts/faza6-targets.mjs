// Effective touch targets for the Faza 6 collector: every control on the page, measured once the page has settled.
// A radio, checkbox or file input is its enclosing label, the way the browser suite counts it, and an inline link
// inside a sentence is exempt (WCAG 2.5.8; the product contract follows it).

export const targetFloor = 55.5;

/** Waits until every finite animation has finished, so a control mid-scale is not read at its transient size. */
export function untilSettled(page) {
  return page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
}

/** Returns each non-inline control's effective target that is under the floor, as readable strings. */
export function undersizedTargets(page, floor = targetFloor) {
  return page.evaluate(floor => {
    const shown = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    };
    const found = [];
    const seen = new Set();
    for (const control of document.querySelectorAll('button, a[href], summary, input:not([type=hidden]), select, textarea, [role=slider], [tabindex]:not([tabindex="-1"])')) {
      let target = control;
      if (control instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(control.type)) target = control.closest('label') ?? control;
      if (!shown(target) || seen.has(target)) continue;
      seen.add(target);
      if (control instanceof HTMLAnchorElement && getComputedStyle(control).display === 'inline') continue;
      const rect = target.getBoundingClientRect();
      if (rect.width < floor || rect.height < floor) {
        const name = (target.getAttribute('aria-label') || target.textContent || target.name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
        found.push(`${target.tagName.toLowerCase()} "${name}" ${Math.round(rect.width * 10) / 10}x${Math.round(rect.height * 10) / 10}`);
      }
    }
    return found;
  }, floor);
}

/** Settles the page, then fails with every control under the floor. */
export async function assertEffectiveTargets(page, label = 'page') {
  await untilSettled(page);
  const small = await undersizedTargets(page);
  if (small.length) throw new Error(`${label}: ${small.length} control(s) under 56 px after settle: ${small.slice(0, 8).join('; ')}`);
}
