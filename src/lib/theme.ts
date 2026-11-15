import { isNight } from './daylight';

type Position = { lat: number; lon: number };
const middleOfPoland: Position = { lat: 52.1, lon: 19.4 };

/** The same choice as `watchTheme` at the middle of Poland, as a script for the document head, so the
 * first frame already has the palette and a page never paints the light ground before turning dark. */
export const themeBeforePaint = `document.documentElement.dataset.theme = (${isNight})(new Date(), ${middleOfPoland.lat}, ${middleOfPoland.lon})`
  + ` ? 'noc' : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';`;

/**
 * Keeps the root palette on noc between civil dusk and dawn, else on the system's light or dark.
 * The caller supplies the foreground session's fresh fix or its latest Draft fix. Without either,
 * the sun is taken at the middle of Poland; the theme never starts another location request.
 */
export function watchTheme(fallback: () => Position | undefined = () => undefined) {
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    const at = fallback() ?? middleOfPoland;
    document.documentElement.dataset.theme = isNight(new Date(), at.lat, at.lon) ? 'noc' : dark.matches ? 'dark' : 'light';
  };
  dark.addEventListener('change', update);
  const clock = setInterval(update, 60_000);
  update();
  return { update, stop: () => { dark.removeEventListener('change', update); clearInterval(clock); } };
}
