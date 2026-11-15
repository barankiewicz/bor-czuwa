import { buildContours, drawContours } from './contours';

// Traces and paints the contours away from the main thread; see loadContours and paintContours.
self.onmessage = async (event: MessageEvent) => {
  const job = event.data;
  if (job.kind === 'build') self.postMessage(await buildContours({ lat: job.lat, lon: job.lon }) ?? null);
  else if (job.kind === 'paint') self.postMessage(await drawContours(job.contours, job.view, job.size, job.pixelRatio, job.ink).catch(() => undefined) ?? null);
};
