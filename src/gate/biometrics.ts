import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DomainError } from '../store/events.js';

export const FACE_MODEL_ID = 'opencv-yunet-2023mar-sface-2021dec-v1';
export function unitVector(vector: number[]): number[] {
  if (vector.length !== 128 || vector.some((n) => !Number.isFinite(n))) throw new Error('Invalid face template');
  const norm = Math.hypot(...vector);
  if (norm < 0.001) throw new Error('Invalid face template');
  return vector.map((n) => n / norm);
}
export const cosine = (a: number[], b: number[]) => a.reduce((sum, n, i) => sum + n * b[i]!, 0);
export function enrollmentVector(vectors: number[][], threshold: number): number[] {
  if (vectors.length !== 3) throw new DomainError(400, 'face_samples', 'Capture three clear samples of the same staff member.');
  const normalized = vectors.map(unitVector);
  if (normalized.some((a) => normalized.some((b) => cosine(a, b) < threshold))) {
    throw new DomainError(400, 'inconsistent_faces', 'The samples did not consistently match one person. Capture them again.');
  }
  return unitVector(normalized[0]!.map((_, i) => normalized.reduce((sum, row) => sum + row[i]!, 0) / 3));
}
export function encryptFace(staffId: string, vector: number[], key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(`${staffId}|${FACE_MODEL_ID}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(unitVector(vector)), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function decryptFace(staffId: string, template: string, key: string): number[] {
  try {
    const bytes = Buffer.from(template, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${staffId}|${FACE_MODEL_ID}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return unitVector(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as number[]);
  } catch { throw new DomainError(503, 'face_key', 'Face profiles could not be read. Entry remains closed; contact an admin.'); }
}
export function rankFaces(query: number[], profiles: { staffId: string; vector: number[] }[], threshold: number, margin: number) {
  const ranked = profiles.map((p) => ({ staffId: p.staffId, similarity: cosine(unitVector(query), p.vector) })).sort((a, b) => b.similarity - a.similarity);
  const best = ranked[0];
  if (!best || best.similarity < threshold) return { match: null, reason: 'face_unknown' as const };
  if (ranked[1] && best.similarity - ranked[1].similarity < margin) return { match: null, reason: 'face_ambiguous' as const };
  return { match: best, reason: null };
}
