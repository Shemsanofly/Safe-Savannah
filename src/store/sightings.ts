// "Today in the park": which species were seen today in a guest's park area. Delayed (never live),
// area-level only (never a place or position), and species at risk from poaching are never listed.
import type { Queryable } from '../db/pool.js';
import { LANGS, speciesName } from '../domain/i18n.js';

/** Never shown to guests, whatever the source: a sighting could lead poachers to the animal. */
export const PROTECTED_SPECIES = ['rhino', 'pangolin', 'wild_dog', 'chimpanzee', 'gorilla'];
/** Too uncertain to tell guests about. */
const MIN_CONFIDENCE = 0.5;

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';
export const dayPart = (hour: number): DayPart => (hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 21 ? 'evening' : 'night');

export async function todayInThePark(db: Queryable, areaId: string, opts: { timeZone: string; delayMinutes: number }) {
  const r = await db.query<{ species: string; n: number; last_hour: number; simulated: boolean }>(
    `SELECT species, count(*)::int AS n,
            EXTRACT(HOUR FROM max(captured_at) AT TIME ZONE $2)::int AS last_hour,
            bool_or(analysis = 'simulated') AS simulated
       FROM detections
      WHERE area_id = $1 AND species IS NOT NULL AND NOT (species = ANY($3::text[]))
        AND (confidence IS NULL OR confidence >= $4)
        AND captured_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
        AND captured_at <= now() - ($5::int * interval '1 minute')
      GROUP BY species ORDER BY n DESC, species LIMIT 8`,
    [areaId, opts.timeZone, PROTECTED_SPECIES, MIN_CONFIDENCE, opts.delayMinutes],
  );
  return {
    delayMinutes: opts.delayMinutes,
    simulated: r.rows.some((s) => s.simulated),
    species: r.rows.map((s) => ({
      key: s.species,
      // Names in every guest language, so the app can switch language without asking again.
      names: Object.fromEntries(LANGS.map((l) => [l, speciesName(l, s.species)])),
      count: s.n,
      when: dayPart(s.last_hour),
    })),
  };
}
