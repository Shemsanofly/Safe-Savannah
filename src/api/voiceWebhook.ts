import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import { voiceXml } from '../notify/voice.js';
import { createSos, EMERGENCY_TYPES, normalizePhone } from '../store/platform.js';

export interface VoiceRequest {
  sessionId?: string;
  isActive?: string;
  direction?: string;
  callerNumber?: string;
  destinationNumber?: string;
  dtmfDigits?: string;
}

const MENU =
  'Safe Savannah emergency line. For a medical emergency press 1. For dangerous wildlife press 2. For a vehicle breakdown press 3. For personal safety press 4.';

/**
 * Africa's Talking voice callback.
 * Outbound alert calls: reads the queued script for this session.
 * Inbound calls to the AT number: keypad menu that raises an SOS for the caller.
 */
export async function handleVoice(db: Db, cfg: AppConfig, req: VoiceRequest, opts: { simulated?: boolean; callbackUrl: string }): Promise<string> {
  const xml = await route(db, cfg, req, opts.callbackUrl);
  await db
    .query('INSERT INTO channel_log (channel, session_id, phone, input, response, simulated) VALUES ($1,$2,$3,$4,$5,$6)', [
      'voice', req.sessionId ?? null, req.callerNumber ?? req.destinationNumber ?? null, req.dtmfDigits ?? req.direction ?? null, xml, !!opts.simulated,
    ])
    .catch(() => undefined);
  return xml;
}

async function route(db: Db, cfg: AppConfig, req: VoiceRequest, callbackUrl: string): Promise<string> {
  if (req.isActive === '0') return ''; // end-of-call notification
  if ((req.direction ?? '').toLowerCase() === 'outbound') {
    const job = await db.query<{ message_body: string }>(
      `SELECT message_body FROM notification_jobs WHERE channel = 'voice' AND message_body IS NOT NULL
         AND (provider_message_id = $1 OR to_number = $2) ORDER BY (provider_message_id = $1) DESC, id DESC LIMIT 1`,
      [req.sessionId ?? '', req.destinationNumber ?? ''],
    );
    return voiceXml.say(job.rows[0]?.message_body ?? 'Safe Savannah alert. Please check the duty dashboard.');
  }
  const phone = normalizePhone(req.callerNumber ?? '') ?? req.callerNumber ?? '';
  if (!req.dtmfDigits) return voiceXml.menu(MENU, callbackUrl);
  const type = EMERGENCY_TYPES[Number(req.dtmfDigits) - 1];
  if (!type || !phone) return voiceXml.menu(`Sorry, that was not a valid option. ${MENU}`, callbackUrl);
  const tourist = (await db.query<{ id: number }>('SELECT id FROM tourists WHERE phone = $1 AND active', [phone])).rows[0];
  const { incident, duplicate } = await createSos(
    db,
    { touristId: tourist?.id ?? null, phone, type, channel: 'voice' },
    { timeZone: cfg.TIMEZONE, emergencyLine: cfg.EMERGENCY_LINE, testMode: cfg.SMS_TEST_MODE },
  );
  const ref = eventRef(incident.id).replace('-', ' ');
  return voiceXml.say(
    duplicate
      ? `Your request ${ref} is already with the rangers. Stay somewhere safe.`
      : `Help has been requested. Your reference is ${ref}. Rangers have been alerted and you will receive a text message. Stay somewhere safe.`,
  );
}
