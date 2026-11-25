// Guest languages: every catalog must cover every species and produce usable alert, roll-call and all-clear text.
import { describe, expect, it } from 'vitest';
import { alertContent, allClearContent, catalog, LANGS, rollCallReasons, speciesName } from '../src/domain/i18n.js';

const en = catalog('en');

describe('guest languages', () => {

it('every language names every species and lists the same safety steps', () => {
  for (const lang of LANGS) {
    const c = catalog(lang);
    expect(Object.keys(c.species).sort(), `${lang} species`).toEqual(Object.keys(en.species).sort());
    expect(Object.keys(c.actions.extra).sort(), `${lang} extra steps`).toEqual(Object.keys(en.actions.extra).sort());
    expect(c.actions.generic.length, `${lang} generic steps`).toBe(en.actions.generic.length);
    for (const key of Object.keys(en.species)) expect(speciesName(lang, key).trim(), `${lang} ${key}`).toBeTruthy();
  }
});

it('alert, roll-call and all-clear content is filled in for all languages', () => {
  const alert = alertContent('lion', 'Seronera river', true);
  const clear = allClearContent('Seronera river', false, false);
  const reasons = rollCallReasons('elephant', 'Seronera river');
  for (const lang of LANGS) {
    expect(alert[lang].title.includes('Seronera river'), `${lang} alert title`).toBeTruthy();
    expect(alert[lang].body && alert[lang].actions.length >= 3, `${lang} alert body/actions`).toBeTruthy();
    expect(clear[lang].title && clear[lang].body, `${lang} all clear`).toBeTruthy();
    expect(reasons[lang].includes('Seronera river'), `${lang} roll-call reason`).toBeTruthy();
  }
  expect(alert.fr.title).not.toBe(alert.en.title);
  expect(alert.zh.body).not.toBe(alert.en.body);
});

it('SMS templates keep the placeholders and stay at most a few segments', () => {
  for (const lang of LANGS) {
    const c = catalog(lang);
    const sms = c.alertSms({ tag: ' TEST', simulated: true, animal: speciesName(lang, 'buffalo'), place: 'Seronera river', line: '+255700000000' });
    expect(sms.includes('Seronera river') && sms.includes('+255700000000'), `${lang} alert SMS`).toBeTruthy();
    const rc = c.rollCallSms({ tag: '', reason: rollCallReasons('lion', 'Camp')[lang], lodge: 'Seronera Tented Camp', line: '+255700000000' });
    expect(rc.includes('+255700000000') && rc.length < 320, `${lang} roll-call SMS (${rc.length})`).toBeTruthy();
    expect(c.allClearSms({ tag: '', place: 'Camp' }).includes('Camp'), `${lang} all-clear SMS`).toBeTruthy();
    expect(c.sosReceived('SOS-1', '+255700000000').includes('SOS-1'), `${lang} SOS`).toBeTruthy();
  }
});

it('unknown languages fall back to English', () => {
  expect(catalog('xx')).toBe(en);
  expect(catalog(null)).toBe(en);
});
});
