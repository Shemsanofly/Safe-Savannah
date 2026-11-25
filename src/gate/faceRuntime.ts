import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import type { AppConfig } from '../config.js';
import { DomainError } from '../store/events.js';
import { FACE_MODEL_ID, unitVector } from './biometrics.js';

export interface FaceObservation { count: number; embedding?: number[]; yaw?: number; box?: number[]; hash: string; }
export interface FaceExtractor { extract(image: string): Promise<FaceObservation>; ready(): Promise<void>; close(): void; }

export class LocalFaceRuntime implements FaceExtractor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private pending = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private inflight = 0;
  private retryAt = 0;
  constructor(private cfg: AppConfig) {}
  private unavailable() { return new DomainError(503, 'face_runtime', 'Face recognition is unavailable. Entry stays closed. Ask an admin to check the local face runtime and models.'); }
  async ready(): Promise<void> {
    if (this.closed || Date.now() < this.retryAt) throw this.unavailable();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const candidates = [path.resolve('scripts/face_worker.py'), fileURLToPath(new URL('../../../scripts/face_worker.py', import.meta.url))];
      const script = candidates.find(existsSync);
      if (!script) { reject(this.unavailable()); return; }
      const child = spawn(this.cfg.GATE_FACE_PYTHON, ['-u', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONPATH: path.resolve(this.cfg.GATE_FACE_PYTHON_PATH), PYTHONDONTWRITEBYTECODE: '1' } });
      this.child = child;
      let initialized = false;
      const timer = setTimeout(() => child.kill(), 25000);
      const fail = () => {
        clearTimeout(timer);
        this.child = null;
        this.starting = null;
        this.retryAt = Date.now() + 30000;
        reject(this.unavailable());
        for (const pending of this.pending.values()) pending.reject(this.unavailable());
        this.pending.clear();
      };
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        if (line.length > 16000) { child.kill(); return; }
        try {
          const result = JSON.parse(line) as Record<string, unknown>;
          if (result.ready === true && result.model === FACE_MODEL_ID) { initialized = true; clearTimeout(timer); resolve(); return; }
          if (!initialized) { child.kill(); return; }
          const pending = this.pending.get(String(result.id));
          if (pending) { this.pending.delete(String(result.id)); pending.resolve(result); }
        } catch { child.kill(); }
      });
      // Native startup diagnostics can contain paths; never forward input images or templates to logs.
      child.stderr.resume();
      child.once('error', fail);
      child.once('close', fail);
    });
    return this.starting;
  }
  async extract(encoded: string): Promise<FaceObservation> {
    if (this.inflight >= 4) throw new DomainError(503, 'face_busy', 'Face recognition is busy. Keep the gate closed and try again.');
    this.inflight++;
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 666668) throw new DomainError(400, 'face_image', 'Send a camera JPEG under 500 KB.');
      let jpeg: Buffer;
      try { jpeg = await sharp(Buffer.from(encoded, 'base64'), { limitInputPixels: 2_000_000 }).rotate().resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); }
      catch { throw new DomainError(400, 'face_image', 'The camera frame could not be read.'); }
      await this.ready();
      const id = randomUUID();
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); this.child?.kill(); reject(this.unavailable()); }, 12000);
        this.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        this.child!.stdin.write(JSON.stringify({ id, image: jpeg.toString('base64') }) + '\n', (error) => {
          if (error) { clearTimeout(timer); this.pending.delete(id); reject(this.unavailable()); }
        });
      });
      const hash = createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex');
      if (result.error) throw new DomainError(422, String(result.error), 'Use one well-lit, uncovered face close to the camera.');
      const count = Number(result.count);
      if (!Number.isInteger(count) || count < 0) throw this.unavailable();
      if (count !== 1) return { count, hash };
      if (result.model !== FACE_MODEL_ID || !Array.isArray(result.embedding) || !Number.isFinite(result.yaw)) throw this.unavailable();
      return { count, hash, embedding: unitVector(result.embedding as number[]), yaw: Number(result.yaw), box: result.box as number[] };
    } finally { this.inflight--; }
  }
  close() { this.closed = true; this.child?.kill(); }
}
