import { drawTile } from './vector-map';

// Decodes vector tiles away from the main thread; see loadTile. A corrupt tile comes back as null.
self.onmessage = (event: MessageEvent<{ job: number; bytes: ArrayBuffer }>) => {
  let tile = null;
  try { tile = drawTile(new Uint8Array(event.data.bytes)); } catch { /* the face stays rings on paper */ }
  self.postMessage({ job: event.data.job, tile });
};
