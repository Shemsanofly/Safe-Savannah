import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Detection, ZoneConfig } from '../domain/types.js';
import type { Frame } from './frameSource.js';

export interface AnnotateOptions {
  zones: ZoneConfig[];
  detections: Detection[];
  /** Detections that triggered/refreshed an in-zone hit; drawn in the alert colour. */
  hits?: Detection[];
  targetClass: string;
  banner?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** JPEG of the original (un-padded) frame with zone polygons and boxes drawn. */
export async function annotateFrame(frame: Frame, opts: AnnotateOptions, quality = 78): Promise<Buffer> {
  const lb = frame.letterbox;
  const w = lb.scaledW;
  const h = lb.scaledH;
  const hitSet = new Set(opts.hits ?? []);
  const polys = opts.zones
    .map((z) => {
      const pts = z.polygon.map(([x, y]) => `${(x * w).toFixed(1)},${(y * h).toFixed(1)}`).join(' ');
      const [lx, ly] = z.polygon[0]!;
      return `<polygon points="${pts}" fill="rgba(255,196,0,0.15)" stroke="#ffc400" stroke-width="2" stroke-dasharray="6 4"/>
        <text x="${(lx * w + 4).toFixed(1)}" y="${(ly * h - 6).toFixed(1)}" fill="#ffc400" font-size="13" font-family="sans-serif" font-weight="bold">${esc(z.label)}</text>`;
    })
    .join('');
  const boxes = opts.detections
    .map((d) => {
      const color = hitSet.has(d) ? '#ff3b30' : d.label === opts.targetClass ? '#34c759' : '#8e8e93';
      const x = d.box.x1 * w;
      const y = d.box.y1 * h;
      const bw = (d.box.x2 - d.box.x1) * w;
      const bh = (d.box.y2 - d.box.y1) * h;
      const cx = x + bw / 2;
      const by = y + bh;
      const label = `${esc(d.label)} ${(d.confidence * 100).toFixed(0)}%`;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="none" stroke="${color}" stroke-width="2"/>
        <circle cx="${cx.toFixed(1)}" cy="${by.toFixed(1)}" r="4" fill="${color}"/>
        <rect x="${x.toFixed(1)}" y="${Math.max(0, y - 16).toFixed(1)}" width="${label.length * 7 + 6}" height="16" fill="${color}"/>
        <text x="${(x + 3).toFixed(1)}" y="${Math.max(12, y - 4).toFixed(1)}" fill="#fff" font-size="12" font-family="sans-serif">${label}</text>`;
    })
    .join('');
  const banner = opts.banner
    ? `<rect x="0" y="0" width="${w}" height="20" fill="rgba(0,0,0,0.6)"/><text x="6" y="14" fill="#fff" font-size="12" font-family="sans-serif">${esc(opts.banner)}</text>`
    : '';
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${polys}${boxes}${banner}</svg>`);
  return sharp(frame.data, { raw: { width: lb.size, height: lb.size, channels: 3 } })
    .extract({ left: lb.padX, top: lb.padY, width: w, height: h })
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality })
    .toBuffer();
}

/** Write via temp file + rename so readers never see a half-written JPEG. */
export async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
