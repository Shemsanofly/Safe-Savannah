// Plain-language vocabulary for every status in the system, and the badges that show them.
import { el, icon, fmtTime, until } from './lib.js';

export const INCIDENT = {
  open: { label: 'Pending', short: 'Pending', tone: 'urgent', icon: 'incident',
    explain: 'Nobody is responding yet. Take it on (Responding), verify what is happening, and coordinate by radio or phone.' },
  acknowledged: { label: 'Responding', short: 'Responding', tone: 'warn', icon: 'user',
    explain: 'A ranger has taken ownership and is responding. Log radio or phone handoffs as you coordinate, then mark it resolved.' },
  closed: { label: 'Resolved', short: 'Resolved', tone: 'ok', icon: 'check-circle',
    explain: 'A ranger verified the situation and resolved it with a note. Resolved does not mean the area is safe now.' },
  false_alert: { label: 'Resolved — false alarm', short: 'False alarm', tone: 'muted', icon: 'x',
    explain: 'A ranger checked and recorded that this was not a real threat (for example a vehicle, shadow or another animal).' },
};

export const RISK = {
  none: { label: 'No risk', tone: 'risk-none', icon: 'check', explain: 'Logged only: not near any safety zone, or the animal is not dangerous.' },
  low: { label: 'Low risk', tone: 'risk-low', icon: 'info', explain: 'Logged only. Harmless species, or far from people.' },
  medium: { label: 'Medium risk', tone: 'risk-medium', icon: 'alert', explain: 'Rangers alerted; tourists in the area see an advisory in the app.' },
  high: { label: 'High risk', tone: 'risk-high', icon: 'incident', explain: 'Rangers alerted by SMS; tourists in the area get an SMS warning.' },
  critical: { label: 'Critical', tone: 'risk-critical', icon: 'siren', explain: 'Dangerous animal at or inside a busy area: SMS and voice call to rangers, SMS to tourists.' },
};
export const KIND = {
  zone_alert: { label: 'Gate camera', tone: 'muted', icon: 'camera', explain: 'Raised by the fixed gate camera when an elephant enters its marked zone.' },
  wildlife: { label: 'Wildlife risk', tone: 'muted', icon: 'paw', explain: 'Raised from a wildlife detection near a safety zone.' },
  sos: { label: 'SOS', tone: 'sos', icon: 'siren', explain: 'Emergency reported by a tourist (app, USSD or voice call).' },
};
export const EMERGENCY = {
  medical: { label: 'Medical', icon: 'heart' },
  wildlife: { label: 'Dangerous wildlife', icon: 'paw' },
  vehicle: { label: 'Vehicle breakdown', icon: 'car' },
  personal: { label: 'Personal safety', icon: 'shield' },
};
export const riskBadge = (level, opts) => (level ? badge(RISK[level] || RISK.none, opts) : null);
export const kindBadge = (kind, opts) => badge(KIND[kind] || KIND.wildlife, opts);
export const demoBadge = () => el('span', { class: 'badge tone-demo', title: 'Demonstration data created by the seed script' }, 'Demo');

export const SOURCE = {
  inference: { label: 'Real AI model', tone: 'real', icon: 'cpu', explain: 'Raised by the detection model on a real camera image or uploaded photo.' },
  simulated: { label: 'Simulated AI', tone: 'sim', icon: 'flask', explain: 'Produced by the camera simulator or a simulated upload. Not a real animal.' },
  report: { label: 'Human report', tone: 'muted', icon: 'user', explain: 'Reported by a person (tourist SOS).' },
  synthetic: { label: 'Test data', tone: 'sim', icon: 'flask', explain: 'Injected by a developer test tool. Not from any camera.' },
};

export const FEED = {
  live: { label: 'Live', tone: 'ok', icon: 'camera', explain: 'Fresh frames are arriving from the camera.' },
  reconnecting: { label: 'Reconnecting', tone: 'warn', icon: 'refresh', explain: 'The camera source failed and the system is retrying. Zone status is UNKNOWN until frames return.' },
  stale: { label: 'Stale', tone: 'bad', icon: 'clock', explain: 'The camera is connected but no fresh frame has arrived. Zone status is UNKNOWN.' },
  offline: { label: 'Offline', tone: 'bad', icon: 'camera-off', explain: 'The camera worker is not reporting at all. Zone status is UNKNOWN.' },
};

export const ZONE = {
  armed: { label: 'Watching', tone: 'ok', icon: 'eye', explain: 'The camera is watching the zone and no alert is active. This is not an all-clear — the camera can miss animals.' },
  alerting: { label: 'Alert active', tone: 'urgent', icon: 'incident', explain: 'An alert is open for this zone. Further detections update it instead of sending more SMS.' },
  awaiting_close: { label: 'Waiting for close', tone: 'warn', icon: 'clock', explain: 'Nothing detected in the zone recently, but the alert stays open until an officer closes it.' },
  awaiting_clear: { label: 'Re-arming', tone: 'warn', icon: 'clock', explain: 'The alert is closed. A new alert can open only after the zone has stayed empty for the clear window.' },
  unknown: { label: 'UNKNOWN', tone: 'unknown', icon: 'alert', explain: 'The camera is not delivering frames, so the system cannot tell what is in the zone. Do not treat this as clear.' },
};

export const SMS = {
  pending: { label: 'Queued', tone: 'warn', icon: 'clock', explain: 'Waiting to be sent.' },
  sending: { label: 'Sending', tone: 'warn', icon: 'send', explain: 'The request to the SMS provider is in progress.' },
  retry_wait: { label: 'Retrying', tone: 'warn', icon: 'refresh', explain: 'The provider could not be reached. The message is saved and will be retried automatically.' },
  accepted: { label: 'Accepted by provider', tone: 'ok', icon: 'check', explain: 'The SMS provider accepted the message. This is not proof that it reached the phone.' },
  delivered: { label: 'Delivered', tone: 'ok', icon: 'check-circle', explain: 'The provider reported delivery to the handset. It does not mean anyone has read it.' },
  delivery_failed: { label: 'Delivery failed', tone: 'bad', icon: 'alert', explain: 'The provider reported it could not deliver the message to the handset.' },
  unknown: { label: 'Outcome unknown', tone: 'bad', icon: 'help', explain: 'The request timed out or was interrupted, so it may or may not have been sent. Check the duty phone before resending.' },
  failed: { label: 'Failed', tone: 'bad', icon: 'x', explain: 'The provider rejected the message permanently (for example a bad number or credentials).' },
  expired: { label: 'Not sent — too old', tone: 'muted', icon: 'clock', explain: 'The uplink came back after the alert was already stale, so a late urgent warning was not sent.' },
  cancelled: { label: 'Not sent — closed first', tone: 'muted', icon: 'x', explain: 'The incident was closed before the message could be sent.' },
};
export const RESENDABLE = new Set(['unknown', 'failed', 'expired', 'delivery_failed']);

export const ACTION = {
  opened: { label: 'Alert opened', icon: 'incident', tone: 'urgent' },
  acknowledged: { label: 'Responding', icon: 'user', tone: 'warn' },
  handoff: { label: 'Handoff', icon: 'radio', tone: '' },
  note: { label: 'Note', icon: 'note', tone: '' },
  closed: { label: 'Resolved', icon: 'check-circle', tone: 'ok' },
  dismissed: { label: 'Resolved — false alarm', icon: 'x', tone: '' },
  sms_resend_requested: { label: 'SMS resend requested', icon: 'send', tone: '' },
};
export const CHANNEL = { radio: 'radio', phone: 'phone', in_person: 'in person', ussd: 'USSD', dashboard: 'dashboard' };

export function badge(def, opts = {}) {
  return el('span', { class: `${opts.pill ? 'pill' : 'badge'} tone-${def.tone}`, title: def.explain || null },
    opts.dot ? el('span', { class: `dot ${opts.pulse ? 'dot-pulse' : ''}`, 'aria-hidden': 'true' }) : icon(def.icon),
    opts.short && def.short ? def.short : def.label);
}
export const incidentBadge = (status, opts) => badge(INCIDENT[status] || { label: status, tone: 'muted', icon: 'info' }, opts);
export const sourceBadge = (source, opts) => badge(SOURCE[source] || { label: source, tone: 'muted', icon: 'info' }, opts);
export const smsBadge = (status, opts) => badge(SMS[status] || { label: status, tone: 'muted', icon: 'info' }, opts);
export const feedBadge = (state, opts) => badge(FEED[state] || FEED.offline, opts);
export const zoneBadge = (state, opts) => badge(ZONE[state] || ZONE.unknown, opts);

/** One-line SMS explanation with timing details for a job row. */
export function smsDetail(j) {
  switch (j.status) {
    case 'retry_wait':
      return `Provider unreachable. Retry ${until(j.next_attempt_at)} (attempt ${j.attempts + 1}).`;
    case 'accepted':
      return `Accepted at ${fmtTime(j.accepted_at)}${j.provider_status ? ` (${j.provider_status})` : ''}. Not proof of delivery.`;
    case 'delivered':
      return `Delivery reported at ${fmtTime(j.delivered_at)}.`;
    default:
      return SMS[j.status]?.explain || j.status;
  }
}

/** Most relevant status among an incident's SMS jobs (problems first). */
export function summarizeSms(statuses) {
  if (!statuses || statuses.length === 0) return null;
  const order = ['unknown', 'failed', 'delivery_failed', 'retry_wait', 'sending', 'pending', 'expired', 'cancelled', 'accepted', 'delivered'];
  return order.find((s) => statuses.includes(s)) || statuses[0];
}

/** Guidance text for a failure a human must act on. */
export function smsActionHint(j) {
  if (j.status === 'unknown') return 'Ask the duty phone holder whether the message arrived. Resend only if it did not.';
  if (j.status === 'failed') {
    const e = (j.last_error || '').toLowerCase();
    if (e.includes('no africa')) return "No Africa's Talking API key is configured, so nothing was sent. Set AT_API_KEY (your sandbox key) and restart, then press Resend.";
    if (e.includes('no phone number')) return 'The recipient has no phone number configured. Ask the system owner to fix the SMS recipient list.';
    if (e.includes('api_key') || e.includes('credential') || e.includes('http 401')) return 'The SMS provider rejected the credentials. Ask the system owner to check the provider account.';
    if (e.includes('balance')) return 'The SMS account has no balance. Top up, then resend.';
    return 'Use radio or phone to reach the duty officer. Ask the system owner to check the provider error below.';
  }
  if (j.status === 'delivery_failed') return 'The phone may be off or out of coverage. Use radio, then resend if still relevant.';
  if (j.status === 'expired') return 'If the elephant may still be there, coordinate by radio; resend only if the alert is still relevant.';
  if (j.status === 'retry_wait') return 'Nothing to do — it retries automatically. Meanwhile, use radio for anything urgent.';
  return null;
}
