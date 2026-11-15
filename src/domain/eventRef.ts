/** Human-friendly incident reference used on the dashboard, SMS and USSD: SS-014. */
export function eventRef(id: number): string {
  return `SS-${String(id).padStart(3, '0')}`;
}

/** Accepts "SS-014", "ss14", "014" or "14". */
export function parseEventRef(input: string): number | null {
  const m = /^\s*(?:ss-?)?0*(\d{1,12})\s*$/i.exec(input);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
