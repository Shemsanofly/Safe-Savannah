// Safe Savannah traveller app (mobile-first, English / Kiswahili).
import { ApiError, api, BOOT, clear, confirmDialog, el, icon, setServerTime, toast } from '../lib.js';
import { GUIDE, PHRASES, STRINGS } from './i18n.js';

const main = document.getElementById('t-main');
const nav = document.getElementById('t-nav');
const banner = document.getElementById('conn-banner');
let lang = readLang();
let me = null; // { tourist, feed, emergencyLine, smsMode }
let areas = [];
let timer = null;
let failures = 0;
let registrationStep = 1;
const authDraft = { login: {}, register: {} };

const T = (k, ...a) => {
  const v = STRINGS[lang][k] ?? STRINGS.en[k] ?? k;
  return typeof v === 'function' ? v(...a) : v;
};
function readLang() {
  try {
    return localStorage.getItem('ss-lang') === 'sw' ? 'sw' : 'en';
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
  document.documentElement.lang = l;
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === l)));
  if (me) api.patch('/api/tourist/me', { language: l }).catch(() => undefined); // SMS also switch language
  route();
}
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
document.documentElement.lang = lang;
document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));

const tAge = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return lang === 'sw' ? 'sasa hivi' : 'just now';
  if (s < 3600) return lang === 'sw' ? `dakika ${Math.floor(s / 60)} zilizopita` : `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return lang === 'sw' ? `saa ${Math.floor(s / 3600)} zilizopita` : `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(lang === 'sw' ? 'sw-TZ' : 'en-GB', { day: 'numeric', month: 'short' });
};
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(lang === 'sw' ? 'sw-TZ' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

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
    setServerTime(me.serverTime);
    if (me.tourist.language !== lang && !sessionStorageGet('ss-lang-chosen')) setLangSilently(me.tourist.language);
    failures = 0;
    banner.hidden = true;
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      me = null;
      return null;
    }
    failures += 1;
    if (failures >= 2) {
      banner.hidden = false;
      clear(banner, icon('wifi-off'), el('span', {}, T('offline'), ' ', el('a', { href: `tel:${BOOT.emergencyLine}`, class: 'strong' }, `${T('call')} ${BOOT.emergencyLine}`)));
    }
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
  document.documentElement.lang = l;
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === l)));
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
  clear(main, el('h1', { class: 'sr-only', tabindex: '-1' }, title), ...children);
  document.title = `${title} · Safe Savannah`;
}

async function route() {
  clearInterval(timer);
  const r = currentRoute();
  const needsAuth = ['home', 'alerts', 'sos', 'trip'].includes(r);
  // Always fetch fresh data when entering a signed-in screen (status may have changed meanwhile).
  if (needsAuth) await loadMe();
  if (needsAuth && !me) return go('welcome');
  if (!needsAuth && (r === 'welcome' || r === 'login' || r === 'register') && me) return go('home');
  renderNav();
  const isAuth = !me && ['welcome', 'login', 'register'].includes(r);
  document.body.classList.toggle('t-auth-page', isAuth);
  nav.hidden = isAuth;
  const views = { welcome, login, register, home, alerts, sos, guide, trip };
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
        go('home');
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
  const tripFields = el('fieldset', { class: 't-auth-fields' }, el('legend', { class: 'sr-only' }, T('your_trip')),
    areaError, field('r-area', T('destination'), f.area_id), field('r-lodge', T('lodge'), f.lodge),
    el('div', { class: 't-form-grid' }, field('r-start', T('trip_start'), f.trip_start), field('r-end', T('trip_end'), f.trip_end)),
    field('r-group', T('group'), f.group_size),
    el('details', { class: 't-auth-optional' }, el('summary', {}, icon('plus'), T('optional_details')),
      field('r-nat', T('nationality'), f.nationality), field('r-ec', T('emergency_contact'), f.emergency_contact)),
    el('label', { class: 't-sms-choice' }, f.sms_alerts, el('span', {}, T('sms_alerts'))),
    el('p', { class: 't-privacy-note' }, icon('shield'), T('consent')));
  const back = el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { showStep(1); heading.focus(); } }, icon('chevron-left'), T('back'));
  const form = el('form', { class: 't-auth-form', novalidate: true },
    el('div', { class: 't-auth-heading' }, heading, intro),
    steps, err, account, tripFields, el('div', { class: 't-auth-actions' }, back, btn));
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
        });
        authDraft.register = {};
        authDraft.login = {};
        registrationStep = 1;
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
const LEVEL_ICON = { danger: 'siren', warning: 'alert', advisory: 'info' };
const SOS_TYPES = [['medical', 'heart', 't_medical'], ['wildlife', 'paw', 't_wildlife'], ['vehicle', 'car', 't_vehicle'], ['personal', 'shield', 't_personal']];
const sosDraft = { type: null, details: '', withLoc: true }; // survives background refreshes
const localized = (a, k) => (lang === 'sw' ? a[`${k}_sw`] : a[`${k}_en`]) || '';
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
  page(`${T('hello')}, ${firstName()}`,
    openSos ? sosTracker(openSos, { compact: true }) : null,
    el('div', { class: 't-home' },
      el('div', { class: 't-col' }, tripCard(), safetyStatus(active, feed.activeWildlifeIncidents)),
      el('div', { class: 't-col' }, openSos ? null : sosCallout(), quickActions())));
  pollMe(openSos ? 5000 : 15000, home);
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

/** One clear safety state: a real warning for the tourist, rangers monitoring, or all clear. */
function safetyStatus(active, monitoring) {
  if (active.length) {
    const sev = active.some((a) => a.level === 'danger') ? 'danger' : 'warning';
    const lead = active.find((a) => a.level === sev) || active[0];
    const steps = (lang === 'sw' ? lead.actions_sw : lead.actions_en) || [];
    return el('section', { class: `t-safety is-${sev}`, role: 'status', 'aria-labelledby': 't-safety-title' },
      el('div', { class: 't-safety-head' }, el('span', { class: 't-safety-icon' }, icon(sev === 'danger' ? 'siren' : 'alert')),
        el('div', {}, el('p', { class: 't-kicker' }, T(sev === 'danger' ? 'status_danger' : 'status_warning')), el('h2', { id: 't-safety-title' }, localized(lead, 'title')))),
      steps.length ? el('ul', { class: 't-checklist', 'aria-label': T('what_to_do') }, steps.slice(0, 3).map((x) => el('li', {}, icon('check', 'icon icon-sm'), el('span', {}, x)))) : null,
      el('a', { href: '#/alerts', class: 't-safety-link' }, el('span', {}, T('see_all_alerts')),
        active.length > 1 ? el('span', { class: 't-count' }, T('more_alerts', active.length - 1)) : null, icon('chevron-right', 'icon icon-sm')));
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
  return el('section', { class: 't-quick', 'aria-labelledby': 't-qa-title' },
    el('h3', { id: 't-qa-title', class: 't-section-title' }, T('quick_actions')),
    el('div', { class: 't-qa-grid' }, share,
      el('a', { class: 't-qa', href: `tel:${line}` }, el('span', { class: 't-qa-icon' }, icon('phone')), el('span', { class: 't-qa-text' }, el('strong', {}, `${T('call_short')} ${line}`), el('small', {}, T('emergency_line')))),
      el('a', { class: 't-qa', href: '#/guide' }, el('span', { class: 't-qa-icon' }, icon('book')), el('span', { class: 't-qa-text' }, el('strong', {}, T('tips_short')), el('small', {}, T('tips_sub'))))));
}

function alerts() {
  const list = me.feed.alerts;
  const now = list.filter((a) => a.active);
  const earlier = list.filter((a) => !a.active);
  page(T('alerts_title'),
    pageHead(T('alerts_title'), T('alerts_sub')),
    list.length ? null : emptyCard('check-circle', T('alerts_empty'), T('no_alerts_body')),
    now.length ? el('section', { class: 't-section' }, el('h3', { class: 't-section-title' }, T('now_section')), el('div', { class: 't-alert-list' }, now.map((a) => alertCard(a)))) : null,
    earlier.length ? el('section', { class: 't-section' }, el('h3', { class: 't-section-title' }, T('earlier_section')), el('div', { class: 't-alert-list' }, earlier.map((a) => alertCard(a, true)))) : null);
  pollMe(15000, alerts);
}

function alertCard(a, past = false) {
  const lvl = LEVEL_ICON[a.level] ? a.level : 'advisory';
  const steps = (lang === 'sw' ? a.actions_sw : a.actions_en) || [];
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
        clear(err, e2.message, ' ', el('a', { href: `tel:${me.emergencyLine}`, class: 'strong' }, `${T('call')} ${me.emergencyLine}`));
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

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

function guide() {
  page(T('guide_title'),
    pageHead(T('guide_title'), T('guide_sub')),
    el('div', { class: 't-guide-grid' }, GUIDE[lang].map(([ic, title, items], i) => el('details', { class: 't-guide', open: i === 0 ? true : null },
      el('summary', {}, el('span', { class: 't-guide-icon' }, icon(ic)), el('span', { class: 't-guide-name' }, title), icon('chevron-down', 'icon icon-sm t-caret')),
      el('ul', {}, items.map((x) => el('li', {}, x)))))),
    el('section', { class: 't-panel t-phrases' }, el('h3', { class: 't-panel-title' }, icon('globe', 'icon icon-sm'), T('phrases_title')),
      el('dl', {}, PHRASES.map(([en, sw]) => el('div', {}, el('dt', {}, sw), el('dd', {}, en))))),
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
            el('div', {}, el('dt', {}, T('language')), el('dd', {}, lang === 'sw' ? 'Kiswahili' : 'English')),
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
