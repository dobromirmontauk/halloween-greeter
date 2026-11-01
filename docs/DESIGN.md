# Initial design

## Agreed experience

Visitors approach the house; the greeter talks with them using GPT-Live and recent camera observations about costumes and broad apparent age groups. The character is the house’s old-timey banjo player; voice and tone should match him. Initial delivery direction: warm, folksy, lightly spooky. Keep speech child-friendly if age is uncertain or a group includes children. Never announce a guessed age as fact.

## Proposed architecture

1. A local camera adapter samples the existing IP camera. Determine RTSP/snapshot support from the actual device; no stream protocol is assumed yet.
2. A vision-capable backend interprets a current snapshot and returns a concise timestamped scene description: visible costumes, visitor/group presence, broad apparent age group or unknown, and uncertainty.
3. `gpt-live-1` handles microphone input and speaker output. The application passes current visual findings into the supported delegation/context flow. GPT-Live itself receives no raw images.
4. Local session control handles arrivals, departures, stale observations, greeting cooldowns, mute/stop, and reconnects. Separate conversation context between groups so the next visitors do not inherit the previous group's description.

Start with a local browser plus trusted server on the Linux box, following the official WebRTC quickstart. Browser echo cancellation is a candidate to evaluate on the real speaker/microphone. A headless deployment can be considered if needed; it is not yet selected.

These are implementation proposals, not tested behavior. Start with operator-triggered greetings for integration, then add arrival detection and cooldowns after camera reliability is demonstrated.

## Verified API facts — October 25, 2026

- Exact requested voice model: `gpt-live-1`. It provides full-duplex audio and delegates backend work.
- The Live audio frontend does not accept images directly. Official guidance routes images to a vision-capable backend and returns relevant text to Live.
- Voice sessions cost $0.05 per minute, billed per second of session duration; backend model/tool usage costs extra. An open session for four hours would cost $12 for Live alone, regardless of how much visitors speak. Close sessions when appropriate and track actual usage.
- No introductory-price expiration is stated on the consulted model page. Reverify prices and account access before deployment.
- Implemented vision backend: `gpt-6-luna`, verified October 25, 2026 to support image input and text output via Responses. Standard token prices: $0.10 per million input, $0.50 per million output, cached input $0.01 per million. No introductory expiry is stated on the model page. Account model availability was verified with HTTP 200 from GET /v1/models/gpt-live-1 and GET /v1/models/gpt-6-luna on October 25, 2026; actual media and vision requests remain unverified. See [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
- `cinder` is a documented Southern U.S. masculine generated GPT-Live voice. This is an initial fit for the character; a listening test is still needed. Live session creation uses the documented `POST /v1/live/sessions` JSON with a WebRTC transport, not the Realtime endpoint.

Sources: [GPT-Live](https://developers.openai.com/api/docs/guides/live), [delegation and visual context](https://developers.openai.com/api/docs/guides/live-delegation), [model and pricing](https://developers.openai.com/api/docs/models/gpt-live-1).

## Proposed operational defaults

- Keep raw frames and audio ephemeral; do not add recording by default.
- Use only the configured approach area to trigger greetings; stale or unavailable visual context produces a generic greeting.
- Keep API keys on the trusted server. Redact camera credentials from errors and logs.
- Use a physical or easily accessible operator mute/stop control.
- Test darkness, masks, multiple costumes, uncertain ages, empty scenes, overlapping speech, speaker feedback, connection loss, and back-to-back groups.
- Visual observations and visitor speech cannot override operating instructions. Keep interaction focused on Halloween greetings and conversation.

## Context discovery

A bounded Calendar search for Halloween during 2026 and Gmail/Drive keyword searches on October 25 found party, photo, ticket, and newsletter results but no established prior technical project context. Those results are not treated as this project's deadline or requirements. October 31 is the user-approved target.

## Implemented demo and camera discovery — October 25, 2026

The demo is a zero-dependency Node HTTP server plus browser WebRTC client. It binds to loopback only, keeps the project API key on the server, uses default browser microphone/speaker with echo cancellation, and runs ffmpeg to decode real RTSP frames as JPEG. Concurrent captures are coalesced into one ffmpeg process because the discovered camera's private registry reports one allowed session. The process exits after each snapshot. Frames and observations stay in memory; no recording is added.

LAN discovery found RTSP at `192.0.2.21:554`. RTSP OPTIONS returned 200 and DESCRIBE returned 401 with TP-Link IP-Camera authentication. The existing private integration registry, read as directed by the user, identifies `backyard-cam` as TP-Link Tapo C520WS. Its private stream URL and credentials come from the local `store_observability/demo/integrations` configuration; neither is committed. The lead captured and visually verified a real 84,516-byte JPEG; the running app then captured a real 79,921-byte JPEG. These images remain local.

Scene interpretation posts the JPEG to Responses with a strict scene schema and child-friendly interpretation rules. It refreshes every 12 seconds while the voice session runs. GPT-Live receives short timestamped text via `session.thinking.append`; fresh arrivals may receive a `session.commentary.append` greeting. Two empty observations reset presence, with at least 45 seconds between greetings. A 30-second freshness limit prevents stale observations from triggering a greeting. The MVP detects presence across the whole camera image; approach-area tuning is a real-world follow-up.

Automatic approval review stopped the real-image vision smoke test pending specific authorization to send camera snapshots to OpenAI. The app code is implemented, but actual vision API compatibility, account access, conversation latency, voice quality, and acoustic performance are not yet verified. Local injected integration checks establish request/response semantics and error handling, not production API success.
