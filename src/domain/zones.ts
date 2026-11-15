import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ZoneConfig } from './types.js';

const unit = z.number().min(0).max(1);
const ZonesFileSchema = z.object({
  zones: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, 'zone id: letters, digits, dashes'),
        cameraId: z.string().min(1),
        label: z.string().min(1).max(60),
        polygon: z.array(z.tuple([unit, unit])).min(3),
      }),
    )
    .min(1),
});

export async function loadZones(file: string): Promise<ZoneConfig[]> {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const parsed = ZonesFileSchema.parse(raw);
  const seen = new Set<string>();
  for (const zone of parsed.zones) {
    const key = `${zone.cameraId}/${zone.id}`;
    if (seen.has(key)) throw new Error(`Duplicate zone ${key} in ${file}`);
    seen.add(key);
  }
  return parsed.zones;
}
