import { eventRef } from '../domain/eventRef.js';

/**
 * Alert text. Deliberately contains no coordinates and no claim about safety
 * or animal intent: it points the officer to the dashboard and radio procedure.
 */
export function alertMessage(opts: { eventId: number; zoneLabel: string; classLabel: string; testMode: boolean; simulated: boolean }): string {
  const tag = opts.testMode || opts.simulated ? ' TEST' : '';
  const sim = opts.simulated ? ' (SIMULATED)' : '';
  return (
    `Safe Savannah${tag} ${eventRef(opts.eventId)}${sim}. ` +
    `Possible ${opts.classLabel} at ${opts.zoneLabel}. ` +
    `Check the duty dashboard and follow your radio procedure.`
  );
}
