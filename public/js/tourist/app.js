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
      icon(ic), el('span', {}, T(key), route === 'alerts' && unread ? ` (${unread})` : '')))));
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
          el('h2', { id: 't-story-title' }, T('auth_headline'), el('em', {}, T('auth_headline_accent'))),
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
          el('span', {}, icon('globe'), 'English / Kiswahili')),
        emergencyLink())),
    el('p', { class: 't-auth-footer' }, icon('shield'), T('auth_footer')));
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
    el('div', { class: 't-auth-heading' }, el('span', { class: 't-auth-emblem' }, icon('login')),
      el('h2', {}, T('welcome_back')), el('p', {}, T('login_intro'))),
    err, field('l-phone', T('phone'), phone, T('login_phone_hint')), field('l-pin', T('pin_login'), pinControl(pin)), btn,
    el('p', { class: 't-auth-alternate' }, T('new_here'), ' ', el('a', { href: '#/register' }, T('create_account'))),
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
    el('div', { class: 't-auth-heading' }, el('span', { class: 't-auth-emblem' }, icon('user')), heading, intro),
    steps, err, account, tripFields, el('div', { class: 't-auth-actions' }, back, btn),
    el('p', { class: 't-auth-alternate' }, T('have_account'), ' ', el('a', { href: '#/login' }, T('sign_in'))));
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

function home() {
  const t = me.tourist;
  const feed = me.feed;
  const activeAlerts = feed.alerts.filter((a) => a.active);
  const danger = activeAlerts.some((a) => a.level === 'danger' || a.level === 'warning');
  const openSos = feed.sos.find((s) => s.status === 'open' || s.status === 'acknowledged');
  page(`${T('hello')}, ${t.name.split(' ')[0]}`,
    el('section', { class: 't-hero' },
      el('h2', { class: 'strong' }, `${T('hello')}, ${t.name.split(' ')[0]}`),
      el('p', {}, icon('pin', 'icon icon-sm'), ' ', [t.lodge, feed.area?.name].filter(Boolean).join(' · ')),
      el('p', { class: 'small' }, `${fmtDay(t.trip_start)} – ${fmtDay(t.trip_end)} · ${T('group_of')} ${t.group_size}`)),
    openSos ? sosStatusCard(openSos) : null,
    activeAlerts.length || feed.activeWildlifeIncidents
      ? el('div', { class: `t-status ${danger ? 'danger' : 'warn'}`, role: 'status' }, icon('incident', 'icon icon-lg'),
          el('div', { class: 'stack' }, el('strong', {}, T('active_alerts', Math.max(activeAlerts.length, feed.activeWildlifeIncidents))),
            activeAlerts[0] ? el('span', {}, alertTitle(activeAlerts[0])) : null, el('a', { href: '#/alerts', class: 'strong' }, T('see_alerts'))))
      : el('div', { class: 't-status ok', role: 'status' }, icon('check-circle', 'icon icon-lg'), el('div', {}, el('strong', {}, T('no_alerts_title')), el('p', { class: 'small' }, T('no_alerts_body')))),
    el('a', { href: '#/sos', class: 'sos-big' }, icon('siren'), T('sos_button'), el('small', {}, T('sos_sub'))),
    locationCard(),
    emergencyLink());
  pollMe(15000, home);
}

function alertTitle(a) {
  return lang === 'sw' ? a.title_sw : a.title_en;
}

function alerts() {
  const list = me.feed.alerts;
  page(T('alerts_title'),
    el('div', { class: 'page-head' }, el('div', {}, el('h2', {}, T('alerts_title')), el('p', { class: 'sub' }, T('alerts_sub')))),
    list.length
      ? el('div', { class: 'stack' }, list.map((a) => el('article', { class: `alert-card lv-${a.level} ${a.active ? '' : 'is-past'}` },
          el('div', { class: 'row' }, el('span', { class: `badge ${a.active ? 'tone-urgent' : 'tone-muted'}` }, a.active ? T('active') : T('earlier')),
            /simulated|jaribio/i.test(a.title_en + a.title_sw) ? el('span', { class: 'badge tone-sim' }, T('simulated_note')) : null,
            a.demo ? el('span', { class: 'badge tone-demo' }, T('demo_note')) : null,
            el('span', { class: 'small muted' }, tAge(a.created_at))),
          el('h3', {}, alertTitle(a)),
          el('p', {}, lang === 'sw' ? a.body_sw : a.body_en),
          el('div', {}, el('strong', { class: 'small' }, T('what_to_do')), el('ol', {}, (lang === 'sw' ? a.actions_sw : a.actions_en).map((x) => el('li', {}, x)))))))
      : el('div', { class: 't-card' }, el('div', { class: 'empty' }, icon('check-circle'), el('strong', {}, T('alerts_empty')), el('p', {}, T('no_alerts_body')))));
  pollMe(15000, alerts);
}

function sos() {
  let type = null;
  const openSos = me.feed.sos.find((s) => s.status === 'open' || s.status === 'acknowledged');
  const types = [['medical', 'heart', 't_medical'], ['wildlife', 'paw', 't_wildlife'], ['vehicle', 'car', 't_vehicle'], ['personal', 'shield', 't_personal']];
  const grid = el('div', { class: 'type-grid', role: 'group', 'aria-label': T('sos_which') }, types.map(([v, ic, key]) => {
    const b = el('button', { type: 'button', class: 'type-btn', 'aria-pressed': 'false' }, icon(ic), T(key));
    b.addEventListener('click', () => {
      type = v;
      grid.querySelectorAll('.type-btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      err.hidden = true;
    });
    return b;
  }));
  const details = el('textarea', { id: 's-details', maxlength: '500', placeholder: T('sos_details_ph') });
  const withLoc = el('input', { type: 'checkbox', checked: true, id: 's-loc' });
  const err = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const send = el('button', { type: 'submit', class: 'sos-big' }, icon('siren'), el('span', {}, T('sos_send')));
  const form = el('form', { class: 't-card', novalidate: true }, el('h2', {}, T('sos_which')), grid,
    field('s-details', T('sos_details'), details), el('label', { class: 'duty-toggle' }, withLoc, el('span', {}, T('sos_include_location'))), err, send);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!type) {
      err.hidden = false;
      err.textContent = T('sos_choose_type');
      grid.querySelector('button').focus();
      return;
    }
    const label = T(types.find((x) => x[0] === type)[2]);
    if (!(await confirmDialog({ title: T('sos_confirm_title'), body: T('sos_confirm_body', label), confirmLabel: T('sos_send'), tone: 'urgent' }))) return;
    await busy(send, async () => {
      const pos = withLoc.checked ? await getPosition() : null;
      try {
        const r = await tApi.post('/api/tourist/sos', { type, description: details.value.trim() || undefined, lat: pos?.lat, lng: pos?.lng });
        toast(r.duplicate ? T('sos_already') : T('sos_sent'));
        await loadMe();
        sos();
      } catch (e2) {
        err.hidden = false;
        clear(err, e2.message, ' ', el('a', { href: `tel:${me.emergencyLine}`, class: 'strong' }, `${T('call')} ${me.emergencyLine}`));
      }
    });
  });
  page(T('sos_title'),
    el('h2', { class: 'section-head' }, T('sos_title')),
    openSos ? sosStatusCard(openSos) : form,
    emergencyLink(),
    el('section', { class: 'section' }, el('h3', {}, T('my_requests')), me.feed.sos.length
      ? el('div', { class: 'stack' }, me.feed.sos.map((s) => el('div', { class: 't-card' }, el('div', { class: 'row between' }, el('strong', {}, `${s.ref} · ${T(`t_${s.emergency_type}`)}`), el('span', { class: 'small muted' }, tAge(s.opened_at))), statusSteps(s))))
      : el('p', { class: 'muted' }, T('none_yet'))));
  pollMe(openSos ? 5000 : 15000, sos);
}

function statusSteps(s) {
  const step = s.status === 'open' ? 0 : s.status === 'acknowledged' ? 1 : 2;
  return el('ol', { class: 'status-steps', 'aria-label': T('sos_status') }, [T('st_received'), T('st_responding'), T('st_resolved')].map((l, i) =>
    el('li', { class: i === step ? 'is-current' : i < step ? 'is-done' : '', 'aria-current': i === step ? 'step' : null }, l)));
}

function sosStatusCard(s) {
  return el('section', { class: 't-card', 'aria-live': 'polite' },
    el('div', { class: 'row between' }, el('h2', {}, T('sos_status')), el('span', { class: 'badge tone-urgent' }, s.ref)),
    el('p', { class: 'strong' }, T(`t_${s.emergency_type}`)),
    statusSteps(s),
    el('p', {}, s.status === 'open' ? T('st_waiting') : s.status === 'acknowledged' ? T('st_ranger', s.ranger_name || 'Ranger') : T('st_resolved_by', s.ranger_name || 'Ranger')),
    s.status === 'open' || s.status === 'acknowledged' ? el('p', { class: 'small' }, T('sos_also_call')) : null);
}

function locationCard() {
  const t = me.tourist;
  const status = el('p', { class: 'small muted', 'aria-live': 'polite' }, t.last_located_at ? `${T('location_shared')} · ${tAge(t.last_located_at)}` : T('location_help'));
  const btn = el('button', { type: 'button', class: 'btn btn-block' }, icon('pin'), el('span', {}, T('share_location')));
  btn.addEventListener('click', () => busy(btn, async () => {
    const pos = await getPosition();
    if (!pos) {
      status.textContent = T('location_denied');
      return;
    }
    await tApi.post('/api/tourist/location', pos);
    status.textContent = `${T('location_shared')} · ${tAge(new Date().toISOString())}`;
    toast(T('location_shared'));
  }));
  return el('div', { class: 't-card', style: null }, btn, status);
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

function guide() {
  page(T('guide_title'),
    el('div', { class: 'page-head' }, el('div', {}, el('h2', {}, T('guide_title')), el('p', { class: 'sub' }, T('guide_sub')))),
    el('div', {}, GUIDE[lang].map(([ic, title, items], i) => el('details', { class: 'guide-section', open: i === 0 ? true : null },
      el('summary', {}, icon(ic), title), el('ul', {}, items.map((x) => el('li', {}, x)))))),
    el('details', { class: 'guide-section section' }, el('summary', {}, icon('globe'), lang === 'sw' ? 'Maneno muhimu' : 'Useful Kiswahili phrases'),
      el('ul', {}, PHRASES.map(([en, sw]) => el('li', {}, el('strong', {}, sw), ` — ${en}`)))),
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
    group_size: el('input', { id: 'p-group', type: 'number', min: '1', max: '60', value: String(t.group_size) }),
    emergency_contact: el('input', { id: 'p-ec', value: t.emergency_contact || '' }),
    sms_alerts: el('input', { id: 'p-sms', type: 'checkbox', checked: t.sms_alerts }),
  };
  f.area_id.value = t.area_id;
  const err = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const save = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, el('span', {}, T('save')));
  const form = el('form', { class: 't-card', novalidate: true },
    el('h2', {}, T('trip_title')), el('p', { class: 'small muted' }, `${t.name} · ${t.phone}`), err,
    field('p-area', T('destination'), f.area_id), field('p-lodge', T('lodge'), f.lodge),
    el('div', { class: 'type-grid' }, field('p-start', T('trip_start'), f.trip_start), field('p-end', T('trip_end'), f.trip_end)),
    field('p-group', T('group'), f.group_size), field('p-ec', T('emergency_contact'), f.emergency_contact),
    el('label', { class: 'duty-toggle' }, f.sms_alerts, el('span', {}, T('sms_alerts'))), save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
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
  page(T('trip_title'), form, el('div', { class: 't-card', style: null }, out), emergencyLink());
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
