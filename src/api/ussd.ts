import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { eventRef, parseEventRef } from '../domain/eventRef.js';
import { acknowledgeEvent, DomainError, getEvent } from '../store/events.js';
import { getOperator } from '../store/operators.js';
import { createSos, EMERGENCY_LABEL, EMERGENCY_TYPES, getTouristByPhone, listAreas, normalizePhone, notifyReporterOfStatus } from '../store/platform.js';

export interface UssdRequest {
  sessionId: string;
  phoneNumber: string;
  text: string;
}

function hhmm(d: Date, timeZone: string): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
}

/**
 * Africa's Talking USSD entry point.
 * - Ranger phones (operators.phone or USSD_ALLOWLIST) get the duty menu: list and acknowledge alerts.
 * - Everyone else gets the tourist emergency menu: request help, check status, safety tips.
 * Nothing is written until the caller confirms. USSD cannot push alerts; SMS does that.
 */
export async function handleUssd(db: Db, cfg: AppConfig, req: UssdRequest, opts: { simulated?: boolean } = {}): Promise<string> {
  const response = await route(db, cfg, req);
  await db
    .query('INSERT INTO channel_log (channel, session_id, phone, input, response, simulated) VALUES ($1,$2,$3,$4,$5,$6)', [
      'ussd', req.sessionId, req.phoneNumber, req.text, response, !!opts.simulated,
    ])
    .catch(() => undefined);
  return response;
}

async function route(db: Db, cfg: AppConfig, req: UssdRequest): Promise<string> {
  const phone = normalizePhone(req.phoneNumber) ?? req.phoneNumber.replace(/\s+/g, '');
  const allowId = cfg.ussdAllowlist.get(phone) ?? cfg.ussdAllowlist.get(req.phoneNumber.replace(/\s+/g, ''));
  const byPhone = (await db.query<{ id: string }>(`SELECT id FROM operators WHERE phone = $1 AND active`, [phone])).rows[0]?.id;
  const operatorId = allowId ?? byPhone;
  if (operatorId) {
    const op = await getOperator(db, operatorId);
    if (op?.active) return rangerMenu(db, cfg, req, op);
  }
  return touristMenu(db, cfg, req, phone);
}

// ---------------------------------------------------------------- tourists
const T = {
  en: {
    home: 'CON Safe Savannah\n1. Request emergency help\n2. My emergency status\n3. Safety tips',
    type: 'CON What is the emergency?\n1. Medical\n2. Dangerous wildlife\n3. Vehicle breakdown\n4. Personal safety',
    park: 'CON Which park are you in?',
    confirm: (label: string, where: string) => `CON Send ${label} SOS from ${where}?\n1. Yes, send now\n2. Cancel`,
    sent: (ref: string, line: string) => `END Help requested (${ref}). Rangers have been alerted. Stay somewhere safe. If you can, also call ${line}.`,
    dup: (ref: string) => `END Your request ${ref} is already with the rangers. Stay somewhere safe.`,
    cancelled: 'END Cancelled. No request was sent.',
    none: 'END You have no emergency requests.',
    tips: 'END Stay in your vehicle near wildlife. Never walk at night without an escort. Keep 50 m from elephants. Never run from a lion.',
    invalid: 'END Invalid choice.',
  },
  sw: {
    home: 'CON Safe Savannah\n1. Omba msaada wa dharura\n2. Hali ya ombi langu\n3. Ushauri wa usalama',
    type: 'CON Dharura gani?\n1. Kiafya\n2. Mnyama hatari\n3. Gari limeharibika\n4. Usalama binafsi',
    park: 'CON Uko hifadhi gani?',
    confirm: (label: string, where: string) => `CON Tuma ombi la ${label} kutoka ${where}?\n1. Ndiyo, tuma sasa\n2. Ghairi`,
    sent: (ref: string, line: string) => `END Msaada umeombwa (${ref}). Askari wamejulishwa. Kaa mahali salama. Ikiwezekana piga pia ${line}.`,
    dup: (ref: string) => `END Ombi lako ${ref} tayari liko kwa askari. Kaa mahali salama.`,
    cancelled: 'END Umeghairi. Hakuna ombi lililotumwa.',
    none: 'END Huna ombi la dharura.',
    tips: 'END Baki ndani ya gari karibu na wanyama. Usitembee usiku bila msindikizaji. Kaa mita 50 mbali na tembo. Usimkimbie simba.',
    invalid: 'END Chaguo si sahihi.',
  },
};
const STATUS_TXT = {
  en: { open: 'waiting for a ranger', acknowledged: 'ranger responding', closed: 'resolved', false_alert: 'closed' },
  sw: { open: 'inasubiri askari', acknowledged: 'askari anashughulikia', closed: 'imetatuliwa', false_alert: 'imefungwa' },
};

async function touristMenu(db: Db, cfg: AppConfig, req: UssdRequest, phone: string): Promise<string> {
  const tourist = await getTouristByPhone(db, phone);
  // USSD menus are in Kiswahili and English (basic phones); other app languages get English here.
  const lang: 'en' | 'sw' = tourist?.language === 'sw' ? 'sw' : 'en';
  const t = T[lang];
  const parts = req.text === '' ? [] : req.text.split('*');
  const [choice, typeIdx, a3, a4] = parts;
  if (!choice) return t.home;

  if (choice === '2') {
    const r = await db.query<{ id: number; emergency_type: string; status: keyof typeof STATUS_TXT.en; ranger: string | null }>(
      `SELECT e.id, e.emergency_type, e.status, o.name ranger FROM events e LEFT JOIN operators o ON o.id = e.acknowledged_by
        WHERE e.kind='sos' AND (e.reporter_phone = $1 OR e.tourist_id = $2) ORDER BY e.id DESC LIMIT 2`,
      [phone, tourist?.id ?? null],
    );
    if (!r.rows.length) return t.none;
    return `END ${r.rows.map((e) => `${eventRef(e.id)}: ${STATUS_TXT[lang][e.status]}${e.ranger ? ` (${e.ranger})` : ''}`).join('\n')}`;
  }
  if (choice === '3') return t.tips;
  if (choice !== '1') return t.invalid;
  if (!typeIdx) return t.type;
  const type = EMERGENCY_TYPES[Number(typeIdx) - 1];
  if (!type) return t.invalid;
  const label = EMERGENCY_LABEL[type][lang];

  // Registered tourists: confirm straight away. Unknown phones: ask which park first.
  let areaId: string | null = tourist?.area_id ?? null;
  let confirm = a3;
  if (!tourist) {
    const areas = await listAreas(db);
    if (!a3) return `${t.park}\n${areas.map((a, i) => `${i + 1}. ${a.name}`).join('\n')}`;
    const area = areas[Number(a3) - 1];
    if (!area) return t.invalid;
    areaId = area.id;
    confirm = a4;
    if (!confirm) return t.confirm(label, area.name);
  } else if (!confirm) {
    return t.confirm(label, [tourist.lodge, (await listAreas(db)).find((a) => a.id === tourist.area_id)?.name].filter(Boolean).join(', '));
  }
  if (confirm !== '1') return t.cancelled;
  const { incident, duplicate } = await createSos(
    db,
    { touristId: tourist?.id ?? null, phone, type, channel: 'ussd', areaId },
    { timeZone: cfg.TIMEZONE, emergencyLine: cfg.EMERGENCY_LINE, testMode: cfg.SMS_TEST_MODE },
  );
  return duplicate ? t.dup(eventRef(incident.id)) : t.sent(eventRef(incident.id), cfg.EMERGENCY_LINE);
}

// ---------------------------------------------------------------- rangers
async function rangerMenu(db: Db, cfg: AppConfig, req: UssdRequest, operator: { id: string; name: string }): Promise<string> {
  const parts = req.text === '' ? [] : req.text.split('*');
  const [choice, idText, confirm] = parts;
  if (parts.length === 0) return 'CON Safe Savannah ranger\n1. Active alerts\n2. Respond to an alert';
  if (choice === '1') {
    const r = await db.query<{ id: number; title: string | null; zone_label: string | null; status: string; opened_at: Date; kind: string }>(
      `SELECT id, title, zone_label, status, opened_at, kind FROM events WHERE status IN ('open','acknowledged')
        ORDER BY (kind='sos') DESC, opened_at DESC LIMIT 4`,
    );
    if (!r.rows.length) return 'END No active alerts recorded. This does not mean the area is safe.';
    return `END ${r.rows.map((e) => `${eventRef(e.id)} ${e.kind === 'sos' ? 'SOS ' : ''}${(e.title ?? e.zone_label ?? '').slice(0, 26)} ${e.status === 'open' ? 'PENDING' : 'RESPONDING'} ${hhmm(e.opened_at, cfg.TIMEZONE)}`).join('\n')}`;
  }
  if (choice !== '2') return 'END Invalid choice.';
  if (idText === undefined) return 'CON Enter alert number (e.g. 14 for SS-014):';
  const id = parseEventRef(idText);
  const event = id ? await getEvent(db, id) : null;
  if (!event) return 'END Alert not found.';
  const ref = eventRef(event.id);
  if (event.status === 'closed' || event.status === 'false_alert') return `END ${ref} is already resolved.`;
  if (event.status === 'acknowledged') return `END ${ref} already has a responder (${event.acknowledged_by}).`;
  if (confirm === undefined) return `CON ${ref} ${(event.title ?? `${event.class_label} at ${event.zone_label}`).slice(0, 60)}.\n1. I am responding\n2. Cancel`;
  if (confirm !== '1') return 'END Cancelled. Nothing was changed.';
  try {
    const { event: e, alreadyAcknowledged } = await acknowledgeEvent(db, event.id, operator.id, 'ussd');
    if (alreadyAcknowledged) return `END ${ref} already has a responder (${e.acknowledged_by}).`;
    await notifyReporterOfStatus(db, event.id, 'responding', operator.name);
    return `END ${ref}: you are responding, ${operator.name}. Coordinate by radio.`;
  } catch (err) {
    if (err instanceof DomainError) return `END ${err.message}`;
    throw err;
  }
}
