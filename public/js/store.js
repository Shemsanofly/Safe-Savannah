// Polls /api/overview and notifies subscribers. Tracks connection health and last update.
import { api, setServerTime } from './lib.js';

const POLL_MS = 2500;
const listeners = new Set();
export const state = {
  overview: null,
  lastOkAt: null,
  error: null,
  failures: 0,
};

export function subscribe(fn) {
  listeners.add(fn);
  if (state.overview) fn(state);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
}

let timer = null;
let inflight = null;
let endpoint = '/api/overview';
export async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await api.get(endpoint);
      setServerTime(data.serverTime);
      state.overview = data;
      state.lastOkAt = Date.now();
      state.error = null;
      state.failures = 0;
    } catch (err) {
      state.error = err;
      state.failures += 1;
    } finally {
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

/** Start polling. Front-desk accounts poll their lodge's status instead of the park overview. */
export function start(url = '/api/overview') {
  endpoint = url;
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, POLL_MS);
  // Refresh promptly when the tab comes back into view.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}
