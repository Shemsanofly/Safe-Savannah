import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { loadConfig } from '../dist/src/config.js';
import { LocalFaceRuntime } from '../dist/src/gate/faceRuntime.js';
import { cosine } from '../dist/src/gate/biometrics.js';
const config = loadConfig();
const runtime = new LocalFaceRuntime(config);
try {
  await runtime.ready();
  const blank = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#707070' } }).jpeg().toBuffer();
  const none = await runtime.extract(blank.toString('base64'));
  if (none.count !== 0) throw new Error('The no-face check did not pass.');
  console.log('Verified local YuNet + SFace startup, model checksums, and no-face rejection.');
  if (process.argv[2]) {
    const original = await readFile(process.argv[2]);
    const variant = await sharp(original).rotate(3).jpeg({ quality: 82 }).toBuffer();
    const first = await runtime.extract(original.toString('base64'));
    const second = await runtime.extract(variant.toString('base64'));
    if (first.count !== 1 || second.count !== 1) throw new Error('The sample did not produce one face in each view.');
    const similarity = cosine(first.embedding, second.embedding);
    if (similarity < config.GATE_FACE_THRESHOLD) throw new Error('The transformed-image recognition check did not pass.');
    console.log(`Verified real model detection and transformed-image matching: similarity ${similarity.toFixed(3)}. This does not validate deployment accuracy or liveness.`);
  }
} finally { runtime.close(); }
