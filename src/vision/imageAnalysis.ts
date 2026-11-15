import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { SPECIES } from '../domain/risk.js';
import type { Detection } from '../domain/types.js';
import { computeLetterbox, type Frame } from './frameSource.js';
import { OnnxYoloDetector } from './onnxDetector.js';

const SIZE = 640;

/** Model labels that are animals but NOT wildlife species we can name honestly (e.g. COCO "cow" is not a buffalo). */
const NON_WILDLIFE_ANIMALS = new Set(['cow', 'horse', 'sheep', 'dog', 'cat', 'bird', 'bear', 'person']);

/** Map a model label to a species key from the risk table, or null if the model cannot name a wildlife species. */
export function labelToSpecies(label: string): string | null {
  const l = label.toLowerCase().trim();
  if (SPECIES[l]) return l;
  const aliases: Record<string, string> = { 'african elephant': 'elephant', 'cape buffalo': 'buffalo', hippopotamus: 'hippo', rhinoceros: 'rhino', gnu: 'wildebeest' };
  return aliases[l] ?? null;
}

let detectorPromise: Promise<OnnxYoloDetector | null> | null = null;
let detectorError: string | null = null;

/** Lazily load the pinned model once. Returns null (with a reason) if no model is installed. */
export async function getImageDetector(manifestPath: string): Promise<OnnxYoloDetector | null> {
  if (!existsSync(manifestPath)) {
    detectorError = `No model manifest at ${manifestPath}. Run scripts/export_model.py to install one.`;
    return null;
  }
  detectorPromise ??= OnnxYoloDetector.create({ manifestPath, classes: 'all', minConfidence: 0.25 }).catch((err: Error) => {
    detectorError = err.message;
    detectorPromise = null;
    return null;
  });
  return detectorPromise;
}

export function modelStatus(det: OnnxYoloDetector | null) {
  if (!det) return { available: false, reason: detectorError, modelId: null, recognises: [] as string[], cannotRecognise: Object.keys(SPECIES) };
  const recognises = det.manifest.labels.map(labelToSpecies).filter((s): s is string => !!s);
  return {
    available: true,
    reason: null,
    modelId: det.modelId,
    recognises: [...new Set(recognises)],
    cannotRecognise: Object.keys(SPECIES).filter((k) => !recognises.includes(k)),
  };
}

/** Normalise an uploaded photo: auto-rotate, strip metadata, cap size, JPEG. */
export async function normaliseUpload(input: Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const img = sharp(input, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
  const { data, info } = await img.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height };
}

/** Letterbox a JPEG into the model's square RGB input. */
export async function toFrame(jpeg: Buffer, width: number, height: number): Promise<Frame> {
  const lb = computeLetterbox(width, height, SIZE);
  const data = await sharp(jpeg)
    .resize(lb.scaledW, lb.scaledH, { fit: 'fill' })
    .extend({ top: lb.padY, bottom: SIZE - lb.scaledH - lb.padY, left: lb.padX, right: SIZE - lb.scaledW - lb.padX, background: { r: 114, g: 114, b: 114 } })
    .removeAlpha()
    .raw()
    .toBuffer();
  return { data, seq: 0, receivedAt: Date.now(), mediaMs: 0, letterbox: lb };
}

export interface ImageResult {
  best: (Detection & { species: string }) | null;
  all: { label: string; confidence: number; species: string | null; box: Detection['box'] }[];
}

export async function analyseImage(det: OnnxYoloDetector, jpeg: Buffer, width: number, height: number): Promise<ImageResult> {
  const detections = await det.detect(await toFrame(jpeg, width, height));
  const all = detections
    .filter((d) => labelToSpecies(d.label) || NON_WILDLIFE_ANIMALS.has(d.label))
    .map((d) => ({ label: d.label, confidence: Math.round(d.confidence * 1000) / 1000, species: labelToSpecies(d.label), box: d.box }));
  const wildlife = detections.filter((d) => labelToSpecies(d.label));
  const top = wildlife.sort((a, b) => b.confidence - a.confidence)[0];
  return { best: top ? { ...top, species: labelToSpecies(top.label)! } : null, all };
}

/** Draw boxes on the stored photo for review. */
export async function annotateUpload(jpeg: Buffer, width: number, height: number, boxes: ImageResult['all']): Promise<Buffer> {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fs = Math.max(14, Math.round(width / 60));
  const rects = boxes
    .map((b) => {
      const x = b.box.x1 * width;
      const y = b.box.y1 * height;
      const color = b.species ? '#e2a33b' : '#9aa39b';
      const text = `${b.species ?? b.label} ${Math.round(b.confidence * 100)}%`;
      return `<rect x="${x}" y="${y}" width="${(b.box.x2 - b.box.x1) * width}" height="${(b.box.y2 - b.box.y1) * height}" fill="none" stroke="${color}" stroke-width="${Math.max(2, fs / 6)}"/>
        <rect x="${x}" y="${Math.max(0, y - fs - 6)}" width="${text.length * fs * 0.6 + 10}" height="${fs + 6}" fill="${color}"/>
        <text x="${x + 5}" y="${Math.max(fs, y - 6)}" font-size="${fs}" font-family="sans-serif" font-weight="bold" fill="#0f2a1f">${esc(text)}</text>`;
    })
    .join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`);
  return sharp(jpeg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 82 }).toBuffer();
}
