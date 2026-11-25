/**
 * Wildlife risk assessment. A detection is NOT dangerous just because it is
 * near a boundary: risk combines how dangerous the species is to people on
 * foot, how close it is to a safety zone, how sensitive that zone is, whether
 * people are likely to be there right now, and how confident the detector is.
 *
 * The weights are transparent demo defaults to be reviewed with rangers — not
 * validated safety thresholds.
 */
import { distanceToPolygonM, type LatLng } from './geo.js';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type Sensitivity = 'high' | 'medium' | 'low';
export type Occupancy = 'always' | 'daytime' | 'night' | 'rarely';

export interface SpeciesProfile {
  key: string;
  name_en: string;
  name_sw: string;
  /** 0–1: potential to seriously injure people who come close on foot. */
  danger: number;
  why: string;
}

export const SPECIES: Record<string, SpeciesProfile> = {
  lion: { key: 'lion', name_en: 'Lion', name_sw: 'Simba', danger: 0.95, why: 'large predator; may attack people on foot, especially at night' },
  leopard: { key: 'leopard', name_en: 'Leopard', name_sw: 'Chui', danger: 0.85, why: 'predator; dangerous if cornered or near camp at night' },
  buffalo: { key: 'buffalo', name_en: 'Cape buffalo', name_sw: 'Nyati', danger: 0.9, why: 'unpredictable; lone bulls charge without warning' },
  hippo: { key: 'hippo', name_en: 'Hippopotamus', name_sw: 'Kiboko', danger: 0.9, why: 'very dangerous on land near water, especially after dark' },
  elephant: { key: 'elephant', name_en: 'Elephant', name_sw: 'Tembo', danger: 0.85, why: 'very large; can charge when surprised or with calves' },
  rhino: { key: 'rhino', name_en: 'Rhinoceros', name_sw: 'Kifaru', danger: 0.8, why: 'poor eyesight; may charge at noises' },
  crocodile: { key: 'crocodile', name_en: 'Crocodile', name_sw: 'Mamba', danger: 0.85, why: 'ambush predator at water edges' },
  hyena: { key: 'hyena', name_en: 'Spotted hyena', name_sw: 'Fisi', danger: 0.55, why: 'scavenger; bold around camps at night' },
  cheetah: { key: 'cheetah', name_en: 'Cheetah', name_sw: 'Duma', danger: 0.35, why: 'rarely dangerous to adults; keep distance' },
  baboon: { key: 'baboon', name_en: 'Baboon', name_sw: 'Nyani', danger: 0.3, why: 'steals food; can bite if provoked' },
  giraffe: { key: 'giraffe', name_en: 'Giraffe', name_sw: 'Twiga', danger: 0.15, why: 'generally not dangerous; keep distance' },
  zebra: { key: 'zebra', name_en: 'Zebra', name_sw: 'Punda milia', danger: 0.1, why: 'not dangerous unless approached' },
  wildebeest: { key: 'wildebeest', name_en: 'Wildebeest', name_sw: 'Nyumbu', danger: 0.1, why: 'not dangerous; herds may block roads' },
  antelope: { key: 'antelope', name_en: 'Antelope', name_sw: 'Swala', danger: 0.05, why: 'not dangerous' },
};

export function speciesProfile(key: string | null | undefined): SpeciesProfile {
  return (key && SPECIES[key]) || { key: key || 'unknown', name_en: key ? key[0]!.toUpperCase() + key.slice(1) : 'Unknown animal', name_sw: key || 'Mnyama', danger: 0.4, why: 'species not in the risk table; treat with caution' };
}

const SENSITIVITY_W: Record<Sensitivity, number> = { high: 1, medium: 0.7, low: 0.35 };

/** Whether people are normally present now, given the zone's occupancy pattern and lodge-local hour. */
export function presenceFactor(occupancy: Occupancy, localHour: number): { factor: number; label: string } {
  const day = localHour >= 6 && localHour < 19;
  switch (occupancy) {
    case 'always':
      return { factor: 1, label: 'people present at all hours' };
    case 'daytime':
      return day ? { factor: 1, label: 'people present (daytime use)' } : { factor: 0.45, label: 'area mostly empty at night' };
    case 'night':
      return day ? { factor: 0.5, label: 'used mainly at night' } : { factor: 1, label: 'people present (night use)' };
    case 'rarely':
      return { factor: 0.3, label: 'rarely used by people' };
  }
}

export interface ZoneInput {
  id: number;
  name: string;
  sensitivity: Sensitivity;
  occupancy: Occupancy;
  buffer_m: number;
  geometry: LatLng[];
}

export interface RiskInput {
  species: string | null;
  confidence: number | null;
  location: LatLng | null;
  zones: ZoneInput[];
  localHour: number;
  /** Registered tourists who shared a location within 300 m in the last 30 min. */
  peopleNearby?: number;
  /**
   * Guests checked in to an activity (walking safari, game drive, picnic…) in a zone, by zone id.
   * People there right now count as present whatever the zone's usual occupancy.
   */
  guestsOut?: Record<number, { people: number; label: string }>;
}

export interface RiskResult {
  level: RiskLevel;
  score: number;
  zone: ZoneInput | null;
  distanceM: number | null;
  inside: boolean;
  reasons: string[];
}

export function levelFor(score: number): RiskLevel {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.28) return 'medium';
  if (score >= 0.1) return 'low';
  return 'none';
}

export function assessRisk(input: RiskInput): RiskResult {
  const sp = speciesProfile(input.species);
  const reasons: string[] = [];
  if (!input.species) return { level: 'none', score: 0, zone: null, distanceM: null, inside: false, reasons: ['No animal detected'] };
  reasons.push(`${sp.name_en}: ${sp.why}`);
  if (!input.location) {
    reasons.push('Detection has no location, so it cannot be compared with safety zones');
    return { level: sp.danger >= 0.8 ? 'low' : 'none', score: 0, zone: null, distanceM: null, inside: false, reasons };
  }

  // Most relevant zone = the one that yields the highest proximity × sensitivity.
  let best: { zone: ZoneInput; d: number; prox: number; weight: number } | null = null;
  for (const z of input.zones) {
    const d = distanceToPolygonM(input.location, z.geometry);
    const reach = Math.max(1, z.buffer_m);
    const prox = d === 0 ? 1 : d <= reach ? 0.45 + 0.55 * (1 - d / reach) : 0;
    const pres = input.guestsOut?.[z.id] ? 1 : presenceFactor(z.occupancy, input.localHour).factor;
    const weight = prox * SENSITIVITY_W[z.sensitivity] * pres;
    if (!best || weight > best.weight || (weight === best.weight && d < best.d)) best = { zone: z, d, prox, weight };
  }

  if (!best || best.prox === 0) {
    const nearest = best ? `${Math.round(best.d)} m from ${best.zone.name}` : 'no safety zones configured in this area';
    reasons.push(`Outside every safety zone and its alert distance (${nearest})`);
    return { level: 'none', score: 0, zone: best?.zone ?? null, distanceM: best ? Math.round(best.d) : null, inside: false, reasons };
  }

  const z = best.zone;
  const out = input.guestsOut?.[z.id];
  const pres = out ? { label: `${out.label} (activity check-in)` } : presenceFactor(z.occupancy, input.localHour);
  reasons.push(best.d === 0 ? `Inside ${z.name}` : `${Math.round(best.d)} m from ${z.name} (alert distance ${z.buffer_m} m)`);
  reasons.push(`${z.name} is a ${z.sensitivity}-sensitivity area; ${pres.label}`);

  const conf = input.confidence ?? 0.5;
  const confFactor = conf >= 0.6 ? 1 : conf >= 0.4 ? 0.8 : 0.55;
  if (conf < 0.6) reasons.push(`Detector confidence ${Math.round(conf * 100)}% — verify the sighting`);

  const peopleBoost = (input.peopleNearby ?? 0) > 0 || out ? 1.15 : 1;
  if ((input.peopleNearby ?? 0) > 0) reasons.push(`${input.peopleNearby} registered tourist(s) shared a location nearby recently`);

  const score = Math.min(1, sp.danger * best.weight * confFactor * peopleBoost);
  let level = levelFor(score);
  // A harmless species never escalates past "low", however close it is.
  if (sp.danger < 0.3 && (level === 'medium' || level === 'high' || level === 'critical')) level = 'low';
  return { level, score: Math.round(score * 1000) / 1000, zone: z, distanceM: Math.round(best.d), inside: best.d === 0, reasons };
}

// What-to-do steps for travellers live in the language catalogs (src/domain/locales).
