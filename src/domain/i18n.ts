// Guest-facing text written by the server (alerts, SMS, roll calls, the all clear), per language.
// Staff screens stay in English. USSD and voice menus are English and Kiswahili only.
import { en } from './locales/en.js';
import { sw } from './locales/sw.js';
import { fr } from './locales/fr.js';
import { de } from './locales/de.js';
import { it } from './locales/it.js';
import { es } from './locales/es.js';
import { zh } from './locales/zh.js';

export const LANGS = ['en', 'sw', 'fr', 'de', 'it', 'es', 'zh'] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_NAMES: Record<Lang, string> = {
  en: 'English', sw: 'Kiswahili', fr: 'Français', de: 'Deutsch', it: 'Italiano', es: 'Español', zh: '中文',
};

export interface Catalog {
  /** Species names by species key (lion, elephant…). */
  species: Record<string, string>;
  /** Used when a species is not in the list. */
  unknownAnimal: string;
  /** What to do: three generic steps, plus one species-specific step put first. */
  actions: { generic: string[]; extra: Record<string, string> };
  alertTitle: (animal: string, place: string, simulated: boolean) => string;
  alertBody: (animal: string) => string;
  /** Warning SMS. `tag` is " TEST" or "". */
  alertSms: (a: { tag: string; simulated: boolean; animal: string; place: string; line: string }) => string;
  sosReceived: (ref: string, line: string) => string;
  sosResponding: (ref: string, ranger: string) => string;
  sosResolved: (ref: string, ranger: string) => string;
  /** Why a lodge roll call started, e.g. "Lion near Seronera tented camp". */
  rollCallReason: (animal: string, place: string) => string;
  /** Reason for a roll call the front desk starts without an incident. */
  safetyCheck: (lodge: string) => string;
  /** "Are you safe?" SMS. Guests reply SAFE/HELP, their own-language words, or 1/2. */
  rollCallSms: (a: { tag: string; reason: string; lodge: string; line: string }) => string;
  allClearTitle: (place: string, simulated: boolean) => string;
  allClearBody: (falseAlarm: boolean) => string;
  allClearSms: (a: { tag: string; place: string }) => string;
}

const CATALOGS: Record<Lang, Catalog> = { en, sw, fr, de, it, es, zh };
export const isLang = (x: unknown): x is Lang => typeof x === 'string' && (LANGS as readonly string[]).includes(x);
export const catalog = (lang: string | null | undefined): Catalog => CATALOGS[isLang(lang) ? lang : 'en'];
export const speciesName = (lang: string | null | undefined, key: string | null | undefined): string => {
  const c = catalog(lang);
  return (key && (c.species[key] ?? en.species[key])) || (key ? key[0]!.toUpperCase() + key.slice(1) : c.unknownAnimal);
};
export function touristActionsFor(lang: string | null | undefined, speciesKey: string | null): string[] {
  const c = catalog(lang);
  const extra = speciesKey ? c.actions.extra[speciesKey] : undefined;
  return extra ? [extra, ...c.actions.generic] : [...c.actions.generic];
}
/** Alert text in every language, stored with the alert so the app can show the guest's own. */
export function alertContent(speciesKey: string | null, place: string, simulated: boolean) {
  return Object.fromEntries(LANGS.map((l) => {
    const c = catalog(l);
    const animal = speciesName(l, speciesKey);
    return [l, { title: c.alertTitle(animal, place, simulated), body: c.alertBody(animal), actions: touristActionsFor(l, speciesKey) }];
  })) as Record<Lang, { title: string; body: string; actions: string[] }>;
}
export function allClearContent(place: string, simulated: boolean, falseAlarm: boolean) {
  return Object.fromEntries(LANGS.map((l) => [l, { title: catalog(l).allClearTitle(place, simulated), body: catalog(l).allClearBody(falseAlarm), actions: [] as string[] }])) as Record<Lang, { title: string; body: string; actions: string[] }>;
}
export const rollCallReasons = (speciesKey: string | null, place: string) =>
  Object.fromEntries(LANGS.map((l) => [l, catalog(l).rollCallReason(speciesName(l, speciesKey), place)])) as Record<Lang, string>;
export const safetyCheckReasons = (lodge: string) => Object.fromEntries(LANGS.map((l) => [l, catalog(l).safetyCheck(lodge)])) as Record<Lang, string>;
