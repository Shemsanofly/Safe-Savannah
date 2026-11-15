// Shared helpers: DOM building, API calls, formatting, toasts, dialogs.

export const BOOT = JSON.parse(document.getElementById('ss-boot')?.textContent || '{}');

/** Build an element. Children may be nodes, strings, arrays, or falsy (skipped). */
export function el(tag, attrs, ...children) {
  const node = tag === 'svg' || tag === 'use' || tag === 'g' || tag === 'rect' || tag === 'line' || tag === 'text' || tag === 'polygon' || tag === 'circle' || tag === 'path'
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in node) node.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') node[k] = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(id, cls = 'icon') {
  const svg = el('svg', { class: cls, 'aria-hidden': 'true', focusable: 'false' });
  const use = el('use', {});
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

export function clear(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

// ---------------------------------------------------------------- API
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, url, body, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Cannot reach the Safe Savannah server. Check the laptop and network, and use your radio procedure meanwhile.');
  }
  if (res.status === 401) {
    location.href = '/login';
    throw new ApiError(401, 'unauthorized', 'Your session has ended. Please sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'error', data.message || `The server returned an error (HTTP ${res.status}).`);
  return data;
}
export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  patch: (url, body = {}, opts) => request('PATCH', url, body, opts),
};

export function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

// ---------------------------------------------------------------- time
let serverOffsetMs = 0;
export function setServerTime(iso) {
  const t = Date.parse(iso);
  if (Number.isFinite(t)) serverOffsetMs = t - Date.now();
}
export const now = () => Date.now() + serverOffsetMs;
const tz = BOOT.timeZone || undefined;

export function fmtTime(iso, withSeconds = true) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, timeZone: tz });
}
export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
}
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameDay = d.toLocaleDateString('en-CA', { timeZone: tz }) === new Date(now()).toLocaleDateString('en-CA', { timeZone: tz });
  return sameDay ? `Today ${fmtTime(iso, false)}` : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: tz })} ${fmtTime(iso, false)}`;
}
/** Today's date (YYYY-MM-DD) in the lodge time zone. */
export function lodgeToday(offsetDays = 0) {
  const d = new Date(now() + offsetDays * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}
export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 1) return 'under 1 s';
  if (seconds < 10 && !Number.isInteger(seconds)) return `${seconds.toFixed(1)} s`;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  const h = Math.floor(s / 3600);
  return `${h} h ${Math.floor((s % 3600) / 60)} min`;
}
export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now() - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function age(iso) {
  return fmtDuration((now() - Date.parse(iso)) / 1000);
}
export function secondsSince(iso) {
  return iso ? (now() - Date.parse(iso)) / 1000 : Infinity;
}
export function until(iso) {
  if (!iso) return '';
  const s = Math.round((Date.parse(iso) - now()) / 1000);
  return s <= 0 ? 'now' : `in ${fmtDuration(s)}`;
}

// ---------------------------------------------------------------- UI helpers
const toastBox = () => document.getElementById('toasts');
export function toast(message, kind = 'ok', ms = 5000) {
  const t = el('div', { class: `toast ${kind === 'error' ? 'is-error' : ''}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : 'check-circle'),
    el('div', { class: 'grow' }, message),
    el('button', { type: 'button', 'aria-label': 'Dismiss notification', onclick: () => t.remove() }, icon('x', 'icon icon-sm')),
  );
  toastBox()?.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Native <dialog> confirm. Resolves true/false. */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', tone = 'primary' }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { 'aria-labelledby': 'dlg-title' },
      el('form', { method: 'dialog' },
        el('div', { class: 'dialog-body' }, el('h2', { id: 'dlg-title' }, title), typeof body === 'string' ? el('p', {}, body) : body),
        el('div', { class: 'dialog-actions' },
          el('button', { class: 'btn', value: 'cancel', type: 'submit' }, 'Cancel'),
          el('button', { class: `btn btn-${tone}`, value: 'ok', type: 'submit' }, confirmLabel),
        ),
      ),
    );
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * Wire a submit button: shows progress, prevents duplicate submissions, reports
 * success/failure inline (aria-live) and as a toast.
 */
export async function runAction(button, statusEl, fn, { success } = {}) {
  if (button?.dataset.busy === '1') return null;
  let original = null;
  if (button) {
    button.dataset.busy = '1';
    original = [...button.childNodes];
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (button.tagName === 'BUTTON') button.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', {}, 'Saving…'));
  }
  if (statusEl) {
    statusEl.className = 'form-status';
    clear(statusEl, button ? '' : [el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Saving…']);
  }
  try {
    const result = await fn();
    if (statusEl) clear(statusEl);
    if (success) {
      if (statusEl) {
        statusEl.className = 'form-status is-ok';
        clear(statusEl, icon('check-circle', 'icon icon-sm'), success);
      }
      toast(success);
    }
    return result ?? true;
  } catch (err) {
    const msg = err.message || 'Something went wrong.';
    if (statusEl) {
      statusEl.className = 'form-status is-err';
      clear(statusEl, icon('alert', 'icon icon-sm'), msg);
    }
    toast(msg, 'error');
    return null;
  } finally {
    if (button) {
      if (button.tagName === 'BUTTON') button.replaceChildren(...original);
      button.disabled = false;
      button.removeAttribute('aria-busy');
      delete button.dataset.busy;
    }
  }
}

/** Mark a field invalid with a message, or clear it. Returns whether valid. */
export function validateRequired(input, errorEl, message) {
  const ok = input.value.trim().length > 0;
  input.setAttribute('aria-invalid', ok ? 'false' : 'true');
  if (errorEl) {
    errorEl.hidden = ok;
    clear(errorEl, ok ? '' : [icon('alert', 'icon icon-sm'), message]);
  }
  if (!ok) input.focus();
  return ok;
}

export function initials(name) {
  const words = (name || '').split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}
