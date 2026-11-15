import { describe, expect, it } from 'vitest';
import { AfricasTalkingSms, mapDeliveryStatus, parseAtResponse } from '../src/notify/africasTalking.js';
import { alertMessage } from '../src/notify/message.js';
import { backoffMs } from '../src/notify/outbox.js';
import { classifyNetworkError } from '../src/notify/provider.js';
import { eventRef, parseEventRef } from '../src/domain/eventRef.js';

const atBody = (statusCode: number, status: string) =>
  JSON.stringify({
    SMSMessageData: {
      Message: 'Sent to 1/1 Total Cost: TZS 25',
      Recipients: [{ statusCode, number: '+255700000000', status, cost: 'TZS 25', messageId: 'ATXid_abc' }],
    },
  });

describe("Africa's Talking response handling", () => {
  it('101 Success = accepted by provider (not delivered)', () => {
    const o = parseAtResponse(201, atBody(101, 'Success'));
    expect(o).toMatchObject({ kind: 'accepted', messageId: 'ATXid_abc', providerStatus: '101 Success' });
  });
  it('maps permanent and transient recipient codes', () => {
    expect(parseAtResponse(201, atBody(403, 'InvalidPhoneNumber')).kind).toBe('rejected');
    expect(parseAtResponse(201, atBody(405, 'InsufficientBalance')).kind).toBe('rejected');
    expect(parseAtResponse(201, atBody(500, 'InternalServerError')).kind).toBe('transient');
  });
  it('HTTP-level errors', () => {
    expect(parseAtResponse(401, 'The supplied authentication is invalid').kind).toBe('rejected');
    expect(parseAtResponse(503, '').kind).toBe('transient');
    expect(parseAtResponse(502, '').kind).toBe('ambiguous');
    expect(parseAtResponse(200, '<html>').kind).toBe('ambiguous');
  });
  it('network errors: never-sent vs ambiguous', () => {
    expect(classifyNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).kind).toBe('transient');
    expect(classifyNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).kind).toBe('transient');
    expect(classifyNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).kind).toBe('ambiguous');
    expect(classifyNetworkError(new DOMException('timed out', 'TimeoutError')).kind).toBe('ambiguous');
  });
  it('sends a form-encoded request with the apiKey header to the sandbox host', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const sms = new AfricasTalkingSms({
      username: 'sandbox',
      apiKey: 'k',
      environment: 'sandbox',
      timeoutMs: 1000,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(atBody(101, 'Success'), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const o = await sms.send({ recipientAlias: 'duty', to: '+255700000000', body: 'hello' });
    expect(o.kind).toBe('accepted');
    expect(seen!.url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect((seen!.init.headers as Record<string, string>).apiKey).toBe('k');
    expect(String(seen!.init.body)).toContain('to=%2B255700000000');
  });
  it('delivery report mapping', () => {
    expect(mapDeliveryStatus('Success')).toBe('delivered');
    expect(mapDeliveryStatus('AbsentSubscriber')).toBe('delivery_failed');
    expect(mapDeliveryStatus('Buffered')).toBeNull();
  });
});

describe('alert message', () => {
  it('matches the agreed wording and never contains coordinates', () => {
    const msg = alertMessage({ eventId: 14, zoneLabel: 'Guest path A', classLabel: 'elephant', testMode: true, simulated: false });
    expect(msg).toBe('Safe Savannah TEST SS-014. Possible elephant at Guest path A. Check the duty dashboard and follow your radio procedure.');
    expect(msg).not.toMatch(/-?\d+\.\d{3,}/);
  });
  it('labels simulated alerts', () => {
    expect(alertMessage({ eventId: 2, zoneLabel: 'Z', classLabel: 'elephant', testMode: false, simulated: true })).toContain('TEST SS-002 (SIMULATED)');
  });
  it('event refs round-trip', () => {
    expect(eventRef(7)).toBe('SS-007');
    expect(eventRef(1234)).toBe('SS-1234');
    for (const s of ['SS-014', 'ss14', '014', '14']) expect(parseEventRef(s)).toBe(14);
    expect(parseEventRef('abc')).toBeNull();
    expect(parseEventRef('0')).toBeNull();
  });
});

describe('backoff', () => {
  it('doubles and caps', () => {
    expect([1, 2, 3, 4, 10].map((a) => backoffMs(a, 5_000, 60_000))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
  });
});
