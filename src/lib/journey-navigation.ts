// Draft completion runs choose-event (Co), when (Kiedy), where (Gdzie) and details (Sprawdź).
export type JourneyScreen = 'welcome' | 'menu' | 'home' | 'choose-event' | 'when' | 'where' | 'details' | 'camera' |
  'library' | 'report' | 'recipients' | 'signature' | 'notices' | 'notice' | 'check-in';

export type JourneyLocation = {
  screen: JourneyScreen;
  draftId?: string;
  reportId?: string;
  noticeId?: string;
};

type Entry = { journey: true; scroll: number };
const draftScreens = new Set<JourneyScreen>(['choose-event', 'when', 'where', 'details', 'camera']);
const reportScreens = new Set<JourneyScreen>(['report', 'recipients', 'signature', 'notices', 'notice', 'check-in']);
const noticeScreens = new Set<JourneyScreen>(['notice', 'check-in']);
const screens = new Set<JourneyScreen>(['welcome', 'menu', 'home', 'choose-event', 'when', 'where', 'details', 'camera',
  'library', 'report', 'recipients', 'signature', 'notices', 'notice', 'check-in']);

/** A Draft or a Report's Notices open on this screen, so nothing may restart the app under it. */
export const holdsWork = (location: JourneyLocation) => draftScreens.has(location.screen) || reportScreens.has(location.screen);

export function readJourney(url: URL): JourneyLocation {
  const requested = url.searchParams.get('screen');
  // The quick-capture receipt used to be its own `saved` screen before Co; both are one screen now.
  const screen = requested === 'saved' ? 'choose-event' : screens.has(requested as JourneyScreen) ? requested as JourneyScreen : 'home';
  const id = url.searchParams.get('draft');
  const reportId = url.searchParams.get('report');
  if (draftScreens.has(screen)) return id ? { screen, draftId: id } : { screen: 'home' };
  if (reportScreens.has(screen)) return reportId ? { screen, reportId, noticeId: noticeScreens.has(screen) ? url.searchParams.get('notice') ?? undefined : undefined } : { screen: 'home' };
  return { screen };
}

export function journeyUrl(location: JourneyLocation): string {
  const url = new URL(window.location.href);
  // `picker` belonged to the former single-page completion; dropping it keeps old URLs tidy.
  for (const key of ['screen', 'draft', 'report', 'notice', 'picker']) url.searchParams.delete(key);
  if (location.screen !== 'home') url.searchParams.set('screen', location.screen);
  if (location.draftId) url.searchParams.set('draft', location.draftId);
  if (location.reportId) url.searchParams.set('report', location.reportId);
  if (location.noticeId) url.searchParams.set('notice', location.noticeId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function createJourneyNavigation(apply: (location: JourneyLocation, scroll: number) => void, scroll: () => number) {
  const initial = readJourney(new URL(window.location.href));
  // SvelteKit can replace history state on reload. Keep the preceding preparation stage in history.
  const reloading = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload';
  const direct = initial.screen !== 'home' && !reloading && !(history.state as Entry | null)?.journey;
  if (direct) {
    history.replaceState({ journey: true, scroll: 0 } satisfies Entry, '', journeyUrl({ screen: 'home' }));
    history.pushState({ journey: true, scroll: 0 } satisfies Entry, '', journeyUrl(initial));
  } else if (!(history.state as Entry | null)?.journey) {
    history.replaceState({ journey: true, scroll: 0 } satisfies Entry, '', window.location.href);
  }
  const onPop = () => apply(readJourney(new URL(window.location.href)), (history.state as Entry | null)?.scroll ?? 0);
  window.addEventListener('popstate', onPop);
  let backPending = false;
  const onBackPop = () => { backPending = false; };
  window.addEventListener('popstate', onBackPop);
  return {
    initial,
    replace(location: JourneyLocation) {
      history.replaceState({ journey: true, scroll: 0 } satisfies Entry, '', journeyUrl(location));
    },
    saveScroll() {
      history.replaceState({ journey: true, scroll: scroll() } satisfies Entry, '', window.location.href);
    },
    navigate(location: JourneyLocation, replace = false) {
      history.replaceState({ journey: true, scroll: scroll() } satisfies Entry, '', window.location.href);
      const url = journeyUrl(location);
      if (replace) history.replaceState({ journey: true, scroll: 0 } satisfies Entry, '', url);
      else history.pushState({ journey: true, scroll: 0 } satisfies Entry, '', url);
      apply(location, 0);
    },
    back() {
      const location = readJourney(new URL(window.location.href));
      if (location.screen === 'home') return false;
      if (backPending) return true;
      backPending = true;
      history.replaceState({ journey: true, scroll: scroll() } satisfies Entry, '', window.location.href);
      history.back();
      return true;
    },
    dispose() { window.removeEventListener('popstate', onPop); window.removeEventListener('popstate', onBackPop); }
  };
}
