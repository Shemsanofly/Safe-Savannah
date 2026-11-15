import type { OpenEventInput } from '../../src/store/events.js';

export function sampleEvent(over: Partial<OpenEventInput> = {}): OpenEventInput {
  const now = Date.now();
  return {
    cameraId: 'cam-1',
    zoneId: 'guest-path-a',
    zoneLabel: 'Guest path A',
    classLabel: 'elephant',
    confidence: 0.7,
    bbox: { x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.8 },
    firstSeenAt: new Date(now - 600),
    lastSeenAt: new Date(now),
    snapshotPath: null,
    source: 'inference',
    model: 'test',
    ...over,
  };
}
