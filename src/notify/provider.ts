/**
 * Outcome of one send attempt, classified for the outbox:
 *  accepted  – provider accepted the request (NOT proof of delivery to the handset)
 *  transient – known not-sent failure (no route / DNS / refused / throttled): safe to retry
 *  ambiguous – may or may not have been sent (timeout, connection reset, 5xx): do NOT blindly retry
 *  rejected  – permanent failure (bad credentials, invalid number, blacklist, no balance)
 */
export type SendOutcome =
  | { kind: 'accepted'; messageId: string | null; providerStatus: string; httpStatus?: number; detail?: string }
  | { kind: 'transient'; detail: string; httpStatus?: number }
  | { kind: 'ambiguous'; detail: string; httpStatus?: number }
  | { kind: 'rejected'; detail: string; providerStatus?: string; httpStatus?: number };

export interface SmsMessage {
  recipientAlias: string;
  to: string;
  body: string;
}

export interface SmsProvider {
  readonly name: string;
  send(msg: SmsMessage): Promise<SendOutcome>;
}

/** Network error codes meaning the request never reached the provider. */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Classify a thrown fetch/network error. */
export function classifyNetworkError(err: unknown): SendOutcome {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string; name?: string } };
  const code = e?.cause?.code ?? e?.code;
  if (code && NOT_SENT_CODES.has(code)) return { kind: 'transient', detail: `network: ${code}` };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.name === 'TimeoutError') {
    return { kind: 'ambiguous', detail: 'request timed out; provider may or may not have accepted it' };
  }
  return { kind: 'ambiguous', detail: `network: ${code ?? e?.cause?.message ?? e?.message ?? String(err)}` };
}

export interface VoiceCall {
  jobId: number;
  recipientAlias: string;
  to: string;
  /** Text read to the person who answers. */
  script: string;
}

export interface VoiceProvider {
  readonly name: string;
  call(c: VoiceCall): Promise<SendOutcome>;
}
