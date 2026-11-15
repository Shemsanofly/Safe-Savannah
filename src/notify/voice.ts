import type { Db } from '../db/pool.js';
import { classifyNetworkError, type SendOutcome, type VoiceCall, type VoiceProvider } from './provider.js';

/**
 * Africa's Talking Voice. Places an outbound call from your AT virtual number;
 * when it is answered, AT requests the number's callback URL and we read the
 * script with <Say> (see /webhooks/voice). Requires a provisioned voice number —
 * AT's voice sandbox is not operational, so this is for live accounts.
 */
export class AfricasTalkingVoice implements VoiceProvider {
  readonly name = 'africastalking-voice';
  constructor(
    private readonly opts: { username: string; apiKey: string; from: string; environment: 'sandbox' | 'live'; timeoutMs: number; fetchImpl?: typeof fetch },
  ) {}

  async call(c: VoiceCall): Promise<SendOutcome> {
    const url = this.opts.environment === 'sandbox' ? 'https://voice.sandbox.africastalking.com/call' : 'https://voice.africastalking.com/call';
    const form = new URLSearchParams({ username: this.opts.username, from: this.opts.from, to: c.to, clientRequestId: `job-${c.jobId}` });
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: { apiKey: this.opts.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      return classifyNetworkError(err);
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) return { kind: 'rejected', detail: `HTTP ${res.status}: check AT credentials`, httpStatus: res.status };
    if (res.status >= 500) return { kind: 'ambiguous', detail: `HTTP ${res.status}`, httpStatus: res.status };
    try {
      const body = JSON.parse(text) as { entries?: { status?: string; sessionId?: string; phoneNumber?: string }[]; errorMessage?: string };
      const entry = body.entries?.[0];
      if (entry?.status === 'Queued') return { kind: 'accepted', messageId: entry.sessionId ?? null, providerStatus: 'Queued', httpStatus: res.status };
      return { kind: 'rejected', detail: `voice: ${entry?.status ?? body.errorMessage ?? text.slice(0, 160)}`, httpStatus: res.status };
    } catch {
      return { kind: 'ambiguous', detail: `HTTP ${res.status} non-JSON: ${text.slice(0, 120)}`, httpStatus: res.status };
    }
  }
}

/** Clearly-labelled simulation: records the call script; no phone rings. */
export class SimulatedVoice implements VoiceProvider {
  readonly name = 'simulated-voice';
  constructor(private readonly db: Db) {}
  async call(c: VoiceCall): Promise<SendOutcome> {
    const r = await this.db.query<{ id: number }>('INSERT INTO simulated_calls (job_id, to_number, script) VALUES ($1, $2, $3) RETURNING id', [c.jobId, c.to, c.script]);
    return { kind: 'accepted', messageId: `SIMCALL-${r.rows[0]!.id}`, providerStatus: 'Simulated call — no phone rang' };
  }
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);

/** Africa's Talking voice XML helpers. */
export const voiceXml = {
  say: (text: string, then = '') => `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="en-US-Standard-C">${xmlEscape(text)}</Say>${then}</Response>`,
  menu: (prompt: string, callbackUrl: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><Response><GetDigits timeout="20" numDigits="1" callbackUrl="${xmlEscape(callbackUrl)}"><Say voice="en-US-Standard-C">${xmlEscape(prompt)}</Say></GetDigits><Say>No option received. Goodbye.</Say></Response>`,
};
