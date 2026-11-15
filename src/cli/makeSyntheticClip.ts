/**
 * Render a SIMULATED crossing clip from the scripted timeline, so the full
 * pipeline (capture → zone rule → alert → SMS → dashboard) can be demoed and
 * tested without a real elephant video. A grey block stands in for the animal;
 * the frame is stamped "SIMULATED". Use DETECTOR=scripted with this clip — a
 * real model will (correctly) not see an elephant in it.
 *
 *   npm run fixtures:synthetic [-- --timeline fixtures/synthetic-crossing.timeline.json --out fixtures/synthetic-crossing.mp4]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadTimeline, type Timeline } from '../vision/scriptedDetector.js';
import { flag, parseArgs } from './args.js';

const execFileAsync = promisify(execFile);

/** Nested ffmpeg if() expression for a piecewise-linear coordinate (pixels). Hidden segments move off-screen. */
function piecewise(timeline: Timeline, index: 0 | 1, scale: number): string {
  const kfs = timeline.keyframes;
  const OFF = '-10000';
  let expr = kfs.at(-1)!.box ? (kfs.at(-1)!.box![index] * scale).toFixed(1) : OFF;
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    let seg: string;
    if (!a.box) seg = OFF;
    else if (!b.box) seg = (a.box[index] * scale).toFixed(1);
    else {
      const va = a.box[index] * scale;
      const vb = b.box[index] * scale;
      seg = `(${va.toFixed(1)}+(${(vb - va).toFixed(1)})*(t-${a.t})/${(b.t - a.t).toFixed(3)})`;
    }
    expr = `if(lt(t,${b.t}),${seg},${expr})`;
  }
  const first = kfs[0]!;
  return first.t > 0 ? `if(lt(t,${first.t}),${OFF},${expr})` : expr;
}

const { flags } = parseArgs();
const timelinePath = flag(flags, 'timeline') ?? 'fixtures/synthetic-crossing.timeline.json';
const out = flag(flags, 'out') ?? 'fixtures/synthetic-crossing.mp4';
const fps = Number(flag(flags, 'fps') ?? 10);
const tl = await loadTimeline(timelinePath);
const W = tl.width;
const H = tl.height;
const firstBox = tl.keyframes.find((k) => k.box)!.box!;
const bw = Math.round((firstBox[2] - firstBox[0]) * W);
const bh = Math.round((firstBox[3] - firstBox[1]) * H);

const scene = [
  // sandy guest path roughly under the configured zone
  `drawbox=x=${Math.round(0.3 * W)}:y=${Math.round(0.55 * H)}:w=${Math.round(0.4 * W)}:h=${Math.round(0.45 * H)}:color=0xb59b6a@0.9:t=fill`,
];
const label = `drawtext=text='SIMULATED CROSSING - not real footage':x=12:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;

function args(withText: boolean): string[] {
  const filter =
    `[0:v]${scene.join(',')}[bg];` +
    `[bg][1:v]overlay=x='${piecewise(tl, 0, W)}':y='${piecewise(tl, 1, H)}':eval=frame` +
    (withText ? `,${label}` : '') +
    '[v]';
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=0x5f6b34:s=${W}x${H}:r=${fps}:d=${tl.durationSeconds}`,
    '-f', 'lavfi', '-i', `color=c=0x6e6a66:s=${bw}x${bh}:r=${fps}:d=${tl.durationSeconds}`,
    '-filter_complex', filter,
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '28', '-movflags', '+faststart',
    out,
  ];
}

try {
  await execFileAsync('ffmpeg', args(true));
} catch {
  // drawtext needs fontconfig/freetype; fall back to an unlabelled clip (the dashboard still says SIMULATED).
  await execFileAsync('ffmpeg', args(false));
}
console.log(`Wrote ${out} (${tl.durationSeconds}s @ ${fps} fps). Run with DETECTOR=scripted CAMERA_SOURCE=${out}`);
