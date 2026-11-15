# Safe Savannah AI

Hackathon MVP. One fixed camera watches one marked approach to a safari camp's guest area. When an elephant's
feet enter the marked zone, the system opens **one** reviewable alert and sends **one** SMS to the duty phone.
The officer acknowledges it, checks what is happening, and coordinates any response over the existing radio or
phone. Every step is logged against the same incident.

Built with **TypeScript (Node 22)** and **PostgreSQL**.

> This is a workflow prototype. It does not show how often elephants approach, it does not prove that a camera
> gives earlier warning in the field, and it never tells anyone a path is safe. When a camera misses an
> elephant, that is not proof the path is clear.


## How it works

```
camera / replay ──ffmpeg──▶ vision worker ──▶ zone rule ──▶ PostgreSQL ──▶ dashboard (polls every 2 s)
  (5 fps, 640² letterbox)   YOLO11n ONNX     (feet in       events          acknowledge, handoff,
                            "elephant"        polygon ×3)   + SMS outbox     close / false alert
                                                              │ LISTEN/NOTIFY
                                                              ▼
                                                        notifier ──▶ Africa's Talking SMS (or mock)
```

Three processes share one PostgreSQL database. `npm run dev` / `npm start` runs all three under a small
supervisor, so model inference never blocks the dashboard.

| Process | What it does |
|---|---|
| `vision` | ffmpeg decodes the source at `SAMPLE_FPS` into a letterboxed 640×640 frame. Only the newest frame is kept: if inference falls behind, old frames are dropped and counted, so lag does not build up. Runs the detector, applies the zone rule, writes the alert and SMS job **in one transaction**, refreshes `last_seen_at`, and writes a camera heartbeat and an annotated live frame. |
| `notifier` | Transactional-outbox worker. It wakes on `NOTIFY` from new alerts and polls for retries. It uses `FOR UPDATE SKIP LOCKED`, retries known transient failures with capped backoff, marks ambiguous outcomes as `unknown`, and expires stale jobs. |
| `api` | Fastify server. It serves the login, the dashboard, the JSON API, authenticated snapshots and the live frame, plus the provider webhooks (optionally on a separate webhook-only port). |

### Zone rule (`src/domain/zoneMonitor.ts`)

- A detection counts only when its label is `elephant` (resolved **by label** from the model manifest), its
  confidence is ≥ `CONFIDENCE_THRESHOLD` (0.45), and the **bottom-centre** of its box falls inside the zone
  polygon. The bottom-centre is a rough proxy for where the feet touch the ground. It is not a distance, GPS
  fix or track.
- `CONSECUTIVE_FRAMES` (3) in-zone frames in a row open an alert. The `first_seen_at` is the first frame of
  that streak.
- Each camera + zone has at most one active alert. A partial unique index in PostgreSQL enforces this.
  Further detections refresh `last_seen_at` but send no further SMS.
- **Rearming needs both** `CLEAR_SECONDS` (10) of valid frames with no in-zone detection **and** an operator
  closing the alert. A gap longer than `MAX_FRAME_GAP_MS` between frames is an outage. An outage resets the
  streak and the clear timer: an outage is *unknown*, never *clear*.
- The dashboard shows a zone as **UNKNOWN** whenever its camera has not delivered a frame within
  `STALE_FEED_SECONDS`.

These numbers are tuning defaults, not validated safety limits.

### Distinctions the UI keeps separate

| What the screen says | What it does **not** mean |
|---|---|
| SMS *accepted by provider* | that it was delivered |
| SMS *delivered* (delivery report) | that anyone read it |
| *Acknowledged by X* | that anyone has responded; log handoffs for that |
| Zone *armed — watching* | that the zone is clear or safe |
| SMS *unknown* (timeout / crash mid-send) | that it failed; check the handset before you press Resend |

## Quick start

Requirements: Node ≥ 22, PostgreSQL ≥ 14 (or Docker), `ffmpeg`/`ffprobe` on `PATH`.

```bash
npm install
```

```bash
docker compose up -d postgres     # or point DATABASE_URL at your own PostgreSQL
```

```bash
cp .env.example .env
```

```bash
npm run migrate
```

```bash
npm run operator:add -- --id duty1 --name "Asha (duty manager)" --pin 4821
```

### A. Simulated crossing (no model needed)

```bash
npm run fixtures:synthetic        # renders fixtures/synthetic-crossing.mp4 from the timeline
```

```bash
DETECTOR=scripted npm run dev
```

Open http://127.0.0.1:8080 and sign in. A grey block grazes outside the zone, walks onto *Guest path A* about
11 s into the clip, and leaves. The clip loops every 40 s. Events from this mode are labelled **SIMULATED** on
the dashboard and in the SMS text.

### B. Real inference (the judged demo)

1. Export and pin the model (Python venv, one time):

   ```bash
   pip install ultralytics onnx onnxslim
   ```

   ```bash
   python scripts/export_model.py --weights yolo11n.pt --out models
   ```

   ```bash
   npm run model:check               # verifies the SHA-256 pin and that "elephant" exists by label
   ```

   Ultralytics YOLO weights are **AGPL-3.0**. Review that before sharing or deploying the model or a service
   built on it. Cache the weights before demo day.

2. Get a legally reusable clip from a **fixed** viewpoint. For a quick check, the helper downloads a
   CC-licensed Commons video and saves its attribution next to it in `fixtures/local/` (git-ignored):

   ```bash
   scripts/fetch-commons-clip.sh "Mum_and_baby_Elephant_walking_toward_us..webm" 96 40 elephants-near
   ```

   That example clip (CC BY 3.0) is filmed from a vehicle, not a fixed camera. It checks that real inference
   works, but because the frame moves it is **not** a valid boundary-crossing test. For the crossing test,
   use footage from a fixed camera. Use Snapshot Serengeti stills for classification checks only.

3. Draw the zone for that view in `config/zones.json` (normalized `[x, y]` vertices, origin top-left).

4. Run:

   ```bash
   DETECTOR=onnx CAMERA_SOURCE=fixtures/local/elephants-near.mp4 npm run dev
   ```

   For a USB camera, set `CAMERA_SOURCE=/dev/video0`. Measured on the development container (CPU only):
   YOLO11n at 640² ran at about 50–67 ms per frame, which sustained 5 fps with no dropped frames. Measure
   again on your own laptop.

### C. Africa's Talking SMS

Start in the sandbox and use its simulator:

```bash
SMS_PROVIDER=africastalking AT_ENVIRONMENT=sandbox AT_USERNAME=sandbox AT_API_KEY=... \
SMS_RECIPIENTS=duty:+2557XXXXXXXX npm run dev
```

The message reads: `Safe Savannah TEST SS-014. Possible elephant at Guest path A. Check the duty dashboard and
follow your radio procedure.` It contains no coordinates. Send only to approved duty/test numbers, and never
contact real emergency services from a demo.

**Delivery reports (optional):** set `WEBHOOK_TOKEN` and `WEBHOOK_PORT`. Expose **only** that port over an
HTTPS tunnel, and register `https://<tunnel>/webhooks/sms-status?token=<WEBHOOK_TOKEN>` with Africa's Talking.
Delivery reports update notification state only. They never change who owns the incident.

**USSD (stretch goal):** set `USSD_ENABLED=true` and `USSD_ALLOWLIST=+2557XXXXXXXX:duty1`, then point the
callback to `/webhooks/ussd?token=...`. The menu is: `1` lists active alerts; `2` → alert number → review →
`1` to confirm the acknowledgement. Nothing is written before that confirmation. USSD cannot push alerts.

## Judge demo script

1. Show the camera view: the elephant is **outside** the dashed polygon, so no alert.
2. The elephant crosses. After about 3 frames, the **SS-0xx** card opens, the mock (or sandbox) SMS shows as
   *accepted by provider*, and the snapshot shows the triggering box.
3. Click **Acknowledge — I take ownership**, then **Log handoff** (Radio, "Guide Juma ch.3, guests held at
   lodge").
4. Click **DEMO: simulate SMS uplink → down**. Let the clip loop: the camera still detects, the alert still
   opens on the local dashboard, and the SMS shows *Queued — provider unreachable, retrying at …*. Switch the
   uplink back **up** and the queued SMS goes out. For a real outage, unplug the network instead. Messages
   older than `SMS_FRESHNESS_SECONDS` are marked **expired**, not sent late.
5. Close the incident with what was verified. The zone stays *awaiting clear* until it has been empty for 10 s.

## Acceptance tests

```bash
npm test
```

The integration tests need PostgreSQL at `TEST_DATABASE_URL` (default
`postgres://postgres@127.0.0.1:5432/safe_savannah_test`). The URL must contain "test", because the schema is
dropped. Tests that need a database or ffmpeg are skipped when either is unavailable.

| Plan requirement | Covered by |
|---|---|
| Outside-zone detections open nothing; 3 consecutive in-zone frames open exactly one alert | `test/zoneMonitor.test.ts`, `test/pipeline.test.ts` |
| Rearming needs a 10 s clear **and** operator close; an outage is not clear time; restart doesn't duplicate | `test/zoneMonitor.test.ts` |
| One event + one initial SMS job, written atomically; DB enforces one active alert per zone | `test/store.test.ts` |
| Acknowledgement attributed, timestamped and idempotent (also under concurrency) | `test/store.test.ts`, `test/api.test.ts` |
| Transient retry with backoff, ambiguous → `unknown`, crash mid-send → `unknown`, stale → `expired`, closed → `cancelled`, jobs survive restart | `test/outbox.test.ts` |
| Delivery reports never change incident ownership; out-of-order reports can't regress state | `test/outbox.test.ts`, `test/api.test.ts` |
| Camera not live → zone shown UNKNOWN | `test/api.test.ts` |
| Africa's Talking request/response semantics | `test/notify.test.ts` |
| USSD allowlist and confirm-before-write | `test/api.test.ts` |

### Per-clip evaluation and timing

```bash
npm run eval -- --annotations fixtures/local/inside.json --annotations fixtures/local/outside.json
```

Each annotation file names a clip, a zone and the crossing times you annotated by hand. Use `[]` for a clip
that should raise no alert. The command runs the real detector and zone rule over every sampled frame and
reports alerts, misses and false alerts **per clip**. That is not a claim about field accuracy. Include
outside-zone clips, empty clips, lookalikes (vehicles, cattle, rocks), and at least one clip with difficult
lighting or occlusion.

```bash
npm run report:timings
```

This prints, for each alert: first in-zone frame → stored event, event → provider acceptance / delivery, and
event → acknowledgement. Subtract your annotated crossing time from `first_seen` to get crossing → event.
Report the hardware and network along with the numbers. Do not turn demo numbers into claims about injuries
avoided or response-time percentages.

### Outage drills

Test each of these on its own:

- **Uplink:** unplug the network, or use the demo toggle. Detection, storage and the dashboard keep working,
  and SMS jobs queue. A remote officer cannot get an SMS while the laptop can't reach the provider, and the
  recipient also needs mobile coverage.
- **Camera:** unplug it or point to a bad source. The feed shows **STALE/OFFLINE**, the zone shows
  **UNKNOWN**, the ffmpeg error is shown, and the worker keeps trying to reconnect.
- **Laptop:** the radio procedure must keep working without it.

## Project layout

```
src/domain      zone rule, geometry, zone config, SS-### refs  (pure, unit-tested)
src/vision      ffmpeg frame source, YOLO decode + ONNX detector, scripted detector, annotation, worker
src/store       PostgreSQL access: events/actions, operators, camera + zone status, dashboard query
src/notify      outbox worker, Africa's Talking adapter, mock adapter, message text
src/api         Fastify server, pages, USSD menu
src/cli         operator:add, sim:events, fixtures:synthetic, eval, report:timings, model:check
migrations      SQL schema (applied by `npm run migrate` / on `npm run dev`)
public          dashboard JS + CSS (no build step)
```

`npm run sim:events` injects a **SYNTHETIC TEST** alert, so you can work on the dashboard and SMS path without
the vision worker.

## Before a field pilot

Go ahead only with a site partner, a named duty owner, a verified camera blind spot and the right operating
permissions. Run in shadow mode alongside the normal procedures first. Agree in advance how many false alerts
and missed detections are acceptable. Before you choose battery, solar or camera hardware, measure power draw
and night visibility. Restrict access to camera views and snapshots (they are served only to signed-in
operators and stored under `DATA_DIR`), and agree retention and maintenance with the lodge.

## References

- Africa's Talking: [country/product matrix](https://help.africastalking.com/en/articles/2727792-which-countries-are-africa-s-talking-products-in), [sandbox setup](https://help.africastalking.com/en/articles/1170660-how-do-i-get-started-on-the-africa-s-talking-sandbox)
- [Snapshot Serengeti](https://lila.science/datasets/snapshot-serengeti) (sequence labels are not reliable frame by frame: verify demo frames by hand)
- [MegaDetector scope](https://github.com/microsoft/MegaDetector/blob/main/docs/faq.md) (it detects animals, people and vehicles; it does not classify species)
- [Ultralytics COCO](https://docs.ultralytics.com/datasets/detect/coco/), [ONNX export](https://docs.ultralytics.com/integrations/onnx/)
