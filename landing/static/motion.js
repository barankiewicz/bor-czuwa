// The landing's only motion (ticket 10, owner 2026-11-12): sections below the first screen fade in
// and rise into place as they scroll into view, once each. The page template's head script adds the
// class motion only when reduced motion is not asked for; without it this does nothing, and the
// page is the still page. Timings live in landing.css.
const root = document.documentElement;
if (root.classList.contains('motion')) {
  const css = getComputedStyle(root);
  const v = name => css.getPropertyValue(name).trim();
  // Only what is below the window now is ever hidden, so nothing already painted disappears.
  const els = [...document.querySelectorAll('main section:not(.hero) :is(.section-title, .why-body, .steps > li, .how-phone, .features > li, .give-copy > :not(.section-title), .give-list)')]
    .filter(el => el.getBoundingClientRect().top > innerHeight);
  els.forEach(el => el.classList.add('rv-wait'));
  const io = new IntersectionObserver(entries => {
    entries.filter(e => e.isIntersecting).map(e => e.target).forEach((el, k) => {
      io.unobserve(el);
      // fill 'backwards' holds the hidden start through the stagger delay, then lets go entirely.
      el.animate({ opacity: [0, 1], transform: [`translateY(${v('--reveal-rise')})`, 'none'] },
        { delay: Math.min(k, 4) * parseFloat(v('--reveal-stagger')), duration: parseFloat(v('--reveal')), easing: v('--ease-land'), fill: 'backwards' });
      el.classList.remove('rv-wait'); // same task as the animation, so no frame shows it unhidden
    });
  }, { rootMargin: `0px 0px -${v('--reveal-trigger')} 0px` });
  els.forEach(el => io.observe(el));
}
