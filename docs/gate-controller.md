# Guide face entry: camera and gate integration

The default application runs real **local** face detection and recognition and an explicitly **simulated** gate. Hardware selection is independent of the UI. A relay, ESP32 or commercial controller needs an adapter implementing this contract before physical gate mode is enabled.

## Identity and station setup

Install `scripts/face-requirements.txt` using the Python interpreter selected by `GATE_FACE_PYTHON`, run `npm run face:setup`, generate the local face encryption key with `node scripts/setup_face_key.mjs`, build and restart. `npm run face:check` verifies the models load and a blank image has no face. An optional local image argument to `scripts/check_face_runtime.mjs` checks same-image recognition under a small rotation; it is not an accuracy benchmark.

Only admins use **Staff management** (`/#/staff`) to create staff, register an authorized reference photograph or capture a live enrollment, set the station gate, grant attraction access, run demonstrations and review gate history. Reference portraits are private admin records; arrival frames are discarded. Feature templates are encrypted. Erasing a reference removes its portrait/template and invalidates in-flight recognition. A reference photograph establishes the matching reference, not liveness; trusted PAD is still required on arrival. Demo-photo enrollments remain ineligible for physical actuation. Rotate the encryption key only with a migration/re-enrollment plan.

A gate station signs in once with a dedicated staff account and opens the verification-only **Staff gate access** page (`/#/access`). The admin selects its location with `POST /api/gate/station`; staff cannot override it. Physical mode remains bound to `GATE_CONTROLLER_ZONE_ID`. The browser submits frames while active. There is no per-arrival staff ID/PIN entry. Gate reviews, demos, gallery and staff-creation controls are not available on this page. An unattended installation needs a managed station with only the arriving guide in the recognition area. A restart or session expiry never opens a gate.

## Physical controller configuration

Configure these locally; never put tokens in URLs, client-side boot data or source control:

```dotenv
GATE_CONTROLLER_MODE=http
GATE_CONTROLLER_URL=https://gate-adapter.example/internal/pulse
GATE_CONTROLLER_TOKEN=<random-shared-secret-at-least-24-characters>
GATE_CONTROLLER_GATE_ID=north-gate
GATE_CONTROLLER_ZONE_ID=<existing-attraction-zone-id>
GATE_STATION_OPERATOR_ID=<dedicated-station-staff-id>
GATE_PULSE_MS=1000
COOKIE_SECURE=true
SESSION_SECRET=<private-random-secret-at-least-32-characters>
FACE_TEMPLATE_KEY=<generated-private-64-hex-character-key>
```

The app/station needs HTTPS in physical mode. Controller URLs require HTTPS; HTTP is accepted only on loopback for a local bridge or test server. One application configuration operates one physical gate/zone. Other zones cannot trigger that gate. A live gate also requires a fresh safe/closed heartbeat and a trusted anti-spoof result for the exact recognition frame. These checks cannot be disabled from the browser.

## Outbound opening command

After face recognition, trusted liveness and current permission checks, the server durably reserves one command and sends **one** POST to `GATE_CONTROLLER_URL`. Physical cameras can operate passively on arrival; the browser simulation's head-turn demonstration is not required in physical mode:

```http
Authorization: Bearer <GATE_CONTROLLER_TOKEN>
Idempotency-Key: <requestId>
Content-Type: application/json
```

```json
{
  "requestId": "<uuid>",
  "gateId": "north-gate",
  "action": "pulse_open",
  "pulseMs": 1000,
  "guideId": "juma",
  "touristCount": 4,
  "expiresAt": "<UTC ISO timestamp>"
}
```

Respond within 2.5 seconds, with at most 4 KB:

```json
{ "requestId": "<same uuid>", "accepted": true }
```

Acceptance is not physical-open confirmation. The adapter must authenticate requests, check its own gate ID, reject expired commands, and persist processed request IDs so duplicates never pulse twice. It must apply the gate manufacturer's local emergency-stop, obstacle, limit-switch and safe-closing interlocks. `pulse_open` is an input to that controller, not a command to energize an unprotected motor. The web application never issues a timed physical-close command.

A timeout, malformed response or interrupted process leaves the command **unknown** and blocks new automatic entry. No retry is sent. Reconcile using the controller's actual position feedback. Do not resolve uncertainty by inventing an acknowledgement or assuming the gate is closed.

## Trusted controller status and position feedback

POST `/api/gate/controller/events` to the application over HTTPS with the same bearer token. Send a heartbeat at least every five seconds; status older than ten seconds blocks new actuation. Observations older than five seconds, more than two seconds in the future, or older than the last accepted observation are rejected.

```json
{
  "gateId": "north-gate",
  "state": "closed",
  "safetyReady": true,
  "observedAt": "<current UTC ISO timestamp>"
}
```

After a command, include its `requestId` with sensor-confirmed `state: "open"`, then `state: "closed"`. Use `state: "fault"` on a controller/interlock fault. `safetyReady` must reflect real local interlocks. A matching closed event completes that command. A heartbeat without its request ID does not settle an unknown command. Closed commands cannot later be reopened by an out-of-order open event.

## Trusted presentation-attack detection (PAD)

Physical mode needs a trusted camera/PAD integration. The browser's randomized head-turn challenge is a prototype motion check and does not defeat printed photos, screens, video replay or sophisticated spoofing by itself.

The trusted camera agent must evaluate **the same JPEG bytes** submitted for the guide's forward-facing recognition frame, bind the result to that session's `challengeId`, and POST `/api/gate/controller/liveness` over HTTPS with the controller bearer token:

```json
{
  "challengeId": "<recognition-session uuid>",
  "frameHash": "<SHA-256 hex of the original JPEG bytes>",
  "passed": true,
  "capturedAt": "<current UTC ISO timestamp>"
}
```

The proof must be less than five seconds old. The recognized identity, profile version, session, attraction permission and frame hash must still match. The station can resubmit that exact final frame once the trusted observation arrives; replaying ordinary earlier challenge frames cannot advance the challenge. An expired, failed or mismatched observation never authorizes actuation. Camera-controller firmware must not sign a `passed` result supplied by an untrusted browser; it must own/verify the actual capture and PAD result. Do not implement this adapter as an unconditional `passed: true` callback.

## Validation boundary

Automated tests cover authorization, encryption, ambiguous/unknown faces, profile changes, frame replay, command deduplication, stale sensor feedback, and uncertain command handling. Model smoke checks exercise actual local YuNet/SFace inference. They do not establish field accuracy, demographic performance, real-camera liveness, tailgating prevention, or mechanical safety. Validate recognition thresholds and fail-closed behavior at the selected attraction, then commission the sensor and motor controller under the manufacturer's procedures before connecting a physical barrier. Tourist group size is attendant-declared; no tourist identity/ticket or automatic headcount validation is included.

Model provenance: [OpenCV YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (MIT) and [OpenCV SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) (Apache 2.0). `config/face-models.json` pins their SHA-256 hashes. The application uses a configurable similarity threshold and ambiguity margin; upstream benchmark thresholds are not operational guarantees for this gate.
