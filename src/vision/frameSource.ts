import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** How a source frame was resized + padded into the square model input. */
export interface Letterbox {
  size: number;
  srcW: number;
  srcH: number;
  scaledW: number;
  scaledH: number;
  padX: number;
  padY: number;
  scale: number;
}

export interface Frame {
  /** RGB24, size*size*3 bytes, letterboxed. */
  data: Buffer;
  /** Sequence number of frames emitted by ffmpeg (includes frames later dropped). */
  seq: number;
  /** Wall-clock receipt time (ms since epoch). */
  receivedAt: number;
  /** Position in the source in ms, derived from seq / fps (meaningful for files). */
  mediaMs: number;
  letterbox: Letterbox;
}

export type SourceKind = 'file' | 'device' | 'stream';

export interface FrameSourceOptions {
  source: string;
  fps: number;
  size: number;
  loop: boolean;
  realtime: boolean;
  extraInputArgs?: string[];
  ffmpegPath?: string;
  ffprobePath?: string;
}

export function sourceKind(source: string): SourceKind {
  if (/^(rtsp|rtmp|http|https|udp|tcp|srt):\/\//i.test(source)) return 'stream';
  if (source.startsWith('/dev/') || /^video=/.test(source)) return 'device';
  return 'file';
}

export function computeLetterbox(srcW: number, srcH: number, size: number): Letterbox {
  const scale = Math.min(size / srcW, size / srcH);
  const scaledW = Math.max(2, Math.round(srcW * scale));
  const scaledH = Math.max(2, Math.round(srcH * scale));
  return {
    size,
    srcW,
    srcH,
    scaledW,
    scaledH,
    padX: Math.floor((size - scaledW) / 2),
    padY: Math.floor((size - scaledH) / 2),
    scale,
  };
}

export interface ProbeResult {
  width: number;
  height: number;
  durationMs: number | null;
}

export async function probe(source: string, extraInputArgs: string[] = [], ffprobePath = 'ffprobe'): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      '-v', 'error',
      ...extraInputArgs,
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
      '-of', 'json',
      source,
    ],
    { timeout: 15_000 },
  );
  const info = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number; side_data_list?: { rotation?: number }[] }[];
    format?: { duration?: string };
  };
  const stream = info.streams?.[0];
  if (!stream?.width || !stream.height) throw new Error(`ffprobe found no video stream in ${source}`);
  // ffmpeg auto-rotates; swap dims for 90°/270° rotation metadata so the letterbox matches.
  const rotation = Math.abs(stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) % 180;
  const [width, height] = rotation === 90 ? [stream.height, stream.width] : [stream.width, stream.height];
  const duration = info.format?.duration ? Number.parseFloat(info.format.duration) : NaN;
  return { width, height, durationMs: Number.isFinite(duration) ? duration * 1000 : null };
}

export function ffmpegArgs(opts: FrameSourceOptions, lb: Letterbox): string[] {
  const kind = sourceKind(opts.source);
  const input: string[] = [];
  if (kind === 'file') {
    if (opts.realtime) input.push('-re');
    if (opts.loop) input.push('-stream_loop', '-1');
  } else if (kind === 'stream' && opts.source.startsWith('rtsp')) {
    input.push('-rtsp_transport', 'tcp');
  } else if (kind === 'device' && process.platform === 'linux' && !opts.extraInputArgs?.includes('-f')) {
    input.push('-f', 'v4l2');
  }
  input.push(...(opts.extraInputArgs ?? []));
  const filter = [
    `fps=${opts.fps}`,
    `scale=${lb.scaledW}:${lb.scaledH}`,
    `pad=${lb.size}:${lb.size}:${lb.padX}:${lb.padY}:color=0x727272`,
  ].join(',');
  return ['-hide_banner', '-loglevel', 'error', ...input, '-i', opts.source, '-an', '-vf', filter, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'];
}

/**
 * Yields letterboxed RGB frames from ffmpeg. Consumers that iterate slower than
 * ffmpeg produces apply backpressure (used for offline evaluation). For live use,
 * wrap with {@link LatestFrameSlot} so old frames are dropped instead of queued.
 */
export async function* ffmpegFrames(opts: FrameSourceOptions, signal?: AbortSignal): AsyncGenerator<Frame> {
  const extra = opts.extraInputArgs ?? [];
  const info = await probe(opts.source, sourceKind(opts.source) === 'file' ? [] : extra, opts.ffprobePath);
  const lb = computeLetterbox(info.width, info.height, opts.size);
  const frameBytes = opts.size * opts.size * 3;
  const child = spawn(opts.ffmpegPath ?? 'ffmpeg', ffmpegArgs(opts, lb), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const onAbort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', onAbort, { once: true });

  let seq = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= frameBytes) {
        const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
        const data = Buffer.from(all.subarray(0, frameBytes)); // copy: decouple from the stream buffer
        const rest = all.subarray(frameBytes);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
        yield { data, seq, receivedAt: Date.now(), mediaMs: (seq * 1000) / opts.fps, letterbox: lb };
        seq += 1;
      }
    }
    const code = await exited;
    if (code !== 0 && !signal?.aborted) {
      throw new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || 'no stderr'}`);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

/**
 * Holds only the newest frame. If inference falls behind, older frames are
 * overwritten (counted as dropped) so latency never builds up.
 */
export class LatestFrameSlot {
  private frame: Frame | null = null;
  private waiter: ((f: Frame) => void) | null = null;
  dropped = 0;
  received = 0;
  lastReceivedAt = 0;

  put(frame: Frame): void {
    this.received += 1;
    this.lastReceivedAt = frame.receivedAt;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(frame);
      return;
    }
    if (this.frame) this.dropped += 1;
    this.frame = frame;
  }

  /** Resolves with the newest frame, or null after timeoutMs with no frame. */
  take(timeoutMs: number): Promise<Frame | null> {
    if (this.frame) {
      const f = this.frame;
      this.frame = null;
      return Promise.resolve(f);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = (f) => {
        clearTimeout(timer);
        resolve(f);
      };
    });
  }
}
