import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** "alias:value,alias2:value2" → [{alias, value}] */
function pairList(raw: string): { alias: string; value: string }[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx <= 0) throw new Error(`Expected "alias:value", got "${entry}"`);
      return { alias: entry.slice(0, idx).trim(), value: entry.slice(idx + 1).trim() };
    });
}

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://savannah:savannah@127.0.0.1:5432/safe_savannah'),

  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8080),
  /** Optional second listener that serves ONLY /webhooks/* (for an HTTPS tunnel). */
  WEBHOOK_PORT: z.coerce.number().int().optional(),
  WEBHOOK_HOST: z.string().default('127.0.0.1'),
  WEBHOOK_TOKEN: z.string().min(16).optional(),
  SESSION_SECRET: z.string().min(32).default('dev-only-session-secret-change-me-please-0000'),
  SESSION_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: bool.default(false),

  DATA_DIR: z.string().default('data'),

  GATE_FACE_PYTHON: z.string().default('python'),
  GATE_FACE_PYTHON_PATH: z.string().default('data/face-runtime/python'),
  FACE_TEMPLATE_KEY: z.string().regex(/^[a-f0-9]{64}$/i, 'Use a random 32-byte key encoded as 64 hex characters').optional(),
  GATE_FACE_THRESHOLD: z.coerce.number().min(0.4).max(0.95).default(0.5),
  GATE_FACE_MARGIN: z.coerce.number().min(0.03).max(0.3).default(0.08),
  GATE_CONTROLLER_MODE: z.enum(['simulated', 'http']).default('simulated'),
  GATE_CONTROLLER_URL: z.string().url().optional(),
  GATE_CONTROLLER_TOKEN: z.string().min(24).optional(),
  GATE_CONTROLLER_GATE_ID: z.string().max(64).optional(),
  GATE_CONTROLLER_ZONE_ID: z.coerce.number().int().positive().optional(),
  GATE_STATION_OPERATOR_ID: z.string().min(2).max(32).optional(),
  GATE_PULSE_MS: z.coerce.number().int().min(250).max(5000).default(1000),

  CAMERA_ID: z.string().default('cam-1'),
  CAMERA_LABEL: z.string().default('Approach camera 1'),
  /** Video file path, /dev/videoN, or rtsp:// URL. */
  CAMERA_SOURCE: z.string().default('fixtures/synthetic-crossing.mp4'),
  /** Loop a file source (replay demo). */
  CAMERA_LOOP: bool.default(true),
  /** Read a file source at native frame rate (like a live camera). */
  CAMERA_REALTIME: bool.default(true),
  /** Extra ffmpeg input args, e.g. "-f v4l2 -video_size 1280x720". */
  CAMERA_INPUT_ARGS: z.string().default(''),
  ZONES_FILE: z.string().default('config/zones.json'),

  DETECTOR: z.enum(['onnx', 'scripted']).default('onnx'),
  MODEL_MANIFEST: z.string().default('models/yolo11n.manifest.json'),
  SCRIPTED_TIMELINE: z.string().default('fixtures/synthetic-crossing.timeline.json'),
  ORT_THREADS: z.coerce.number().int().min(0).default(0),

  TARGET_CLASS: z.string().default('elephant'),
  SAMPLE_FPS: z.coerce.number().positive().default(5),
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),
  CONSECUTIVE_FRAMES: z.coerce.number().int().positive().default(3),
  CLEAR_SECONDS: z.coerce.number().positive().default(10),
  /** A gap between processed frames longer than this resets streaks and clear timers. */
  MAX_FRAME_GAP_MS: z.coerce.number().int().positive().default(1500),
  /** Dashboard shows the feed as stale (zone status UNKNOWN) after this many seconds without a frame. */
  STALE_FEED_SECONDS: z.coerce.number().positive().default(5),

  /** africastalking = real Africa's Talking API (sandbox or live); mock = labelled simulation, nothing leaves the laptop. */
  SMS_PROVIDER: z.enum(['mock', 'africastalking']).default('africastalking'),
  /** Voice: africastalking needs AT_VOICE_NUMBER (a provisioned AT number); otherwise calls are simulated and labelled. */
  VOICE_PROVIDER: z.enum(['simulated', 'africastalking']).default('simulated'),
  AT_VOICE_NUMBER: z.string().optional(),
  /** Public base URL of the webhook listener (used in voice GetDigits callbacks). */
  PUBLIC_WEBHOOK_URL: z.string().url().optional(),
  /** Number shown to tourists as the emergency line. Verify with the park/lodge before use. */
  EMERGENCY_LINE: z.string().default('112'),
  /** Run the scripted camera simulator that produces labelled SIMULATED detections. */
  SIMULATOR_ENABLED: bool.default(true),
  SIMULATOR_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  /** "alias:+2557XXXXXXXX" — approved duty/test numbers only. */
  SMS_RECIPIENTS: z.string().default('duty:+255700000000'),
  /** Queued SMS whose event was last seen longer ago than this are expired, not sent. */
  SMS_FRESHNESS_SECONDS: z.coerce.number().positive().default(300),
  /** Upper bound on the retry backoff for transient SMS failures. */
  SMS_RETRY_CAP_SECONDS: z.coerce.number().positive().default(60),
  SMS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  SMS_TEST_MODE: bool.default(true),
  AT_USERNAME: z.string().default('sandbox'),
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),
  AT_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),

  USSD_ENABLED: bool.default(false),
  /** "+2557XXXXXXXX:operatorId" — phones allowed to use the USSD menu. */
  USSD_ALLOWLIST: z.string().default(''),

  /** Show demo-only controls (simulated uplink outage for the mock SMS adapter). */
  DEMO_CONTROLS: bool.default(true),
  /** Lodge-local time zone for SMS/USSD/dashboard times. */
  TIMEZONE: z.string().default('Africa/Dar_es_Salaam'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Env {
  recipients: { alias: string; number: string }[];
  ussdAllowlist: Map<string, string>;
}

export function demoNotice(cfg: AppConfig): string | null {
  const modes = [
    cfg.DETECTOR === 'scripted' || cfg.SIMULATOR_ENABLED ? 'simulated wildlife detections' : null,
    cfg.SMS_PROVIDER === 'mock' ? 'simulated SMS' : null,
    cfg.VOICE_PROVIDER === 'simulated' ? 'simulated calls' : null,
    cfg.GATE_CONTROLLER_MODE === 'simulated' ? 'simulated gate' : null,
  ].filter(Boolean);
  return modes.length ? `Demo environment — ${modes.join(', ')}.` : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty KEY= in .env means "not set", not an empty value.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.VOICE_PROVIDER === 'africastalking' && (!cfg.AT_API_KEY || !cfg.AT_VOICE_NUMBER)) {
    throw new Error('VOICE_PROVIDER=africastalking requires AT_API_KEY and AT_VOICE_NUMBER');
  }
  if (cfg.USSD_ENABLED && !cfg.WEBHOOK_TOKEN) {
    throw new Error('USSD_ENABLED=true requires WEBHOOK_TOKEN');
  }
  if (cfg.GATE_CONTROLLER_MODE === 'http') {
    if (!cfg.GATE_CONTROLLER_URL || !cfg.GATE_CONTROLLER_TOKEN || !cfg.GATE_CONTROLLER_GATE_ID || !cfg.GATE_CONTROLLER_ZONE_ID || !cfg.GATE_STATION_OPERATOR_ID) {
      throw new Error('HTTP gate control requires a controller URL, token, gate ID, zone ID and station operator ID');
    }
    if (!cfg.FACE_TEMPLATE_KEY || !cfg.COOKIE_SECURE || cfg.SESSION_SECRET.startsWith('dev-only-') || cfg.SESSION_SECRET.startsWith('change-me')) {
      throw new Error('Physical gate mode requires FACE_TEMPLATE_KEY, a private SESSION_SECRET and COOKIE_SECURE=true behind HTTPS');
    }
    const url = new URL(cfg.GATE_CONTROLLER_URL);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
      throw new Error('Gate controller URLs must use HTTPS (HTTP is allowed only on loopback), without embedded credentials or query strings');
    }
  }
  return {
    ...cfg,
    recipients: pairList(cfg.SMS_RECIPIENTS).map(({ alias, value }) => ({ alias, number: value })),
    ussdAllowlist: new Map(pairList(cfg.USSD_ALLOWLIST).map(({ alias, value }) => [alias, value])),
  };
}
