import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { eventRef, parseEventRef } from '../domain/eventRef.js';
import { acknowledgeEvent, DomainError, getEvent } from '../store/events.js';
import { getOperator } from '../store/operators.js';

export interface UssdRequest {
  sessionId: string;
  phoneNumber: string;
  text: string;
}

function hhmm(d: Date, timeZone: string): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
}

/**
 * Africa's Talking USSD menu (stretch goal). Allowlisted duty phones can list
 * active alerts and acknowledge one by its short ID, with an explicit confirm
 * step before anything is written. USSD cannot push alerts; SMS does that.
 */
export async function handleUssd(db: Db, cfg: AppConfig, req: UssdRequest): Promise<string> {
  const phone = req.phoneNumber.replace(/\s+/g, '');
  const operatorId = cfg.ussdAllowlist.get(phone);
  const operator = operatorId ? await getOperator(db, operatorId) : null;
  if (!operator || !operator.active) return 'END This phone is not authorised for Safe Savannah.';

  const parts = req.text === '' ? [] : req.text.split('*');
  const [choice, idText, confirm] = parts;

  if (parts.length === 0) {
    return 'CON Safe Savannah duty\n1. Active alerts\n2. Acknowledge an alert';
  }
  if (choice === '1') {
    const r = await db.query<{ id: number; zone_label: string; status: string; opened_at: Date; acknowledged_by: string | null }>(
      `SELECT id, zone_label, status, opened_at, acknowledged_by FROM events
        WHERE status IN ('open', 'acknowledged') ORDER BY opened_at DESC LIMIT 3`,
    );
    if (r.rows.length === 0) return 'END No active alerts recorded. This does not mean the area is safe.';
    const lines = r.rows.map(
      (e) => `${eventRef(e.id)} ${e.zone_label} ${e.status === 'open' ? 'OPEN' : `ACK ${e.acknowledged_by}`} ${hhmm(e.opened_at, cfg.TIMEZONE)}`,
    );
    return `END ${lines.join('\n')}`;
  }
  if (choice !== '2') return 'END Invalid choice.';
  if (idText === undefined) return 'CON Enter alert number (e.g. 14 for SS-014):';

  const id = parseEventRef(idText);
  const event = id ? await getEvent(db, id) : null;
  if (!event) return 'END Alert not found.';
  const ref = eventRef(event.id);
  if (event.status === 'closed' || event.status === 'false_alert') return `END ${ref} is already ${event.status === 'closed' ? 'closed' : 'dismissed'}.`;
  if (event.status === 'acknowledged') return `END ${ref} already acknowledged by ${event.acknowledged_by}.`;

  if (confirm === undefined) {
    return `CON ${ref} possible ${event.class_label} at ${event.zone_label}, opened ${hhmm(event.opened_at, cfg.TIMEZONE)}.\n1. Acknowledge as ${operator.name}\n2. Cancel`;
  }
  if (confirm !== '1') return 'END Cancelled. Nothing was changed.';
  try {
    const { event: e, alreadyAcknowledged } = await acknowledgeEvent(db, event.id, operator.id, 'ussd');
    if (alreadyAcknowledged) return `END ${ref} was already acknowledged by ${e.acknowledged_by}.`;
    return `END ${ref} acknowledged by ${operator.name}. Coordinate the response by radio.`;
  } catch (err) {
    if (err instanceof DomainError) return `END ${err.message}`;
    throw err;
  }
}
