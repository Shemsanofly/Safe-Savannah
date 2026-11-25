// Safe Savannah traveller app (mobile-first, English / Kiswahili).
import { ApiError, api, BOOT, clear, confirmDialog, el, icon, setServerTime, toast } from '../lib.js';
import { GUIDE, LANGUAGES, LOCALE, PHRASE_MEANINGS, PHRASES, STRINGS } from './i18n.js';

const main = document.getElementById('t-main');
const nav = document.getElementById('t-nav');
const banner = document.getElementById('conn-banner');
let lang = readLang();
let me = null; // { tourist, feed, emergencyLine, smsMode }
let areas = [];
let timer = null;
let failures = 0;
let lastFeedAt = null;
let registrationStep = 1;
// A lodge check-in started from the reception QR code (#/checkin?lodge=CODE); survives sign-in or registration.
let pendingLodge = null; // { code, name, area_id, area_name }
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');
function rememberCheckin(code) {
  try { sessionStorage.setItem('ss-checkin', code); } catch { /* optional */ }
}
function storedCheckin() {
  try { return sessionStorage.getItem('ss-checkin'); } catch { return null; }
}
function forgetCheckin() {
  pendingLodge = null;
  try { sessionStorage.removeItem('ss-checkin'); } catch { /* optional */ }
}
async function loadPendingLodge() {
  const code = hashParams().get('lodge') || pendingLodge?.code || storedCheckin();
  if (!code) return null;
  if (pendingLodge?.code === code.toUpperCase()) return pendingLodge;
  try {
    const r = await api.get(`/api/public/lodges/${encodeURIComponent(code)}`);
    pendingLodge = { code: r.lodge.code, name: r.lodge.name, area_id: r.lodge.area_id, area_name: r.lodge.area_name };
    rememberCheckin(pendingLodge.code);
  } catch {
    forgetCheckin();
    return { invalid: true };
  }
  return pendingLodge;
}
const checkinBanner = () => (pendingLodge ? el('div', { class: 't-checkin-banner' }, icon('home'), el('span', {}, T('checkin_banner', pendingLodge.name))) : null);
const authDraft = { login: {}, register: {} };

const T = (k, ...a) => {
  const v = STRINGS[lang][k] ?? STRINGS.en[k] ?? k;
  return typeof v === 'function' ? v(...a) : v;
};
function readLang() {
  try {
    const saved = localStorage.getItem('ss-lang');
    if (STRINGS[saved]) return saved;
    // First visit: use the phone's language when we have it.
    const phone = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return STRINGS[phone] ? phone : 'en';
  } catch {
    return 'en';
  }
}
function setLang(l) {
  rememberAuth();
  lang = l;
  try {
    localStorage.setItem('ss-lang', l);
    sessionStorage.setItem('ss-lang-chosen', '1');
  } catch {
    /* ignore */
  }
  syncLangPicker();
  if (me) api.patch('/api/tourist/me', { language: l }).catch(() => undefined); // SMS also switch language
  route();
}
const langPicker = document.getElementById('t-lang-select');
function syncLangPicker() {
  if (langPicker) langPicker.value = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : lang;
}
langPicker?.addEventListener('change', () => setLang(langPicker.value));
syncLangPicker();

const tAge = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return T('age_now');
  if (s < 3600) return T('age_min', Math.floor(s / 60));
  if (s < 86400) return T('age_hours', Math.floor(s / 3600));
  return new Date(iso).toLocaleDateString(LOCALE[lang] || 'en-GB', { day: 'numeric', month: 'short' });
};
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE[lang] || 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// ---------------------------------------------------------------- data
async function loadMe() {
  try {
    const r = await api.get('/api/tourist/me');
    if (!r.tourist) {
      me = null;
      failures = 0;
      banner.hidden = true;
      return null;
    }
    me = r;
    lastFeedAt = Date.now();
    setServerTime(me.serverTime);
    if (me.tourist.language !== lang && !sessionStorageGet('ss-lang-chosen')) setLangSilently(me.tourist.language);
    failures = 0;
    banner.hidden = true;
    updateFreshness();
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      me = null;
      return null;
    }
    failures += 1;
    if (failures >= 1) {
      banner.hidden = false;
      clear(banner, icon('wifi-off'), el('span', {}, T('offline'), ' ', el('a', { href: `tel:${BOOT.emergencyLine}`, class: 'strong' }, `${T('call')} ${BOOT.emergencyLine}`)));
    }
    updateFreshness();
    return me;
  }
}
function sessionStorageGet(k) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function setLangSilently(l) {
  lang = l;
  syncLangPicker();
}
// lib.api redirects to /login on 401; the traveller app handles 401 itself.
const tApi = {
  async post(url, body) {
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || 'error', data.message || `HTTP ${res.status}`);
    return data;
  },
};

// ---------------------------------------------------------------- shell
function renderNav() {
  const r = currentRoute();
  const items = me
    ? [['home', 'home', 'nav_home'], ['alerts', 'incident', 'nav_alerts'], ['sos', 'siren', 'nav_sos'], ['guide', 'book', 'nav_guide'], ['trip', 'user', 'nav_trip']]
    : [['welcome', 'home', 'nav_welcome'], ['guide', 'book', 'nav_guide']];
  nav.hidden = false;
  const unread = me ? me.feed.alerts.filter((a) => a.active).length : 0;
  clear(nav, el('div', { class: 't-nav-inner' }, items.map(([route, ic, key]) =>
    el('a', { href: `#/${route}`, class: route === 'sos' ? 't-sos-link' : null, 'aria-current': r === route ? 'page' : null,
      // Re-tapping the current tab refreshes it (the hash does not change, so no hashchange fires).
      onclick: (e) => { if (location.hash === `#/${route}`) { e.preventDefault(); loadMe().then(rerender); } } },
      el('span', { class: 't-nav-icon' }, icon(ic), route === 'alerts' && unread ? el('span', { class: 't-badge', 'aria-hidden': 'true' }, String(unread)) : null),
      el('span', {}, T(key), route === 'alerts' && unread ? el('span', { class: 'sr-only' }, ` (${unread})`) : null)))));
}
function currentRoute() {
  return location.hash.replace(/^#\/?/, '').split('?')[0] || (me ? 'home' : 'welcome');
}
function page(title, ...children) {
  clear(main, el('h1', { class: 'sr-only', tabindex: '-1' }, title), me ? el('p', { class: 'feed-freshness muted small', 'data-feed-freshness': true }) : null, ...children);
  updateFreshness();
  document.title = `${title} · Safe Savannah`;
}
function updateFreshness() {
  const stale = !!me && (failures > 0 || !lastFeedAt || Date.now() - lastFeedAt > 45000);
  main.classList.toggle('is-stale', stale);
  const label = main.querySelector('[data-feed-freshness]');
  if (label) label.textContent = `${stale ? `${T('status_stale')} · ` : ''}${T('updated')}: ${lastFeedAt ? new Date(lastFeedAt).toLocaleTimeString(LOCALE[lang] || 'en-GB') : '—'}`;
}
setInterval(updateFreshness, 1000);

async function route() {
  clearInterval(timer);
  const r = currentRoute();
  const needsAuth = ['home', 'alerts', 'sos', 'trip', 'escort', 'out', 'tour'].includes(r);
  // Always fetch fresh data when entering a signed-in screen (status may have changed meanwhile).
  if (needsAuth) await loadMe();
  if (needsAuth && !me) return go('welcome');
  if (r === 'checkin') await loadMe();
  if (['login', 'register', 'checkin'].includes(r) && !pendingLodge?.invalid) await loadPendingLodge();
  if (!needsAuth && (r === 'welcome' || r === 'login' || r === 'register') && me) return go(pendingLodge ? 'checkin' : 'home');
  if (r === 'checkin' && !me && pendingLodge && !pendingLodge.invalid) return go('register');
  renderNav();
  const isAuth = !me && ['welcome', 'login', 'register', 'checkin'].includes(r);
  document.body.classList.toggle('t-auth-page', isAuth);
  nav.hidden = isAuth;
  const views = { welcome, login, register, home, alerts, sos, guide, trip, checkin, escort, out, tour };
  (views[r] || (me ? home : welcome))();
  main.querySelector('h1')?.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}
function rerender() {
  renderNav();
  route();
}
function go(r) {
  if (location.hash === `#/${r}`) route();
  else location.hash = `#/${r}`;
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- views
function welcome() {
  login();
}

function rememberAuth() {
  const form = main.querySelector('[data-auth-form]');
  if (!form) return;
  const draft = authDraft[form.dataset.authForm];
  form.querySelectorAll('input, select').forEach((control) => {
    draft[control.id] = control.type === 'checkbox' ? control.checked : control.value;
  });
}

function authLayout(mode, form) {
  const isRegister = mode === 'register';
  const draft = authDraft[mode];
  form.dataset.authForm = mode;
  form.querySelectorAll('input, select').forEach((control) => {
    if (draft[control.id] === undefined) return;
    if (control.type === 'checkbox') control.checked = draft[control.id];
    else control.value = draft[control.id];
  });
  form.addEventListener('input', (event) => {
    rememberAuth();
    event.target.removeAttribute('aria-invalid');
    const error = form.querySelector('#t-auth-error');
    if (error) error.hidden = true;
  });
  form.addEventListener('change', rememberAuth);
  const feature = (ic, title, body) => el('li', {}, el('span', { class: 't-feature-icon' }, icon(ic)),
    el('div', {}, el('strong', {}, T(title)), el('p', {}, T(body))));
  page(T(isRegister ? 'create_account' : 'sign_in'),
    el('div', { class: 't-auth-layout' },
      el('section', { class: 't-auth-story', 'aria-labelledby': 't-story-title' },
        el('div', { class: 't-story-copy' },
          el('span', { class: 't-eyebrow' }, icon('globe'), T('traveller_companion')),
          el('h2', { id: 't-story-title' }, T('auth_headline'), ' ', el('em', {}, T('auth_headline_accent'))),
          el('p', { class: 't-story-intro' }, T('auth_intro')),
          el('ul', { class: 't-auth-features' }, feature('paw', 'feature_alerts', 'feature_alerts_body'),
            feature('radio', 'feature_help', 'feature_help_body'), feature('book', 'feature_guide', 'feature_guide_body'))),
        el('div', { class: 't-story-caption' }, icon('pin'), el('span', {}, T('auth_caption')))),
      el('section', { class: 't-auth-panel' },
        el('div', { class: 't-auth-card' },
          el('nav', { class: 't-auth-switch', 'aria-label': T('account_options') },
            el('a', { href: '#/login', 'aria-current': !isRegister ? 'page' : null }, T('sign_in')),
            el('a', { href: '#/register', 'aria-current': isRegister ? 'page' : null }, T('create_account'))),
          form),
        el('div', { class: 't-auth-support' }, el('a', { href: '#/guide' }, icon('book'), T('read_guidance')),
          el('a', { href: `tel:${BOOT.emergencyLine}` }, icon('phone'), `${T('emergency_line')}: ${BOOT.emergencyLine}`)))));
}

function pinControl(input) {
  const toggle = el('button', { type: 'button', class: 't-pin-toggle', 'aria-label': T('show_pin'), 'aria-pressed': 'false', 'aria-controls': input.id }, T('show'));
  toggle.addEventListener('click', () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    toggle.textContent = T(visible ? 'hide' : 'show');
    toggle.setAttribute('aria-label', T(visible ? 'hide_pin' : 'show_pin'));
    toggle.setAttribute('aria-pressed', String(visible));
  });
  return el('div', { class: 't-pin-control' }, input, toggle);
}

function authError(err) {
  if (!(err instanceof ApiError)) return T('err_connection');
  const key = { invalid_login: 'err_login', phone_registered: 'err_registered', invalid_phone: 'err_phone' }[err.code];
  return key ? T(key) : err.message;
}

function field(id, label, control, hint) {
  return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('p', { class: 'hint', id: `${id}-hint` }, hint) : null);
}

function login() {
  const phone = el('input', { id: 'l-phone', type: 'tel', autocomplete: 'username', inputmode: 'tel', placeholder: '+255 712 345 678', required: true, 'aria-describedby': 'l-phone-hint' });
  const pin = el('input', { id: 'l-pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', placeholder: T('enter_pin'), required: true, maxlength: '12' });
  const err = el('div', { id: 't-auth-error', class: 'alert alert-error', role: 'alert', hidden: true });
  const btn = el('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, el('span', {}, T('sign_in')), icon('chevron-right'));
  const form = el('form', { class: 't-auth-form', novalidate: true },
    checkinBanner(),
    el('div', { class: 't-auth-heading' }, el('h2', {}, T('welcome_back')), el('p', {}, T('login_intro'))),
    err, field('l-phone', T('phone'), phone, T('login_phone_hint')), field('l-pin', T('pin_login'), pinControl(pin)), btn,
    el('p', { class: 't-privacy-note' }, icon('shield'), T('login_privacy')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    for (const i of [phone, pin]) i.setAttribute('aria-invalid', i.value.trim() ? 'false' : 'true');
    if (!phone.value.trim() || !pin.value.trim()) {
      err.hidden = false;
      err.textContent = T('err_required');
      (phone.value.trim() ? pin : phone).focus();
      return;
    }
    await busy(btn, async () => {
      try {
        await tApi.post('/api/tourist/login', { phone: phone.value, pin: pin.value });
        authDraft.login = {};
        authDraft.register = {};
        await loadMe();
        go(pendingLodge && !pendingLodge.invalid ? 'checkin' : 'home');
      } catch (e2) {
        err.hidden = false;
        err.textContent = authError(e2);
      }
    });
  });
  authLayout('login', form);
}

async function register() {
  if (!areas.length) {
    page(T('create_account'), el('div', { class: 'view-loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), T('loading')));
    areas = (await api.get('/api/public/areas').catch(() => ({ areas: [] }))).areas;
    if (currentRoute() !== 'register') return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const plus = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const f = {
    name: el('input', { id: 'r-name', autocomplete: 'name', placeholder: T('name_placeholder'), required: true, minlength: '2', maxlength: '80' }),
    phone: el('input', { id: 'r-phone', type: 'tel', autocomplete: 'tel', inputmode: 'tel', placeholder: '+255…', required: true, 'aria-describedby': 'r-phone-hint' }),
    pin: el('input', { id: 'r-pin', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: T('pin_placeholder'), required: true, minlength: '4', maxlength: '12', pattern: '[0-9]{4,12}', 'aria-describedby': 'r-pin-hint' }),
    area_id: el('select', { id: 'r-area', required: true }, el('option', { value: '' }, T('choose_destination')), areas.map((a) => el('option', { value: a.id }, a.name))),
    lodge: el('input', { id: 'r-lodge' }),
    trip_start: el('input', { id: 'r-start', type: 'date', value: today, required: true }),
    trip_end: el('input', { id: 'r-end', type: 'date', value: plus(3), required: true }),
    group_size: el('input', { id: 'r-group', type: 'number', min: '1', max: '60', value: '1', inputmode: 'numeric' }),
    nationality: el('input', { id: 'r-nat', autocomplete: 'country-name' }),
    emergency_contact: el('input', { id: 'r-ec' }),
    sms_alerts: el('input', { id: 'r-sms', type: 'checkbox', checked: true }),
  };
  const err = el('div', { id: 't-auth-error', class: 'alert alert-error', role: 'alert', hidden: true });
  const btn = el('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' });
  const heading = el('h2', { tabindex: '-1' });
  const intro = el('p', {});
  const steps = el('ol', { class: 't-auth-steps', 'aria-label': T('registration_progress') });
  const account = el('fieldset', { class: 't-auth-fields' }, el('legend', { class: 'sr-only' }, T('your_account')),
    field('r-name', T('name'), f.name), field('r-phone', T('phone'), f.phone, T('phone_hint')), field('r-pin', T('pin'), pinControl(f.pin), T('pin_hint')));
  const areaError = !areas.length ? el('div', { class: 'alert alert-error', role: 'alert' }, T('err_areas'),
    el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { rememberAuth(); register(); } }, T('retry'))) : null;
  const lodgeKnown = pendingLodge && !pendingLodge.invalid;
  if (lodgeKnown) {
    f.area_id.value = pendingLodge.area_id;
    f.lodge.value = pendingLodge.name;
  }
  const tripFields = el('fieldset', { class: 't-auth-fields' }, el('legend', { class: 'sr-only' }, T('your_trip')),
    lodgeKnown ? null : areaError, lodgeKnown ? null : field('r-area', T('destination'), f.area_id), lodgeKnown ? null : field('r-lodge', T('lodge'), f.lodge),
    el('div', { class: 't-form-grid' }, field('r-start', T('trip_start'), f.trip_start), field('r-end', T('trip_end'), f.trip_end)),
    field('r-group', T('group'), f.group_size),
    el('details', { class: 't-auth-optional' }, el('summary', {}, icon('plus'), T('optional_details')),
      field('r-nat', T('nationality'), f.nationality), field('r-ec', T('emergency_contact'), f.emergency_contact)),
    el('label', { class: 't-sms-choice' }, f.sms_alerts, el('span', {}, T('sms_alerts'))),
    el('p', { class: 't-privacy-note' }, icon('shield'), T('consent')));
  const back = el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { showStep(1); heading.focus(); } }, icon('chevron-left'), T('back'));
  const form = el('form', { class: 't-auth-form', novalidate: true },
    checkinBanner(),
    el('div', { class: 't-auth-heading' }, heading, intro),
    steps, err, account, tripFields, el('div', { class: 't-auth-actions' }, back, btn),
    lodgeKnown ? el('p', { class: 't-privacy-note' }, icon('user'), el('a', { href: '#/login' }, T('checkin_signin_hint'))) : null);
  function showStep(step) {
    registrationStep = step;
    account.hidden = step !== 1;
    tripFields.hidden = step !== 2;
    back.hidden = step !== 2;
    heading.textContent = T(step === 1 ? 'create_account' : 'plan_your_trip');
    intro.textContent = T(step === 1 ? 'register_intro' : 'trip_intro');
    clear(btn, el('span', {}, T(step === 1 ? 'continue_trip' : 'register')), icon('chevron-right'));
    clear(steps, [1, 2].map((n) => el('li', { class: n <= step ? 'is-active' : null, 'aria-current': n === step ? 'step' : null },
      el('span', {}, n < step ? icon('check') : String(n)), T(n === 1 ? 'your_account' : 'your_trip'))));
    err.hidden = true;
  }
  function invalid(key, message) {
    if (['name', 'phone', 'pin'].includes(key) && registrationStep !== 1) showStep(1);
    err.hidden = false;
    err.textContent = message;
    f[key].setAttribute('aria-invalid', 'true');
    f[key].setAttribute('aria-describedby', ['phone', 'pin'].includes(key) ? `${f[key].id}-hint t-auth-error` : 't-auth-error');
    f[key].focus();
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    Object.values(f).forEach((control) => control.removeAttribute('aria-invalid'));
    const required = registrationStep === 1 ? ['name', 'phone', 'pin'] : ['name', 'phone', 'pin', 'area_id', 'trip_start', 'trip_end'];
    const missing = required.find((k) => !f[k].value.trim());
    if (missing) return invalid(missing, T('err_required'));
    if (f.name.value.trim().length < 2) return invalid('name', T('err_name'));
    const digits = f.phone.value.replace(/[\s()-]/g, '');
    if (!/^(\+\d{9,15}|255\d{9}|0[67]\d{8})$/.test(digits)) return invalid('phone', T('err_phone'));
    if (!/^[0-9]{4,12}$/.test(f.pin.value)) return invalid('pin', T('err_pin'));
    if (registrationStep === 1) { showStep(2); heading.focus(); return; }
    if (!f.trip_start.validity.valid) return invalid('trip_start', T('err_date'));
    if (!f.trip_end.validity.valid || f.trip_end.value < f.trip_start.value) return invalid('trip_end', T('err_dates'));
    if (!f.group_size.validity.valid || !f.group_size.value) return invalid('group_size', T('err_group'));
    await busy(btn, async () => {
      try {
        await tApi.post('/api/tourist/register', {
          name: f.name.value, phone: f.phone.value, pin: f.pin.value, language: lang, area_id: f.area_id.value, lodge: f.lodge.value || null,
          trip_start: f.trip_start.value, trip_end: f.trip_end.value, group_size: Number(f.group_size.value || 1), nationality: f.nationality.value || null,
          emergency_contact: f.emergency_contact.value || null, sms_alerts: f.sms_alerts.checked,
          lodge_code: lodgeKnown ? pendingLodge.code : undefined,
        });
        authDraft.register = {};
        authDraft.login = {};
        registrationStep = 1;
        if (lodgeKnown) toast(T('checkin_done', pendingLodge.name));
        forgetCheckin();
        await loadMe();
        go('home');
      } catch (e2) {
        err.hidden = false;
        err.textContent = authError(e2);
        const map = { phone: 'phone', pin: 'pin', trip_end: 'trip_end', name: 'name', area_id: 'area_id' };
        const bad = Object.keys(map).find((k) => e2.message.toLowerCase().includes(k.replace('_', ' ')) || e2.code === `invalid_${k}`);
        if (bad) invalid(bad, authError(e2));
        if (e2.code === 'phone_registered') invalid('phone', T('err_registered'));
      }
    });
  });
  showStep(registrationStep);
  authLayout('register', form);
}

// ---------------------------------------------------------------- signed-in views
const LEVEL_ICON = { danger: 'siren', warning: 'alert', advisory: 'info', clear: 'check-circle' };
const SOS_TYPES = [['medical', 'heart', 't_medical'], ['wildlife', 'paw', 't_wildlife'], ['vehicle', 'car', 't_vehicle'], ['personal', 'shield', 't_personal']];
const sosDraft = { type: null, details: '', withLoc: true }; // survives background refreshes
/** Alert text in the guest's language: stored translations first, then the Kiswahili/English columns. */
const localized = (a, k) => a.content?.[lang]?.[k] ?? (lang === 'sw' ? a[`${k}_sw`] : a[`${k}_en`]) ?? a[`${k}_en`] ?? '';
const alertSteps = (a) => a.content?.[lang]?.actions ?? (lang === 'sw' ? a.actions_sw : a.actions_en) ?? [];
const isSimulated = (a) => /simulated|jaribio/i.test(`${a.title_en} ${a.title_sw}`);
const isOpen = (s) => s.status === 'open' || s.status === 'acknowledged';
const firstName = () => me.tourist.name.split(' ')[0];

function pageHead(title, sub) {
  return el('header', { class: 't-page-head' }, el('h2', {}, title), sub ? el('p', {}, sub) : null);
}
function emptyCard(ic, title, body) {
  return el('div', { class: 't-panel t-empty' }, el('span', { class: 't-empty-icon' }, icon(ic)), el('strong', {}, title), el('p', {}, body));
}

function home() {
  const feed = me.feed;
  const active = feed.alerts.filter((a) => a.active);
  const openSos = feed.sos.find(isOpen);
  const check = feed.checks?.[0];
  page(`${T('hello')}, ${firstName()}`,
    check ? rollCallCard(check, home) : travellerIntro(),
    openSos ? sosTracker(openSos, { compact: true }) : null,
    planCards(),
    el('div', { class: 't-home' },
      el('div', { class: 't-col' }, tripCard(), safetyStatus(active, feed.activeWildlifeIncidents, recentClear())),
      el('div', { class: 't-col' }, openSos ? null : sosCallout(), quickActions(), todayCard())));
  // Refresh often enough that a lodge roll call or warning shows up within seconds.
  pollMe(openSos || check ? 5000 : 8000, home);
}

/** "All clear" notices from the last three hours. */
function recentClear() {
  return me.feed.alerts.filter((a) => a.level === 'clear' && Date.now() - Date.parse(a.created_at) < 3 * 3_600_000);
}

/** The lodge's roll call: one tap for "I'm safe" or "I need help". */
function rollCallCard(check, view) {
  if (check.status === 'safe') {
    return el('section', { class: 't-rollcall is-safe', role: 'status' },
      el('span', { class: 't-rollcall-icon' }, icon('check-circle')),
      el('div', {}, el('h2', {}, T('rc_thanks')), el('p', {}, T('rc_thanks_sub'))));
  }
  if (check.status === 'help') {
    return el('section', { class: 't-rollcall is-help', role: 'status' },
      el('span', { class: 't-rollcall-icon' }, icon('siren')),
      el('div', {}, el('h2', {}, T('rc_help_sent')), el('p', {}, T('status_open_hint'))));
  }
  const safe = el('button', { type: 'button', class: 't-rc-btn is-safe' }, icon('check-circle'), el('span', {}, T('rc_safe')));
  const help = el('button', { type: 'button', class: 't-rc-btn is-help' }, icon('siren'), el('span', {}, T('rc_help')));
  const err = el('p', { class: 'field-error', role: 'alert', hidden: true });
  const answer = (btn, status) => busy(btn, async () => {
    try {
      const pos = status === 'help' ? await getPosition() : null;
      await tApi.post(`/api/tourist/checks/${check.id}`, { status, lat: pos?.lat, lng: pos?.lng });
      toast(status === 'safe' ? T('rc_thanks') : T('rc_help_sent'));
      await loadMe();
      view();
    } catch (e2) {
      err.hidden = false;
      clear(err, e2.message, ' ', el('a', { href: `tel:${me.emergencyLine}`, class: 'strong' }, `${T('call')} ${me.emergencyLine}`));
    }
  });
  safe.addEventListener('click', () => answer(safe, 'safe'));
  help.addEventListener('click', async () => {
    if (await confirmDialog({ title: T('rc_help_confirm_title'), body: T('rc_help_confirm_body'), confirmLabel: T('rc_help'), tone: 'urgent' })) answer(help, 'help');
  });
  return el('section', { class: 't-rollcall is-ask', 'aria-labelledby': 't-rc-title' },
    el('p', { class: 't-kicker' }, T('rc_kicker', check.lodge_name)),
    el('h2', { id: 't-rc-title' }, T('rc_title')),
    el('p', { class: 't-rc-reason' }, icon('alert', 'icon icon-sm'), el('span', {}, check.reason_i18n?.[lang] || check.reason)),
    el('div', { class: 't-rc-actions' }, safe, help),
    el('p', { class: 't-rc-note' }, T('rc_body')),
    err);
}

/** Opened from the reception QR code: confirm the stay at this lodge. */
async function checkin() {
  const lodge = await loadPendingLodge();
  if (!lodge || lodge.invalid) {
    page(T('checkin_title'), el('div', { class: 't-auth-solo' }, emptyCard('alert', T('checkin_title'), T('checkin_invalid')),
      el('a', { class: 'btn btn-block', href: me ? '#/home' : '#/login' }, T(me ? 'nav_home' : 'sign_in'))));
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const leaving = el('input', { id: 'c-end', type: 'date', min: today, value: me.tourist.trip_end >= today ? me.tourist.trip_end : new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) });
  const err = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const btn = el('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, icon('home'), el('span', {}, T('checkin_btn')));
  const form = el('form', { class: 't-panel t-checkin', novalidate: true },
    el('span', { class: 't-empty-icon' }, icon('home')),
    el('h2', {}, T('checkin_at', lodge.name)),
    el('p', { class: 't-muted' }, `${lodge.area_name}. ${T('checkin_body')}`),
    err, field('c-end', T('checkin_leaving'), leaving), btn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(btn, async () => {
      try {
        await tApi.post('/api/tourist/checkin', { code: lodge.code, trip_end: leaving.value || undefined });
        toast(T('checkin_done', lodge.name));
        forgetCheckin();
        await loadMe();
        go('home');
      } catch (e2) {
        err.hidden = false;
        err.textContent = e2.message;
      }
    });
  });
  page(T('checkin_title'), el('div', { class: 't-auth-solo' }, form));
}

function travellerIntro() {
  const key = `ss-intro-traveller-v1:${me.tourist.id}`;
  try { if (localStorage.getItem(key)) return null; } catch { /* optional storage */ }
  const done = el('button', { type: 'button', class: 'btn btn-sm' }, T('intro_done'));
  const card = el('section', { class: 'onboarding', 'aria-labelledby': 'traveller-intro-title' }, el('div', { class: 'row between' }, el('h2', { id: 'traveller-intro-title' }, T('intro_title')), done), el('p', {}, T('intro_body')));
  done.addEventListener('click', () => { try { localStorage.setItem(key, '1'); } catch { /* optional storage */ } card.remove(); });
  return card;
}

function tripCard() {
  const t = me.tourist;
  return el('section', { class: 't-trip-card', 'aria-label': T('your_safari') },
    el('p', { class: 't-kicker' }, T('your_safari')),
    el('h2', {}, `${T('hello')}, ${firstName()}`),
    el('ul', { class: 't-chips' },
      el('li', {}, icon('pin', 'icon icon-sm'), [t.lodge, me.feed.area?.name].filter(Boolean).join(' · ')),
      el('li', {}, icon('calendar', 'icon icon-sm'), `${fmtDay(t.trip_start)} – ${fmtDay(t.trip_end)}`),
      el('li', {}, icon('users', 'icon icon-sm'), T('people', t.group_size))));
}

/** Reported alerts never establish that an area is safe. */
function safetyStatus(active, monitoring, clears = []) {
  if (active.length) {
    const sev = active.some((a) => a.level === 'danger') ? 'danger' : 'warning';
    const lead = active.find((a) => a.level === sev) || active[0];
    const steps = alertSteps(lead);
    return el('section', { class: `t-safety is-${sev}`, role: 'status', 'aria-labelledby': 't-safety-title' },
      el('div', { class: 't-safety-head' }, el('span', { class: 't-safety-icon' }, icon(sev === 'danger' ? 'siren' : 'alert')),
        el('div', {}, el('p', { class: 't-kicker' }, T(sev === 'danger' ? 'status_danger' : 'status_warning')), el('h2', { id: 't-safety-title' }, localized(lead, 'title')))),
      steps.length ? el('ul', { class: 't-checklist', 'aria-label': T('what_to_do') }, steps.slice(0, 3).map((x) => el('li', {}, icon('check', 'icon icon-sm'), el('span', {}, x)))) : null,
      el('a', { href: '#/alerts', class: 't-safety-link' }, el('span', {}, T('see_all_alerts')),
        active.length > 1 ? el('span', { class: 't-count' }, T('more_alerts', active.length - 1)) : null, icon('chevron-right', 'icon icon-sm')));
  }
  if (clears.length) {
    const c = clears[0];
    return el('section', { class: 't-safety is-clear is-allclear', role: 'status', 'aria-labelledby': 't-safety-title' },
      el('div', { class: 't-safety-head' }, el('span', { class: 't-safety-icon' }, icon('check-circle')),
        el('div', {}, el('p', { class: 't-kicker' }, `${T('clear_kicker')} · ${tAge(c.created_at)}`), el('h2', { id: 't-safety-title' }, localized(c, 'title')),
          el('p', {}, localized(c, 'body')))));
  }
  const watching = monitoring > 0;
  return el('section', { class: `t-safety ${watching ? 'is-watch' : 'is-clear'}`, role: 'status', 'aria-labelledby': 't-safety-title' },
    el('div', { class: 't-safety-head' }, el('span', { class: 't-safety-icon' }, icon(watching ? 'eye' : 'check-circle')),
      el('div', {}, el('h2', { id: 't-safety-title' }, T(watching ? 'status_monitoring' : 'status_clear')),
        el('p', {}, T(watching ? 'status_monitoring_body' : 'no_alerts_body')))));
}

function sosCallout() {
  return el('a', { href: '#/sos', class: 't-sos-cta' },
    el('span', { class: 't-sos-ring' }, icon('siren')),
    el('span', { class: 't-sos-text' }, el('small', {}, T('need_help')), el('strong', {}, T('sos_cta')), el('small', {}, T('sos_cta_sub'))),
    icon('chevron-right'));
}

function quickActions() {
  const t = me.tourist;
  const line = me.emergencyLine;
  const sub = el('small', { 'aria-live': 'polite' }, t.last_located_at ? `${T('location_shared')} · ${tAge(t.last_located_at)}` : T('location_short'));
  const share = el('button', { type: 'button', class: 't-qa' }, el('span', { class: 't-qa-icon' }, icon('pin')), el('span', { class: 't-qa-text' }, el('strong', {}, T('share_short')), sub));
  share.addEventListener('click', () => busy(share, async () => {
    const pos = await getPosition();
    if (!pos) {
      sub.textContent = T('location_denied');
      return;
    }
    await tApi.post('/api/tourist/location', pos);
    sub.textContent = `${T('location_shared')} · ${tAge(new Date().toISOString())}`;
    toast(T('location_shared'));
  }));
  const tile = (href, ic, title, subText) => el('a', { class: 't-qa', href }, el('span', { class: 't-qa-icon' }, icon(ic)), el('span', { class: 't-qa-text' }, el('strong', {}, title), el('small', {}, subText)));
  return el('section', { class: 't-quick', 'aria-labelledby': 't-qa-title' },
    el('h3', { id: 't-qa-title', class: 't-section-title' }, T('quick_actions')),
    el('div', { class: 't-qa-grid' },
      tile('#/out', 'map', T('out_short'), T('out_qa_sub')),
      t.lodge_id ? tile('#/escort', 'person', T('escort_short'), T('escort_qa_sub')) : null,
      share,
      el('a', { class: 't-qa', href: `tel:${line}` }, el('span', { class: 't-qa-icon' }, icon('phone')), el('span', { class: 't-qa-text' }, el('strong', {}, `${T('call_short')} ${line}`), el('small', {}, T('emergency_line')))),
      el('a', { class: 't-qa', href: '#/guide' }, el('span', { class: 't-qa-icon' }, icon('book')), el('span', { class: 't-qa-text' }, el('strong', {}, T('tips_short')), el('small', {}, T('tips_sub'))))));
}

function alerts() {
  const list = me.feed.alerts;
  const clears = recentClear();
  const now = [...clears, ...list.filter((a) => a.active)];
  const earlier = list.filter((a) => !a.active && !clears.includes(a));
  const check = me.feed.checks?.[0];
  page(T('alerts_title'),
    check ? rollCallCard(check, alerts) : null,
    pageHead(T('alerts_title'), T('alerts_sub')),
    list.length ? null : emptyCard('check-circle', T('alerts_empty'), T('no_alerts_body')),
    now.length ? el('section', { class: 't-section' }, el('h3', { class: 't-section-title' }, T('now_section')), el('div', { class: 't-alert-list' }, now.map((a) => alertCard(a)))) : null,
    earlier.length ? el('section', { class: 't-section' }, el('h3', { class: 't-section-title' }, T('earlier_section')), el('div', { class: 't-alert-list' }, earlier.map((a) => alertCard(a, true)))) : null);
  pollMe(check ? 5000 : 8000, alerts);
}

function alertCard(a, past = false) {
  const lvl = LEVEL_ICON[a.level] ? a.level : 'advisory';
  const steps = alertSteps(a);
  const head = el('div', { class: 't-alert-head' },
    el('span', { class: 't-alert-icon' }, icon(LEVEL_ICON[lvl])),
    el('div', { class: 't-alert-title' },
      el('div', { class: 't-alert-meta' }, el('span', { class: 't-level' }, T(`level_${lvl}`)), el('span', {}, tAge(a.created_at)),
        isSimulated(a) ? el('span', { class: 'badge tone-sim' }, T('simulated_note')) : null, a.demo ? el('span', { class: 'badge tone-demo' }, T('demo_note')) : null),
      el('h4', {}, localized(a, 'title'))));
  const body = el('div', { class: 't-alert-body' }, el('p', {}, localized(a, 'body')),
    steps.length ? el('div', { class: 't-todo' }, el('strong', {}, T('what_to_do')), el('ol', {}, steps.map((x) => el('li', {}, x)))) : null);
  if (past) return el('details', { class: `t-alert lv-${lvl} is-past` }, el('summary', {}, head, icon('chevron-down', 'icon icon-sm t-caret')), body);
  return el('article', { class: `t-alert lv-${lvl}` }, head, body);
}

function sos() {
  const openSos = me.feed.sos.find(isOpen);
  page(T('sos_title'),
    pageHead(T('sos_title'), openSos ? null : T('sos_intro')),
    el('div', { class: 't-sos-layout' },
      el('div', { class: 't-col' }, openSos ? sosTracker(openSos) : sosForm()),
      el('aside', { class: 't-col' }, openSos ? null : callCard(), requestHistory(openSos))));
  pollMe(openSos ? 5000 : 15000, sos);
}

function sosForm() {
  const err = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const grid = el('div', { class: 't-type-grid', role: 'group', 'aria-labelledby': 't-step-type' }, SOS_TYPES.map(([v, ic, key]) => {
    const b = el('button', { type: 'button', class: 't-type', 'aria-pressed': String(sosDraft.type === v) }, el('span', { class: 't-type-icon' }, icon(ic)), el('span', {}, T(key)));
    b.addEventListener('click', () => {
      sosDraft.type = v;
      grid.querySelectorAll('.t-type').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      err.hidden = true;
    });
    return b;
  }));
  const details = el('textarea', { id: 's-details', rows: '2', maxlength: '500', placeholder: T('sos_details_ph') });
  details.value = sosDraft.details;
  details.addEventListener('input', () => { sosDraft.details = details.value; });
  const withLoc = el('input', { type: 'checkbox', id: 's-loc', checked: sosDraft.withLoc });
  withLoc.addEventListener('change', () => { sosDraft.withLoc = withLoc.checked; });
  const send = el('button', { type: 'submit', class: 't-send-sos' }, icon('siren'), el('span', {}, T('sos_send')));
  const form = el('form', { class: 't-panel t-sos-form', novalidate: true },
    el('h3', { class: 't-step', id: 't-step-type' }, T('sos_step_type')), grid,
    el('label', { class: 't-step', for: 's-details' }, T('sos_step_details')), details,
    el('label', { class: 't-switch' }, withLoc, el('span', { class: 't-switch-track', 'aria-hidden': 'true' }), el('span', {}, T('sos_include_location'))),
    err, send);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sosDraft.type) {
      err.hidden = false;
      err.textContent = T('sos_choose_type');
      grid.querySelector('button').focus();
      return;
    }
    const label = T(SOS_TYPES.find((x) => x[0] === sosDraft.type)[2]);
    if (!(await confirmDialog({ title: T('sos_confirm_title'), body: T('sos_confirm_body', label), confirmLabel: T('sos_send'), tone: 'urgent' }))) return;
    await busy(send, async () => {
      const pos = sosDraft.withLoc ? await getPosition() : null;
      try {
        const r = await tApi.post('/api/tourist/sos', { type: sosDraft.type, description: sosDraft.details.trim() || undefined, lat: pos?.lat, lng: pos?.lng });
        Object.assign(sosDraft, { type: null, details: '', withLoc: true });
        toast(r.duplicate ? T('sos_already') : T('sos_sent'));
        await loadMe();
        sos();
        window.scrollTo({ top: 0 });
        main.querySelector('h1')?.focus({ preventScroll: true });
      } catch (e2) {
        err.hidden = false;
        clear(err, e2 instanceof ApiError && e2.status > 0 ? e2.message : T('sos_unconfirmed'), ' ', el('a', { href: `tel:${me.emergencyLine}`, class: 'strong' }, `${T('call')} ${me.emergencyLine}`));
      }
    });
  });
  return form;
}

/** Live progress of an SOS: received → ranger responding → resolved. */
function sosTracker(s, opts = {}) {
  const step = s.status === 'open' ? 0 : s.status === 'acknowledged' ? 1 : 2;
  const open = step < 2;
  const times = [s.opened_at, s.acknowledged_at, s.closed_at];
  const labels = [T('st_received'), step >= 1 && s.ranger_name ? T('st_ranger', s.ranger_name) : T('st_responding'), T('st_resolved')];
  const title = step === 0 ? T('st_waiting') : step === 1 ? T('help_on_way') : T('st_resolved_by', s.ranger_name || 'Ranger');
  return el('section', { class: `t-tracker ${open ? 'is-open' : 'is-done'}${opts.compact ? ' is-compact' : ''}`, 'aria-live': 'polite', 'aria-labelledby': `t-tr-${s.id}` },
    el('div', { class: 't-tracker-head' }, el('span', { class: 't-tracker-icon' }, icon(open ? 'siren' : 'check-circle')),
      el('div', {}, el('p', { class: 't-kicker' }, `${s.ref} · ${T(`t_${s.emergency_type}`)}`), el('h2', { id: `t-tr-${s.id}` }, title))),
    el('ol', { class: 't-progress', 'aria-label': T('sos_status') }, labels.map((l, i) =>
      el('li', { class: i < step || step === 2 ? 'is-done' : i === step ? 'is-current' : '', 'aria-current': i === step ? 'step' : null },
        el('span', { class: 't-dot' }, i < step || step === 2 ? icon('check', 'icon icon-sm') : null),
        el('span', { class: 't-progress-label' }, l, times[i] && (i <= step) ? el('small', {}, tAge(times[i])) : null)))),
    open ? el('p', { class: 't-tracker-hint' }, T('status_open_hint')) : null,
    opts.compact
      ? el('a', { href: '#/sos', class: 't-tracker-link' }, T('sos_status'), icon('chevron-right', 'icon icon-sm'))
      : open ? el('a', { href: `tel:${me.emergencyLine}`, class: 't-call-btn' }, icon('phone'), `${T('call')} ${me.emergencyLine}`) : null);
}

function callCard() {
  const line = me.emergencyLine;
  return el('a', { class: 't-call-card', href: `tel:${line}` }, el('span', { class: 't-qa-icon' }, icon('phone')),
    el('span', { class: 't-qa-text' }, el('small', {}, T('or_call')), el('strong', {}, line)), icon('chevron-right', 'icon icon-sm'));
}

function requestHistory(current) {
  const list = me.feed.sos.filter((s) => s !== current);
  const label = (s) => (s.status === 'open' ? T('st_received') : s.status === 'acknowledged' ? T('st_responding') : T('st_resolved'));
  return el('section', { class: 't-panel' }, el('h3', { class: 't-panel-title' }, T('my_requests')),
    list.length
      ? el('ul', { class: 't-history' }, list.map((s) => el('li', {},
          el('span', { class: 't-history-icon' }, icon(SOS_TYPES.find((x) => x[0] === s.emergency_type)?.[1] || 'siren')),
          el('span', { class: 't-history-text' }, el('strong', {}, T(`t_${s.emergency_type}`)), el('small', {}, `${s.ref} · ${tAge(s.opened_at)}`)),
          el('span', { class: `t-pill${isOpen(s) ? ' is-open' : ''}` }, label(s)))))
      : el('p', { class: 't-muted' }, T('no_requests')));
}

// ---------------------------------------------------------------- night escort and going out
const fmtClock = (iso) => new Date(iso).toLocaleTimeString(LOCALE[lang] || 'en-GB', { hour: '2-digit', minute: '2-digit' });
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Status cards for an open escort request and an activity check-in (shown on Home). */
function planCards() {
  const e = me.feed.escort;
  const a = me.feed.activity;
  const cards = [];
  if (e) {
    const tone = e.status === 'requested' ? 'is-wait' : e.status === 'accepted' ? 'is-go' : 'is-done';
    cards.push(el('a', { class: `t-plan ${tone}`, href: '#/escort' }, el('span', { class: 't-plan-icon' }, icon(e.status === 'done' ? 'check-circle' : 'person')),
      el('span', { class: 't-plan-text' },
        el('strong', {}, e.status === 'requested' ? T('escort_waiting') : e.status === 'accepted' ? T('escort_coming', e.escort_name) : T('escort_done')),
        el('small', {}, `${e.from_place} → ${escortDest(e)}`)),
      icon('chevron-right', 'icon icon-sm')));
  }
  if (a && a.status !== 'returned') {
    const tone = a.status === 'overdue' ? 'is-late' : a.status === 'planned' ? 'is-wait' : 'is-go';
    cards.push(el('a', { class: `t-plan ${tone}`, href: '#/out' }, el('span', { class: 't-plan-icon' }, icon(a.status === 'overdue' ? 'clock' : 'map')),
      el('span', { class: 't-plan-text' },
        el('strong', {}, a.status === 'overdue' ? T('out_overdue') : T(a.status === 'planned' ? 'out_planned' : 'out_active', `${T(`act_${a.kind}`)} · ${a.zone_name}`)),
        el('small', {}, T('out_until', fmtClock(a.ends_at)))),
      icon('chevron-right', 'icon icon-sm')));
  }
  const g = me.feed.tourGroup;
  if (g) {
    const tone = g.state === 'overdue' ? 'is-late' : g.state === 'in_park' ? 'is-go' : g.state === 'back' ? 'is-done' : 'is-wait';
    cards.push(el('a', { class: `t-plan ${tone}`, href: '#/tour' }, el('span', { class: 't-plan-icon' }, icon('users')),
      el('span', { class: 't-plan-text' }, el('strong', {}, T('tour_with', g.operator_name)), el('small', {}, tourStatus(g))),
      icon('chevron-right', 'icon icon-sm')));
  }
  return cards.length ? el('div', { class: 't-plans' }, cards) : null;
}

/** One line on where the traveller's tour group is. */
function tourStatus(g) {
  if (g.state === 'in_park') return `${T('tour_in_park', g.place)} · ${T('tour_out_by', fmtClock(g.ends_at))}`;
  if (g.state === 'overdue') return `${T('tour_overdue')} · ${g.place}`;
  if (g.state === 'back') return T('tour_back');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: BOOT.timeZone || undefined });
  const day = g.day === today ? T('tour_today') : new Date(`${g.day}T12:00:00Z`).toLocaleDateString(LOCALE[lang] || 'en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${T('tour_planned', day)} · ${T(`act_${g.kind}`)}`;
}

/** A tour operator's group the traveller is in: guide, status, what the operator can see, and leaving. */
function tour() {
  const g = me.feed.tourGroup;
  const head = pageHead(T('tour_title'), g ? g.name : '');
  if (!g) {
    page(T('tour_title'), head, emptyCard('users', T('tour_title'), T('tour_none')));
    return;
  }
  const leave = el('button', { type: 'button', class: 'btn btn-block' }, el('span', {}, T('tour_leave')));
  leave.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: T('tour_leave'), body: T('tour_leave_confirm', g.operator_name), confirmLabel: T('tour_leave') }))) return;
    await busy(leave, async () => {
      await tApi.post(`/api/tourist/tour-groups/${g.id}/leave`, {});
      toast(T('tour_left'));
      await loadMe();
      go('home');
    });
  });
  const tone = g.state === 'overdue' ? 'is-late' : g.state === 'in_park' ? 'is-go' : g.state === 'back' ? 'is-done' : 'is-wait';
  page(T('tour_title'), head,
    el('section', { class: `t-panel t-tour ${tone}` },
      el('p', { class: 't-kicker' }, T('tour_with', g.operator_name)),
      el('h2', {}, tourStatus(g)),
      g.guide_name
        ? el('div', { class: 't-tour-guide' }, el('span', { class: 't-plan-icon' }, icon('person')),
            el('div', { class: 'grow' }, el('small', {}, T('tour_guide')), el('strong', {}, g.guide_name)),
            g.guide_phone ? el('a', { class: 'btn', href: `tel:${g.guide_phone}` }, icon('phone'), el('span', {}, T('tour_call_guide'))) : null)
        : null),
    el('section', { class: 't-panel t-note' }, icon('shield', 'icon'), el('p', {}, T('tour_privacy', g.operator_name))),
    g.state === 'back' ? null : leave);
  pollMe(10000, tour);
}

/** "Today in the park": species seen today in the area, a while after, with no places. */
function todayCard() {
  const d = me.feed.today;
  if (!d) return null;
  const area = me.feed.area?.name || '';
  return el('section', { class: 't-panel t-today', 'aria-labelledby': 't-today-title' },
    el('div', { class: 't-today-head' }, el('span', { class: 't-today-icon' }, icon('paw')),
      el('div', {}, el('h2', { id: 't-today-title' }, T('today_title')), el('p', { class: 't-muted' }, T('today_sub', area)))),
    d.species.length
      ? el('ul', { class: 't-today-list' }, d.species.map((sp) => el('li', {},
          el('strong', {}, sp.names?.[lang] || sp.names?.en || sp.key),
          el('span', {}, `${T('today_seen', sp.count)} · ${T(`today_${sp.when}`)}`))))
      : el('p', { class: 't-muted' }, T('today_empty')),
    el('p', { class: 't-today-foot' }, icon('shield', 'icon icon-sm'), el('span', {}, T('today_protected'), d.simulated ? ` ${T('today_sim')}` : '')));
}
const escortDest = (e) => (e.to_key === 'other' ? e.to_text : T(`to_${e.to_key}`));

function escort() {
  const t = me.tourist;
  const e = me.feed.escort;
  const head = pageHead(T('escort_title'), T('escort_sub'));
  if (!t.lodge_id) {
    page(T('escort_title'), head, emptyCard('home', T('escort_title'), T('escort_need_lodge')));
    return;
  }
  if (e && e.status !== 'done') {
    const cancel = el('button', { type: 'button', class: 'btn btn-block' }, el('span', {}, T('escort_cancel')));
    cancel.addEventListener('click', () => busy(cancel, async () => {
      await tApi.post(`/api/tourist/escort/${e.id}/cancel`, {});
      await loadMe();
      escort();
    }));
    const coming = e.status === 'accepted';
    page(T('escort_title'), head,
      el('section', { class: `t-tracker ${coming ? 'is-done' : 'is-open'}`, 'aria-live': 'polite' },
        el('div', { class: 't-tracker-head' }, el('span', { class: 't-tracker-icon' }, icon('person')),
          el('div', {}, el('p', { class: 't-kicker' }, `${e.from_place} → ${escortDest(e)}`), el('h2', {}, coming ? T('escort_coming', e.escort_name) : T('escort_waiting')))),
        el('p', { class: 't-tracker-hint' }, T(coming ? 'escort_coming_sub' : 'escort_waiting_sub'))),
      cancel, emergencyLink());
    pollMe(5000, escort);
    return;
  }
  const from = el('input', { id: 'e-from', maxlength: '60', placeholder: T('escort_from_ph'), value: readPref('ss-escort-from') || '' });
  const other = el('input', { id: 'e-other', maxlength: '60' });
  const otherField = field('e-other', T('escort_to_other'), other);
  const dest = pickChips('e-to', ['dining', 'reception', 'bar', 'room', 'other'].map((k) => [k, T(`to_${k}`)]), 'dining', (v) => { otherField.hidden = v !== 'other'; });
  otherField.hidden = true;
  const peopleIn = el('input', { id: 'e-people', type: 'number', min: '1', max: '60', inputmode: 'numeric', value: String(t.group_size) });
  const note = el('input', { id: 'e-note', maxlength: '200' });
  const err = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const send = el('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, icon('person'), el('span', {}, T('escort_send')));
  const form = el('form', { class: 't-panel t-form', novalidate: true },
    field('e-from', T('escort_from'), from),
    el('div', { class: 'field' }, el('span', { class: 'label', id: 'e-to-label' }, T('escort_to')), dest.node), otherField,
    el('div', { class: 't-form-grid' }, field('e-people', T('escort_people'), peopleIn), field('e-note', T('escort_note'), note)),
    err, send);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    err.hidden = true;
    if (!from.value.trim()) { err.hidden = false; err.textContent = T('err_required'); from.focus(); return; }
    if (dest.value() === 'other' && !other.value.trim()) { err.hidden = false; err.textContent = T('err_required'); other.focus(); return; }
    busy(send, async () => {
      try {
        await tApi.post('/api/tourist/escort', { from_place: from.value.trim(), to_key: dest.value(), to_text: other.value.trim() || null, people: Number(peopleIn.value || 1), note: note.value.trim() || null });
        writePref('ss-escort-from', from.value.trim());
        toast(T('escort_sent'));
        await loadMe();
        escort();
      } catch (e2) {
        err.hidden = false;
        err.textContent = e2.message;
      }
    });
  });
  page(T('escort_title'), head, form, emergencyLink());
}

async function out() {
  const a = me.feed.activity;
  const head = pageHead(T('out_title'), T('out_sub'));
  if (a && a.status !== 'returned') {
    const done = el('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block' }, icon('check-circle'), el('span', {}, a.status === 'planned' ? T('out_cancel') : T('out_im_back')));
    done.addEventListener('click', () => busy(done, async () => {
      await tApi.post(`/api/tourist/activities/${a.id}/${a.status === 'planned' ? 'cancel' : 'back'}`, {});
      if (a.status !== 'planned') toast(T('out_back_thanks'));
      await loadMe();
      out();
    }));
    const late = a.status === 'overdue';
    page(T('out_title'), head,
      el('section', { class: `t-tracker ${late ? 'is-open' : 'is-done'}`, 'aria-live': 'polite' },
        el('div', { class: 't-tracker-head' }, el('span', { class: 't-tracker-icon' }, icon(late ? 'clock' : 'map')),
          el('div', {}, el('p', { class: 't-kicker' }, `${T(`act_${a.kind}`)} · ${a.zone_name}`),
            el('h2', {}, late ? T('out_overdue') : T(a.status === 'planned' ? 'out_planned' : 'out_active', a.zone_name)))),
        el('p', { class: 't-tracker-hint' }, late ? T('out_overdue_sub') : T('out_until', fmtClock(a.ends_at)))),
      done, emergencyLink());
    pollMe(15000, out);
    return;
  }
  const places = (await api.get('/api/tourist/places').catch(() => ({ places: [] }))).places;
  if (currentRoute() !== 'out') return;
  if (!places.length) {
    page(T('out_title'), head, emptyCard('map', T('out_title'), T('out_no_places')));
    return;
  }
  const kind = pickChips('o-kind', ['game_drive', 'walking_safari', 'picnic', 'sundowner', 'other'].map((k) => [k, T(`act_${k}`)]), 'game_drive');
  const where = el('select', { id: 'o-where' }, places.map((p) => el('option', { value: String(p.id) }, p.name)));
  const later = el('input', { id: 'o-start', type: 'datetime-local', value: localInput(new Date(Date.now() + 3_600_000)) });
  const laterField = field('o-start', T('out_when'), later);
  laterField.hidden = true;
  const when = pickChips('o-when', [['now', T('out_now')], ['later', T('out_later')]], 'now', (v) => { laterField.hidden = v !== 'later'; });
  const back = el('input', { id: 'o-back', type: 'datetime-local', value: localInput(new Date(Math.ceil((Date.now() + 3 * 3_600_000) / 900_000) * 900_000)) });
  const peopleIn = el('input', { id: 'o-people', type: 'number', min: '1', max: '60', inputmode: 'numeric', value: String(me.tourist.group_size) });
  const err = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const send = el('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, icon('map'), el('span', {}, T('out_send')));
  const form = el('form', { class: 't-panel t-form', novalidate: true },
    el('div', { class: 'field' }, el('span', { class: 'label' }, T('out_what')), kind.node),
    field('o-where', T('out_where'), where),
    el('div', { class: 'field' }, el('span', { class: 'label' }, T('out_when')), when.node), laterField,
    el('div', { class: 't-form-grid' }, field('o-back', T('out_back'), back), field('o-people', T('out_people'), peopleIn)),
    err, send);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const startsAt = when.value() === 'later' ? new Date(later.value) : new Date();
    const endsAt = new Date(back.value);
    if (!back.value || !(endsAt > startsAt)) { err.hidden = false; err.textContent = T('err_back_time'); back.focus(); return; }
    busy(send, async () => {
      try {
        await tApi.post('/api/tourist/activities', {
          kind: kind.value(), zone_id: Number(where.value), people: Number(peopleIn.value || 1),
          starts_at: when.value() === 'later' ? startsAt.toISOString() : undefined, ends_at: endsAt.toISOString(),
        });
        toast(T('out_sent'));
        await loadMe();
        go('home');
      } catch (e2) {
        err.hidden = false;
        err.textContent = e2.message;
      }
    });
  });
  page(T('out_title'), head, form, emergencyLink());
}

/** Single-choice chips (radio buttons styled as pills). */
function pickChips(name, options, initial, onChange) {
  const node = el('div', { class: 't-pick', role: 'radiogroup' }, options.map(([v, l]) => {
    const input = el('input', { type: 'radio', name, value: v, checked: v === initial });
    input.addEventListener('change', () => onChange?.(v));
    return el('label', { class: 't-pick-chip' }, input, el('span', {}, l));
  }));
  return { node, value: () => node.querySelector('input:checked')?.value };
}
function readPref(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function writePref(k, v) {
  try { localStorage.setItem(k, v); } catch { /* optional */ }
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

function guide() {
  page(T('guide_title'),
    pageHead(T('guide_title'), T('guide_sub')),
    el('div', { class: 't-guide-grid' }, (GUIDE[lang] || GUIDE.en).map(([ic, title, items], i) => el('details', { class: 't-guide', open: i === 0 ? true : null },
      el('summary', {}, el('span', { class: 't-guide-icon' }, icon(ic)), el('span', { class: 't-guide-name' }, title), icon('chevron-down', 'icon icon-sm t-caret')),
      el('ul', {}, items.map((x) => el('li', {}, x)))))),
    el('section', { class: 't-panel t-phrases' }, el('h3', { class: 't-panel-title' }, icon('globe', 'icon icon-sm'), T('phrases_title')),
      el('dl', {}, PHRASES.map(([en, sw], i) => el('div', {}, el('dt', {}, sw), el('dd', {}, PHRASE_MEANINGS[lang]?.[i] || en))))),
    emergencyLink());
}

async function trip() {
  if (!areas.length) areas = (await api.get('/api/public/areas').catch(() => ({ areas: [] }))).areas;
  const t = me.tourist;
  const f = {
    area_id: el('select', { id: 'p-area' }, areas.map((a) => el('option', { value: a.id }, a.name))),
    lodge: el('input', { id: 'p-lodge', value: t.lodge || '' }),
    trip_start: el('input', { id: 'p-start', type: 'date', value: t.trip_start }),
    trip_end: el('input', { id: 'p-end', type: 'date', value: t.trip_end }),
    group_size: el('input', { id: 'p-group', type: 'number', min: '1', max: '60', inputmode: 'numeric', value: String(t.group_size) }),
    emergency_contact: el('input', { id: 'p-ec', value: t.emergency_contact || '' }),
    sms_alerts: el('input', { id: 'p-sms', type: 'checkbox', checked: t.sms_alerts }),
  };
  f.area_id.value = t.area_id;
  const err = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const save = el('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, el('span', {}, T('save')));
  const form = el('form', { class: 't-panel t-form', novalidate: true },
    el('h3', { class: 't-panel-title' }, icon('map', 'icon icon-sm'), T('trip_details')), err,
    field('p-area', T('destination'), f.area_id), field('p-lodge', T('lodge'), f.lodge),
    el('div', { class: 't-form-grid' }, field('p-start', T('trip_start'), f.trip_start), field('p-end', T('trip_end'), f.trip_end)),
    field('p-group', T('group'), f.group_size), field('p-ec', T('emergency_contact'), f.emergency_contact),
    el('label', { class: 't-switch' }, f.sms_alerts, el('span', { class: 't-switch-track', 'aria-hidden': 'true' }), el('span', {}, T('sms_alerts'))), save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (f.trip_end.value < f.trip_start.value) {
      err.hidden = false;
      err.textContent = T('err_dates');
      f.trip_end.focus();
      return;
    }
    await busy(save, async () => {
      try {
        await api.patch('/api/tourist/me', { area_id: f.area_id.value, lodge: f.lodge.value || null, trip_start: f.trip_start.value, trip_end: f.trip_end.value,
          group_size: Number(f.group_size.value || 1), emergency_contact: f.emergency_contact.value || null, sms_alerts: f.sms_alerts.checked });
        await loadMe();
        toast(T('saved'));
        err.hidden = true;
      } catch (e2) {
        err.hidden = false;
        err.textContent = e2.message;
      }
    });
  });
  const out = el('button', { type: 'button', class: 'btn btn-block' }, icon('logout'), el('span', {}, T('sign_out')));
  out.addEventListener('click', async () => {
    await tApi.post('/api/tourist/logout');
    me = null;
    go('welcome');
  });
  const initials = t.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  page(T('trip_title'),
    pageHead(T('trip_title')),
    el('div', { class: 't-trip-layout' }, form,
      el('aside', { class: 't-col' },
        el('section', { class: 't-panel t-account' }, el('h3', { class: 't-panel-title' }, icon('user', 'icon icon-sm'), T('account')),
          el('div', { class: 't-account-id' }, el('span', { class: 't-avatar', 'aria-hidden': 'true' }, initials),
            el('div', {}, el('strong', {}, t.name), el('small', {}, t.phone))),
          el('dl', { class: 't-facts' },
            el('div', {}, el('dt', {}, T('language')), el('dd', {}, LANGUAGES.find(([c]) => c === lang)?.[1] || 'English')),
            el('div', {}, el('dt', {}, T('alerts_by_sms')), el('dd', {}, t.sms_alerts ? T('on') : T('off')))),
          out),
        emergencyLink())));
}

function emergencyLink() {
  const line = me?.emergencyLine || BOOT.emergencyLine;
  return el('a', { class: 'emergency-line', href: `tel:${line}` }, icon('phone'), `${T('emergency_line')}: ${line}`);
}

async function busy(btn, fn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  const original = [...btn.childNodes];
  btn.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', {}, T('working')));
  try {
    await fn();
  } finally {
    if (btn.isConnected) {
      btn.replaceChildren(...original);
      btn.disabled = false;
    }
    delete btn.dataset.busy;
  }
}

/** Refresh the feed in the background and re-render the current view when something changed. */
function pollMe(ms, view) {
  clearInterval(timer);
  let last = JSON.stringify(me?.feed);
  timer = setInterval(async () => {
    if (document.hidden || main.querySelector('[data-busy]') || main.contains(document.activeElement) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
    await loadMe();
    if (!me) return go('welcome');
    const now = JSON.stringify(me.feed);
    if (now !== last) {
      last = now;
      renderNav();
      view();
    }
  }, ms);
}

loadMe().then(route);
