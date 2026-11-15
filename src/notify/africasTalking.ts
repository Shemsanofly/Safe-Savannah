import { classifyNetworkError, type SendOutcome, type SmsMessage, type SmsProvider } from './provider.js';

/**
 * Africa's Talking per-recipient status codes for POST /version1/messaging.
 * 100 Processed, 101 Sent, 102 Queued → accepted by the provider (not delivered yet).
 * 500 InternalServerError, 501 GatewayError → transient on the provider side.
 * Everything else (401 RiskHold, 402 InvalidSenderId, 403 InvalidPhoneNumber,
 * 404 UnsupportedNumberType, 405 InsufficientBalance, 406 UserInBlacklist,
 * 407 CouldNotRoute, 409 DoNotDisturbRejection, 502 RejectedByGateway…) → rejected.
 */
export function classifyAtRecipientStatus(statusCode: number): 'accepted' | 'transient' | 'rejected' {
  if (statusCode >= 100 && statusCode <= 102) return 'accepted';
  if (statusCode === 500 || statusCode === 501) return 'transient';
  return 'rejected';
}

interface AtResponse {
  SMSMessageData?: {
    Message?: string;
    Recipients?: { statusCode?: number; status?: string; number?: string; messageId?: string; cost?: string }[];
  };
}

export function parseAtResponse(httpStatus: number, bodyText: string): SendOutcome {
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: 'rejected', detail: `HTTP ${httpStatus}: check AT_USERNAME / AT_API_KEY`, httpStatus };
  }
  if (httpStatus === 429 || httpStatus === 503) {
    return { kind: 'transient', detail: `HTTP ${httpStatus}: provider throttled/unavailable`, httpStatus };
  }
  if (httpStatus >= 500) {
    return { kind: 'ambiguous', detail: `HTTP ${httpStatus}: provider error; message may have been accepted`, httpStatus };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { kind: 'rejected', detail: `HTTP ${httpStatus}: ${bodyText.slice(0, 200)}`, httpStatus };
  }
  let parsed: AtResponse;
  try {
    parsed = JSON.parse(bodyText) as AtResponse;
  } catch {
    return { kind: 'ambiguous', detail: `HTTP ${httpStatus} with non-JSON body: ${bodyText.slice(0, 200)}`, httpStatus };
  }
  const recipient = parsed.SMSMessageData?.Recipients?.[0];
  if (!recipient || typeof recipient.statusCode !== 'number') {
    // e.g. "Message": "InvalidSenderId" with no recipients.
    return { kind: 'rejected', detail: `No recipient result: ${parsed.SMSMessageData?.Message ?? bodyText.slice(0, 200)}`, httpStatus };
  }
  const providerStatus = `${recipient.statusCode} ${recipient.status ?? ''}`.trim();
  switch (classifyAtRecipientStatus(recipient.statusCode)) {
    case 'accepted':
      return { kind: 'accepted', messageId: recipient.messageId ?? null, providerStatus, httpStatus, detail: recipient.cost };
    case 'transient':
      return { kind: 'transient', detail: `provider status ${providerStatus}`, httpStatus };
    default:
      return { kind: 'rejected', detail: `provider status ${providerStatus}`, providerStatus, httpStatus };
  }
}

export interface AfricasTalkingOptions {
  username: string;
  apiKey: string;
  environment: 'sandbox' | 'live';
  senderId?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class AfricasTalkingSms implements SmsProvider {
  readonly name: string;
  private readonly url: string;
  constructor(private readonly opts: AfricasTalkingOptions) {
    this.name = `africastalking-${opts.environment}`;
    this.url =
      opts.environment === 'sandbox'
        ? 'https://api.sandbox.africastalking.com/version1/messaging'
        : 'https://api.africastalking.com/version1/messaging';
  }

  async send(msg: SmsMessage): Promise<SendOutcome> {
    const form = new URLSearchParams({ username: this.opts.username, to: msg.to, message: msg.body });
    if (this.opts.senderId) form.set('from', this.opts.senderId);
    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.url, {
        method: 'POST',
        headers: {
          apiKey: this.opts.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      return classifyNetworkError(err);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // Headers arrived, so the request reached the provider; the body was lost.
      return { kind: 'ambiguous', detail: `response body lost: ${(err as Error).message}`, httpStatus: res.status };
    }
    return parseAtResponse(res.status, text);
  }
}

/**
 * Africa's Talking delivery report statuses → our notification status.
 * Only final statuses change the job state; intermediate ones are recorded as provider_status.
 */
export function mapDeliveryStatus(status: string): 'delivered' | 'delivery_failed' | null {
  switch (status) {
    case 'Success':
      return 'delivered';
    case 'Failed':
    case 'Rejected':
    case 'AbsentSubscriber':
    case 'Expired':
      return 'delivery_failed';
    default:
      return null; // Sent, Submitted, Buffered: still in transit
  }
}
