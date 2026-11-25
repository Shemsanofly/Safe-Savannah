import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const target = new URL('../.env', import.meta.url);
let content = existsSync(target) ? readFileSync(target, 'utf8') : '';
if (/^FACE_TEMPLATE_KEY=.+$/m.test(content)) {
  console.log('Kept the existing face-template encryption key.');
} else {
  const line = `FACE_TEMPLATE_KEY=${randomBytes(32).toString('hex')}`;
  content = /^FACE_TEMPLATE_KEY=.*$/m.test(content) ? content.replace(/^FACE_TEMPLATE_KEY=.*$/m, line) : content.trimEnd() + '\n' + line + '\n';
  writeFileSync(target, content, { mode: 0o600 });
  console.log('Created a face-template encryption key in the local .env file. Keep this file private and back up the key.');
}
