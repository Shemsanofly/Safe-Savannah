# Safe Savannah AI — Wildlife Monitoring & Tourist Safety

A working MVP for Tanzania's parks, lodges and tourism destinations. AI camera detections are scored by
**species, distance to geofenced safety zones and who is likely nearby**. Rangers get alerts on a live map and
coordinate responses alongside, never instead of, their radio and phone procedures. Tourists receive area alerts
and can raise an SOS from an app, a basic-phone USSD menu or a voice call. Messages go out through
**Africa's Talking**.

Built with **TypeScript (Node 22)**, **Fastify**, **PostgreSQL** and plain ES-module front-ends (no build step,
no CDN). Leaflet is served locally; only map tiles need internet.

| Interface | Who | Highlights |
|---|---|---|
| **Traveller app** `/t` | Tourists (mobile-first, English / Kiswahili) | Register trip and destination · wildlife alerts for their area with what to do · one-tap **SOS** (Medical, Dangerous wildlife, Vehicle breakdown, Personal safety) with live status: Received → Ranger responding → Resolved · share location · safety guidelines and phrases |
| **Ranger console** `/` | Rangers | **Operations map** (zones, cameras, incidents, recent detections) with a priority queue (SOS first, then risk) · status **Pending → Responding → Resolved** · radio/phone handoff log · reporter tap-to-call · wildlife detections log · **AI monitor** photo analysis · Messages with USSD/voice simulators · on-duty toggle |
| **Admin** (same console, extra screens) | Administrators | Dashboard statistics · **Safety zones** geofence editor (click to draw) · People (rangers with phone/area/on-duty, admins, tourist accounts) · Reports + CSV · settings · demo scenarios |

> Safe Savannah can only warn, never reassure. Cameras miss animals; a camera that is not live sees nothing; a
> quiet map never means an area is safe. Risk weights are transparent demo defaults to review with rangers —
> not validated safety thresholds.

## Quick start

Requirements: Node ≥ 22, PostgreSQL ≥ 14 (or Docker), `ffmpeg` on `PATH` (for the gate camera).

```bash
npm install
```

```bash
docker compose up -d postgres
```

```bash
cp .env.example .env
```

```bash
npm run seed
```

```bash
npm run dev
```

`npm run seed` is idempotent. It creates three demo destinations (Serengeti–Seronera, Ngorongoro crater rim,
Tarangire River) with safety zones and camera stations, five rangers, six tourists on current trips, and 14 days
of history. **Every seeded record is flagged `demo` and labelled "Demo" in the UI. Coordinates are approximate
and zone outlines are illustrative.**

| Open | Sign in |
|---|---|
| http://127.0.0.1:8080 (staff) | ranger `juma` / PIN `2468` (also `neema`, `baraka`, `rehema`, `saning`) · admin: your first operator, or `admin` / `1357` if the seed created one |
| http://127.0.0.1:8080/t (traveller) | `+255765000201` / PIN `1234` (also `…202`–`…206`; `…203` and `…205` use Kiswahili) |

Demo phone numbers are made up. The app **never** sends to demo people through a **live** Africa's Talking
account; in the sandbox they're useful for the simulator.

## Africa's Talking

| Channel | What it does | How it runs here |
|---|---|---|
| **SMS** | Ranger alerts (risk ≥ medium), tourist warnings in their language (risk ≥ high), SOS confirmations and status updates | Sent through the **Africa's Talking API**. With `AT_ENVIRONMENT=sandbox`, `AT_USERNAME=sandbox` and your sandbox `AT_API_KEY`, messages appear in the [AT simulator](https://simulator.africastalking.com) for the recipient's number. Nothing is faked in the web app. **Without a key, nothing is sent**: each message shows *"No Africa's Talking API key configured"* on Messages, with a Resend button for after you add the key. |
| **USSD** | Basic-phone menu: tourists request help (type → park if unregistered → confirm) or check status; ranger phones list alerts and mark "I am responding" | Callback `POST /webhooks/ussd?token=…` (needs a public HTTPS tunnel and `USSD_ENABLED=true`). The **USSD simulator** on Messages runs the same menu locally and is labelled as a simulator. |
| **Voice** | Calls on-duty rangers for critical wildlife and every SOS; inbound emergency line with a keypad menu | AT's voice sandbox is not operational, so calls are **simulated and labelled** ("no phone rang") unless `VOICE_PROVIDER=africastalking` with a provisioned `AT_VOICE_NUMBER`. Callback: `POST /webhooks/voice?token=…`. The **Voice line simulator** plays the inbound menu. |

Sandbox set-up:

1. Create an Africa's Talking account and open the sandbox app.
2. Generate an API key.
3. Put it in `.env` as `AT_API_KEY=…`, keeping `SMS_PROVIDER=africastalking`, `AT_ENVIRONMENT=sandbox` and
   `AT_USERNAME=sandbox`.
4. Restart the app.
5. Open the AT simulator with a ranger's or tourist's number, for example `+255754000101` (Juma) or
   `+255765000201` (Emma).
6. Trigger a scenario or an SOS. The SMS appears on the simulated phone.

From this development container, a request with a placeholder key reached `api.sandbox.africastalking.com`
and came back `401` (authentication). The integration is live and only needs your key.

## How risk is decided (`src/domain/risk.ts`)

- **Species danger** (0–1) comes from a table: lion 0.95, buffalo/hippo 0.9, elephant/leopard/crocodile 0.85,
  rhino 0.8, hyena 0.55, cheetah 0.35, baboon 0.3, giraffe 0.15, zebra/wildebeest 0.1, antelope 0.05.
- **Proximity**: inside a zone counts 1.0. Within the zone's alert distance the factor scales from 1.0 down to
  0.45. Beyond it there is no risk.
- **Zone sensitivity**: high 1.0, medium 0.7, low 0.35.
- **People present now**: always, daytime (06–19 lodge time), night, or rarely. Registered tourists who shared a
  location within 300 m in the last 30 minutes add a further boost.
- **Detector confidence**: below 60% the score is down-weighted and the alert asks rangers to verify.
- The thresholds give the levels: low ≥ 0.10, medium ≥ 0.28, high ≥ 0.5, critical ≥ 0.75. **A harmless species
  never rises above low, even inside a lodge.**

Every detection is logged with its reasons. Medium and above opens (or refreshes) a wildlife incident. Each
camera + zone has at most one active incident; further sightings update it, and a rise in risk level re-alerts
once.

| Level | Rangers | Tourists in the area |
|---|---|---|
| medium | SMS | In-app advisory |
| high | SMS | In-app warning + SMS |
| critical | SMS + voice call | In-app danger + SMS |
| SOS (any type) | SMS + voice call | Reporter gets confirmation + status SMS |

Tourists are told the place name (e.g. "near Riverside lodge grounds"), never exact animal coordinates.

## AI wildlife monitoring

**AI monitor** accepts a camera image or wildlife photo (JPEG/PNG/WebP, ≤ 8 MB; phones open the camera). The
detection is placed at the chosen camera station's position and passed through the same risk engine.

- **Real model:** the pinned ONNX model (YOLO11n, see `scripts/export_model.py`) runs on the uploaded photo.
  The COCO model honestly recognises **elephant, zebra and giraffe** only. Other COCO animals (cow, horse,
  dog…) are shown but **not** mapped to wildlife: a "cow" is never reported as a buffalo. Lion, buffalo, hippo,
  rhino and leopard need a wildlife-specific model. Export one with the same script and labels such as `lion`
  or `buffalo` are picked up automatically by name.
- **Simulated:** when no model is installed, or for species it can't name, staff can record a *simulated
  detection* of a chosen species. It is stored as `analysis = simulated` and labelled **Simulated** everywhere.
- **Camera simulator:** a background worker feeds random **simulated** sightings from demo camera stations
  every `SIMULATOR_INTERVAL_SECONDS`. Admins can pause it or run named **demo scenarios** from Operations:
  lion near camp, elephant in lodge, buffalo on trail, hippo near picnic site, giraffe through lodge (stays
  low), zebra on road, elephant far away (no risk).

Simulated detections, real model detections, uploads and demo history are each labelled differently on the
map, the incident pages, Detections, the Dashboard (which states the simulated/real split) and in every SMS
("TEST … (SIMULATED)").

## Security and roles

| | Tourist | Ranger | Admin |
|---|---|---|---|
| Own trip, alerts for own area, SOS, status | ✓ | | |
| Map, incidents, detections, AI monitor, messages, simulators, set own on-duty | | ✓ | ✓ |
| Respond / resolve / log handoffs, resend messages | | ✓ | ✓ |
| Zones, people, tourist accounts, CSV export, scenarios, technical settings | | | ✓ |

- Separate signed, httpOnly, SameSite=strict cookies for staff and tourists.
- PINs are hashed with scrypt.
- A PIN reset, role change or deactivation ends the person's sessions.
- Every permission is enforced on the server.
- Pages use a strict CSP (map tiles are the only external origin).
- Snapshots and uploaded photos are served only to signed-in staff.
- The settings page never shows credentials.

## Platform API (selected)

| Route | Who | Purpose |
|---|---|---|
| `POST /api/tourist/register` · `login` · `logout` | public | Traveller accounts (phone + PIN) |
| `GET/PATCH /api/tourist/me`, `POST /api/tourist/location`, `POST /api/tourist/sos` | tourist | Feed (alerts, own SOS with status), trip, location, SOS (a double press within 2 min returns the same SOS) |
| `GET /api/map?area=` | staff | Zones, cameras, active incidents, recent detections |
| `POST /api/incidents/:id/status` | staff | `responding` or `resolved` (`outcome: handled \| false_alarm`, note required); notifies the SOS reporter |
| `GET /api/detections`, `GET /api/detections/:id/image` | staff | Detection log and photos |
| `GET /api/ai/status`, `POST /api/ai/analyze` (multipart) | staff | Model capabilities; analyse a photo (`mode=model\|simulated`) |
| `GET /api/comms`, `POST /api/sim/ussd`, `POST /api/sim/voice` | staff | Outbox across SMS/voice, USSD/voice simulators |
| `GET/POST/PATCH /api/zones` | staff read, admin write | Geofences (polygon `[[lat,lng],…]`, kind, sensitivity, occupancy, alert distance) |
| `GET /api/tourists`, `PATCH /api/tourists/:id`, `POST /api/rangers`, `PATCH /api/rangers/:id/contact` | admin | People management |
| `GET /api/stats?days=`, `POST /api/sim/scenario`, `POST /api/sim/state` | staff / admin | Statistics, demo scenarios, pause simulator |
| `POST /webhooks/sms-status`, `/webhooks/ussd`, `/webhooks/voice` | provider (token) | Africa's Talking callbacks |

## Tests

```bash
npm test
```

94 tests. `test/platform.test.ts` covers:

- geofencing and the risk engine (species, distance, occupancy, confidence, harmless species);
- detection → incident → ranger/tourist SMS and voice (atomic, deduplicated, escalation);
- that demo people are never messaged through a live account;
- SOS de-duplication, plus the USSD and voice menus;
- the tourist API end to end, including ranger status updates reaching the tourist;
- admin-only permissions, geofence validation and AI upload modes;
- that scenarios are labelled simulated;
- that the Africa's Talking adapter sends nothing without a key.

The earlier suites still cover the gate camera, the outbox and the dashboard API.

---

# Gate camera module (original MVP)

The first module is still part of the platform. One fixed camera watches a marked image-space zone. Its alerts
appear as **Gate camera** incidents on the map (placed at the camera station's position) and in the incident
list, and they use the same outbox. The details below describe that module.

## How it works

```
camera / replay ──ffmpeg──▶ vision worker ──▶ zone rule ──▶ PostgreSQL ──▶ dashboard (polls every 2.5 s)
  (5 fps, 640² letterbox)   YOLO11n ONNX     (feet in       events          acknowledge, handoff,
                            "elephant"        polygon ×3)   + SMS outbox     close / false alert
                                                              │ LISTEN/NOTIFY
                                                              ▼
                                                        notifier ──▶ Africa's Talking SMS (or mock)
```

Three processes share one PostgreSQL database. `npm run dev` / `npm start` runs all three under a small
admin, so model inference never blocks the dashboard.

| Process | What it does |
|---|---|
| `vision` | ffmpeg decodes the source at `SAMPLE_FPS` into a letterboxed 640×640 frame. Only the newest frame is kept: if inference falls behind, old frames are dropped and counted, so lag does not build up. Runs the detector, applies the zone rule, writes the alert and SMS job **in one transaction**, refreshes `last_seen_at`, and writes a camera heartbeat and an annotated live frame. |
| `notifier` | Transactional-outbox worker. It wakes on `NOTIFY` from new alerts and polls for retries. It uses `FOR UPDATE SKIP LOCKED`, retries known transient failures with capped backoff, marks ambiguous outcomes as `unknown`, and expires stale jobs. |
| `api` | Fastify server. It serves the login, the dashboard, the JSON API, authenticated snapshots and the live frame, plus the provider webhooks (optionally on a separate webhook-only port). Pages are sent with a strict Content-Security-Policy (no inline scripts, same-origin only), and nothing is loaded from a CDN, so the dashboard works on an offline lodge network. |

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

## Gate camera set-up

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

The first operator you create is a **admin**. Admins add further operators from **Settings**, or
with `--role ranger|admin` on the same command.

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

## Using the dashboard

Open http://127.0.0.1:8080 and sign in. The top bar always shows how many incidents need acknowledgement, the
camera state, whether the footage is simulated, the SMS mode and when the screen last updated. If the browser
loses the server, a red banner says so, and the last known status is greyed out and stamped "Status as of …".

| Screen | What it is for |
|---|---|
| **Overview** | Incidents needing action (with one-click acknowledge), the live camera with zone and detection overlays, zone status and SMS health. On narrow screens an urgent incident is shown above the camera. |
| **Incidents** | Search (SS-number, zone, ranger name or note text), filter by status, detection source, zone, SMS state, owner and date, then sort and page through results. Filters are kept in the URL and stay put while results refresh. Admins can export the current filter to CSV. |
| **Incident detail** | Snapshot, detection facts, owner and time to acknowledge. Tabs for **Log handoff** (radio, phone, in person), **Close incident**, **False alert** (with a reason) and **Add note**. Also shows SMS history with every send attempt and a merged, chronological activity log. |
| **History & reports** | Counts, median time to acknowledge or close, and SMS outcomes for a date range in lodge time. Includes a per-day chart with a table view, and the same range in the incident list or CSV. Empty ranges say so and show no averages. |
| **SMS notifications** | Every outbox message with plain-language state and what to do about failures. A separate **Mock outbox** lists messages that never left the laptop, and admins get a demo uplink switch. |
| **Settings** | A read-only view of the camera, detection rule, time zone and SMS set-up. Phone numbers are masked and no credentials are ever sent to the browser. Admins also see technical details and manage operators: add, change role, deactivate, reset PIN. |
| **Guide** | The five-step workflow and a glossary for every status label. |

The camera panel shows one of four states: **Live**, **Reconnecting** (the worker is retrying a failed
source), **Stale** (connected but no new frames) or **Offline** (the worker is not reporting). Anything other
than Live shows the zone as **UNKNOWN**. Feed controls work as follows:

- **Pause view** freezes the picture while detection carries on.
- **Zone** and **Detections** toggle the overlays.
- **Refresh** loads the newest frame.
- **Full screen** shows the feed full screen.

Keyboard users get a skip link, visible amber focus rings, and arrow-key tabs on incidents. Moving to a new
screen puts focus on its heading. The layout adapts to phones (bottom tab bar), tablets (icon rail) and
desktops, and it respects reduced-motion settings.

### Roles

| | Ranger | Admin |
|---|---|---|
| View everything, acknowledge, log handoffs and notes, close, mark false alerts, request SMS resend | ✓ | ✓ |
| Export incidents to CSV | | ✓ |
| Manage operators (add, change role, deactivate, reset PIN) | | ✓ |
| See technical settings and raw camera errors; use demo controls | | ✓ |

The server enforces every one of these permissions. Changing someone's role, deactivating them or resetting
their PIN ends their existing sessions. You cannot deactivate or demote yourself, and the last active
admin cannot be removed.

### HTTP API (signed-in session required)

| Route | Purpose |
|---|---|
| `GET /api/overview` | Counts, camera state (live/reconnecting/stale/offline), zones with outlines, active incidents and SMS health |
| `GET /api/incidents` | Search, filter, sort and page (`q, status, source, zone, sms, owner, from, to, sort, order, page, pageSize`) |
| `GET /api/incidents/:id` | Detail with actions, SMS jobs with their attempt log, and a merged timeline |
| `GET /api/incidents/export.csv` | CSV of the same filters (admins). Times are UTC; cells that could run as spreadsheet formulas are neutralised |
| `GET /api/reports/summary?from&to&source` | Summary figures computed from stored records, by day in lodge time |
| `GET /api/notifications` | Outbox jobs by state group, plus the mock outbox |
| `GET /api/settings` | Configuration view with no secrets; technical section for admins |
| `GET/POST/PATCH /api/operators…` | Operator management (admins) |
| `GET /api/cameras/:id/live.jpg`, `live.json` | Latest clean frame plus detection metadata for client-drawn overlays |
| `POST /api/events/:id/acknowledge`, `/actions`, `POST /api/notifications/:id/resend` | Incident workflow (unchanged) |

## Judge demo script

1. Show the camera view: the elephant is **outside** the dashed polygon, so no alert.
2. The elephant crosses. After about 3 frames, the **SS-0xx** card opens, the mock (or sandbox) SMS shows as
   *accepted by provider*, and the snapshot shows the triggering box.
3. Click **Acknowledge**, open the incident, and use **Log handoff** (Radio, "Guide Juma ch.3, guests held at
   lodge").
4. On **SMS notifications**, set **Demo: simulate the SMS uplink** to **Down**. Let the clip loop: the camera still detects, the alert still
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
| Incident search, filters, sort and pagination; detail timeline order; CSV export (admin-only, formula-safe) | `test/operations.test.ts` |
| Reports come only from stored records; empty ranges return no averages | `test/operations.test.ts` |
| Live / reconnecting / stale / offline camera states; settings never expose secrets | `test/operations.test.ts` |
| Roles enforced on the server; lock-out guards; PIN reset and role change end sessions; strict CSP | `test/operations.test.ts` |

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
  and SMS jobs queue. A remote ranger cannot get an SMS while the laptop can't reach the provider, and the
  recipient also needs mobile coverage.
- **Camera:** unplug it or point to a bad source. The feed shows **STALE/OFFLINE**, the zone shows
  **UNKNOWN**, the ffmpeg error is shown, and the worker keeps trying to reconnect.
- **Laptop:** the radio procedure must keep working without it.

## Project layout

```
src/domain      zone rule, geometry, zone config, SS-### refs  (pure, unit-tested)
src/vision      ffmpeg frame source, YOLO decode + ONNX detector, scripted detector, annotation, worker
src/store       PostgreSQL access: events/actions, incident search/reports, operators, camera + zone status
src/notify      outbox worker, Africa's Talking adapter, mock adapter, message text
src/api         Fastify server, pages (login + app shell), camera state, CSV, USSD menu
src/cli         operator:add, sim:events, fixtures:synthetic, eval, report:timings, model:check
migrations      SQL schema (applied by `npm run migrate` / on `npm run dev`)
public          dashboard: css/app.css, js/ (ES modules, one per screen), icons.svg (no build step)
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
