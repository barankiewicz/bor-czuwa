import ProofWorker from './proof.worker?worker';
import type { Challenge, Payload } from 'altcha-lib/v1/types';

export function solveProof(challenge: Challenge, signal: AbortSignal): Promise<Payload> {
  return new Promise((resolve, reject) => {
    const worker = new ProofWorker();
    const stop = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { stop(); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => { stop(); reject(new Error('proof_unavailable')); };
    worker.onmessage = ({ data }) => {
      stop();
      if (!data) { reject(new Error('proof_unsolved')); return; }
      resolve({ algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, signature: challenge.signature, number: data.number });
    };
    worker.postMessage({ type: 'work', payload: { ...challenge, max: challenge.maxnumber } });
  });
}
