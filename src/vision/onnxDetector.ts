import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Detection } from '../domain/types.js';
import type { Detector } from './detector.js';
import type { Frame } from './frameSource.js';
import { decodeYolo, rgbToChwFloat } from './yolo.js';

const ManifestSchema = z.object({
  name: z.string(),
  file: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  inputSize: z.number().int().positive(),
  outputLayout: z.literal('yolo-v8-detect'),
  labels: z.array(z.string()).min(1),
  license: z.string().optional(),
});
export type ModelManifest = z.infer<typeof ManifestSchema>;

export async function loadManifest(manifestPath: string): Promise<{ manifest: ModelManifest; modelPath: string }> {
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  return { manifest, modelPath: path.resolve(path.dirname(manifestPath), manifest.file) };
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface OnnxDetectorOptions {
  manifestPath: string;
  /** Labels to report; resolved to class indices via the manifest. */
  classes: string[];
  minConfidence: number;
  iouThreshold?: number;
  threads?: number;
}

export class OnnxYoloDetector implements Detector {
  readonly source = 'inference' as const;
  private constructor(
    readonly modelId: string,
    readonly manifest: ModelManifest,
    private readonly session: import('onnxruntime-node').InferenceSession,
    private readonly ort: typeof import('onnxruntime-node'),
    private readonly classIds: Set<number>,
    private readonly opts: OnnxDetectorOptions,
  ) {}

  static async create(opts: OnnxDetectorOptions): Promise<OnnxYoloDetector> {
    const { manifest, modelPath } = await loadManifest(opts.manifestPath);
    const actual = await sha256File(modelPath);
    if (actual !== manifest.sha256) {
      throw new Error(`Model checksum mismatch for ${modelPath}: manifest pins ${manifest.sha256}, file is ${actual}`);
    }
    const classIds = new Set<number>();
    for (const label of opts.classes) {
      const idx = manifest.labels.indexOf(label);
      if (idx < 0) throw new Error(`Model ${manifest.name} has no class labelled "${label}"`);
      classIds.add(idx);
    }
    const ort = await import('onnxruntime-node');
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      ...(opts.threads ? { intraOpNumThreads: opts.threads } : {}),
    });
    return new OnnxYoloDetector(`${manifest.name}@${manifest.sha256.slice(0, 8)}`, manifest, session, ort, classIds, opts);
  }

  async detect(frame: Frame): Promise<Detection[]> {
    const size = this.manifest.inputSize;
    if (frame.letterbox.size !== size) throw new Error(`Frame size ${frame.letterbox.size} != model input ${size}`);
    const input = new this.ort.Tensor('float32', rgbToChwFloat(frame.data, size), [1, 3, size, size]);
    const results = await this.session.run({ [this.session.inputNames[0]!]: input });
    const out = results[this.session.outputNames[0]!]!;
    return decodeYolo(out.data as Float32Array, out.dims, frame.letterbox, {
      labels: this.manifest.labels,
      minConfidence: this.opts.minConfidence,
      iouThreshold: this.opts.iouThreshold ?? 0.45,
      classIds: this.classIds,
    });
  }

  async close(): Promise<void> {
    await this.session.release();
  }
}
