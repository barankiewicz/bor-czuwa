import { createPointer, type HeadingState } from './compass';
import type { DeviceFix } from './report';
import { compassOffered, enableCompass, startupLocationPermission, watchAppState, watchCompass, type CompassProblem } from './platform';

// Readings belong to this foreground session, never to storage or an unselected Draft.
let active = false;
let generation = 0;
let locationRun = 0;
let watch: number | undefined;
let fix: DeviceFix | undefined;
let fixChanged = () => {};
let locationProblem: number | undefined;
let stopCompass = () => {};
let heading: HeadingState = {};
let problem: CompassProblem | undefined;
let headingExpiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(reading: HeadingState, problem?: CompassProblem) => void>();
const waiting = new Set<{ resolve(fix: DeviceFix): void; reject(code: number): void }>();
const publish = () => listeners.forEach(listener => listener(heading, problem));

export function freshSessionFix() {
  const age = fix ? Date.now() - Date.parse(fix.at) : Infinity;
  return age >= 0 && age <= 60_000 ? fix : undefined;
}

function startLocation() {
  if (!active || watch !== undefined) return;
  if (!navigator.geolocation) { failLocation(2); return; }
  locationProblem = undefined;
  const current = ++locationRun;
  watch = navigator.geolocation.watchPosition(position => {
    if (!active || current !== locationRun) return;
    const age = Date.now() - position.timestamp;
    if (age < 0 || age > 60_000 || (fix && Date.parse(fix.at) > position.timestamp)) return;
    fix = { lat: position.coords.latitude, lon: position.coords.longitude,
      accuracy_m: position.coords.accuracy, at: new Date(position.timestamp).toISOString() };
    locationProblem = undefined;
    for (const request of waiting) request.resolve(fix);
    waiting.clear();
    fixChanged();
  }, failure => {
    if (!active || current !== locationRun) return;
    failLocation(failure.code);
  }, { enableHighAccuracy: true, maximumAge: 60_000, timeout: 60_000 });
}

function failLocation(code: number) {
  locationProblem = code;
  for (const request of waiting) request.reject(code);
  waiting.clear();
  // A watch can recover from unavailable/timeout. Only denial ends its permission to listen.
  if (code === 1) {
    locationRun++;
    fix = undefined;
    if (watch !== undefined) navigator.geolocation.clearWatch(watch);
    watch = undefined;
  }
}

/** Capture and retry wait on the foreground watch, including after a transient sensor error. */
export function sessionFix(): Promise<DeviceFix> {
  const fresh = freshSessionFix();
  if (fresh) return Promise.resolve(fresh);
  if (locationProblem === 1) return Promise.reject(1);
  return new Promise((resolve, reject) => {
    const request = { resolve, reject };
    waiting.add(request);
    // Also bounds browsers that supply only stale readings or suspend callbacks.
    const timeout = setTimeout(() => { if (waiting.delete(request)) reject(3); }, 60_000);
    request.resolve = value => { clearTimeout(timeout); resolve(value); };
    request.reject = code => { clearTimeout(timeout); reject(code); };
    startLocation();
  });
}

export function subscribeHeading(listener: (reading: HeadingState, problem?: CompassProblem) => void) {
  listeners.add(listener);
  listener(heading, problem);
  return () => { listeners.delete(listener); };
}

function startHeading() {
  stopCompass();
  heading = {};
  problem = undefined;
  publish();
  if (!compassOffered) return;
  const pointer = createPointer();
  stopCompass = watchCompass(sample => {
    heading = pointer.add(sample);
    clearTimeout(headingExpiry);
    headingExpiry = setTimeout(() => { heading = {}; publish(); }, 3000);
    publish();
  }, found => { problem = found; publish(); });
}

export async function enableSessionCompass() {
  try {
    if (await enableCompass()) { if (active) startHeading(); }
    else { problem = 'denied'; publish(); }
  } catch { problem = 'denied'; publish(); }
}

export function prepareSensors(onFix: () => void) {
  fixChanged = onFix;
  let disposed = false;
  const pause = () => {
    if (!active) return;
    active = false;
    generation++;
    locationRun++;
    if (watch !== undefined) navigator.geolocation.clearWatch(watch);
    watch = undefined;
    stopCompass();
    clearTimeout(headingExpiry);
    heading = {};
    publish();
  };
  const resume = () => {
    if (disposed || active || document.visibilityState === 'hidden') return;
    active = true;
    const current = ++generation;
    startHeading();
    // Never open a location permission prompt on launch. Capture supplies the deliberate action.
    void startupLocationPermission().then(permission => {
      if (!active || current !== generation) return;
      locationProblem = permission === 'denied' ? 1 : undefined;
      if (permission === 'granted') startLocation();
      else if (permission === 'denied') failLocation(1);
      else if (waiting.size) startLocation();
    }).catch(() => { if (active && current === generation && waiting.size) startLocation(); });
  };
  const visibility = () => document.visibilityState === 'hidden' ? pause() : resume();
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);
  const native = watchAppState(pause, resume);
  resume();
  return () => {
    disposed = true;
    pause();
    failLocation(2);
    fix = undefined;
    fixChanged = () => {};
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', resume);
    void native.then(remove => remove());
  };
}
