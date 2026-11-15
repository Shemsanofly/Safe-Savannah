/** Verify the pinned model loads, its checksum matches, and it has the target class by label. */
import { loadConfig } from '../config.js';
import { loadManifest, OnnxYoloDetector } from '../vision/onnxDetector.js';

const cfg = loadConfig();
const { manifest, modelPath } = await loadManifest(cfg.MODEL_MANIFEST);
const det = await OnnxYoloDetector.create({ manifestPath: cfg.MODEL_MANIFEST, classes: [cfg.TARGET_CLASS], minConfidence: 0.25 });
console.log(`OK: ${det.modelId} (${modelPath})`);
console.log(`"${cfg.TARGET_CLASS}" is class index ${manifest.labels.indexOf(cfg.TARGET_CLASS)} of ${manifest.labels.length}`);
console.log(`License: ${manifest.license ?? 'not recorded — review before sharing or deploying'}`);
await det.close();
