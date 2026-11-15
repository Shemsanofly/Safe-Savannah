// Plain-language vocabulary for every status in the system, and the badges that show them.
import { el, icon, fmtTime, until } from './lib.js';

export const INCIDENT = {
  open: { label: 'Needs acknowledgement', short: 'Open', tone: 'urgent', icon: 'incident',
    explain: 'Possible elephant in the zone. Nobody has taken ownership yet. Acknowledge it, verify what is happening, and follow your radio procedure.' },
  acknowledged: { label: 'Acknowledged', short: 'Acknowledged', tone: 'warn', icon: 'user',
    explain: 'An officer has taken ownership. This does not mean a response has happened — log radio or phone handoffs as you coordinate, then close it.' },
  closed: { label: 'Closed — verified', short: 'Closed', tone: 'ok', icon: 'check-circle',
    explain: 'An officer verified the situation and closed the incident with a note. Closing does not mean the area is safe now.' },
  false_alert: { label: 'False alert', short: 'False alert', tone: 'muted', icon: 'x',
    explain: 'An officer checked and recorded that this was not an elephant (for example a vehicle, shadow or staff member).' },
};

export const SOURCE = {
  inference: { label: 'Real detection', tone: 'real', icon: 'cpu', explain: 'Raised by the detection model on the camera feed.' },
  simulated: { label: 'Simulated', tone: 'sim', icon: 'flask', explain: 'Raised by the scripted demo detector on simulated footage. Not a real animal.' },
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
  acknowledged: { label: 'Acknowledged', icon: 'user', tone: 'warn' },
  handoff: { label: 'Handoff', icon: 'radio', tone: '' },
  note: { label: 'Note', icon: 'note', tone: '' },
  closed: { label: 'Closed — verified', icon: 'check-circle', tone: 'ok' },
  dismissed: { label: 'Dismissed as false alert', icon: 'x', tone: '' },
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
