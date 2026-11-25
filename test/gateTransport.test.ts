import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { httpGateTransport, type GateCommand } from '../src/gate/controller.js';

async function localController(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test controller address');
  return { url: `http://127.0.0.1:${address.port}/open`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
const command = () => ({ id: randomUUID(), staff_id: 'guide', tourist_count: 4, not_after: new Date(Date.now() + 10000) }) as GateCommand;
const config = (url: string) => loadConfig({ GATE_CONTROLLER_MODE: 'http', GATE_CONTROLLER_URL: url, GATE_CONTROLLER_TOKEN: 'private-controller-test-token-12345', GATE_CONTROLLER_GATE_ID: 'north',
  GATE_CONTROLLER_ZONE_ID: '1', GATE_STATION_OPERATOR_ID: 'station', FACE_TEMPLATE_KEY: '14'.repeat(32), SESSION_SECRET: 'private-session-test-secret-at-least-32-characters', COOKIE_SECURE: 'true' } as NodeJS.ProcessEnv);

describe('HTTP gate controller adapter', () => {
  it('sends the exact bounded pulse command with authorization and idempotency', async () => {
    let received: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    let idempotency: string | string[] | undefined;
    const device = await localController((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString());
        authorization = req.headers.authorization;
        idempotency = req.headers['idempotency-key'];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ requestId: received!.requestId, accepted: true }));
      });
    });
    try {
      const cmd = command();
      await httpGateTransport.pulse(cmd, config(device.url));
      expect(authorization).toBe('Bearer private-controller-test-token-12345');
      expect(idempotency).toBe(cmd.id);
      expect(received).toMatchObject({ requestId: cmd.id, gateId: 'north', action: 'pulse_open', pulseMs: 1000, guideId: 'guide', touristCount: 4 });
      expect(received).not.toHaveProperty('image');
    } finally { await device.close(); }
  });
  it('rejects uncorrelated acknowledgements, oversized replies and redirects', async () => {
    for (const kind of ['wrong_id', 'large', 'redirect']) {
      const device = await localController((_req, res) => {
        if (kind === 'redirect') { res.writeHead(302, { location: '/other' }); res.end(); }
        else if (kind === 'large') res.end('x'.repeat(5000));
        else res.end(JSON.stringify({ requestId: randomUUID(), accepted: true }));
      });
      try { await expect(httpGateTransport.pulse(command(), config(device.url))).rejects.toThrow(); }
      finally { await device.close(); }
    }
  });
});
