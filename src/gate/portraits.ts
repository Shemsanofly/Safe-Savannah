import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { demoFacePortraitPath } from '../paths.js';
import { DomainError } from '../store/events.js';

export async function normalizeReferencePhoto(image: string): Promise<Buffer> {
  try { return await sharp(Buffer.from(image, 'base64'), { limitInputPixels: 2_000_000 }).rotate().resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); }
  catch { throw new DomainError(400, 'reference_photo_invalid', 'Choose a clear JPEG, PNG or WebP photo.'); }
}
export async function saveReferencePortrait(dataDir: string, staffId: string, jpeg: Buffer, box?: number[]) {
  const metadata = await sharp(jpeg).metadata();
  let source = sharp(jpeg);
  if (box?.length === 4) {
    const [x, y, w, h] = box as [number, number, number, number];
    const left = Math.max(0, Math.floor((x - w * .25) * metadata.width!));
    const top = Math.max(0, Math.floor((y - h * .3) * metadata.height!));
    const right = Math.min(metadata.width!, Math.ceil((x + w * 1.25) * metadata.width!));
    const bottom = Math.min(metadata.height!, Math.ceil((y + h * 1.15) * metadata.height!));
    if (right > left && bottom > top) source = source.extract({ left, top, width: right - left, height: bottom - top });
  }
  const file = demoFacePortraitPath(dataDir, staffId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await source.resize({ width: 240 }).jpeg({ quality: 85 }).toBuffer(), { mode: 0o600 });
}
