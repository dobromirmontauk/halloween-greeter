# Cost estimate — verified October 25, 2026

## Current models

- Voice: gpt-live-1, $0.05 per minute of open voice session, billed by second. That is $3/hour even during silence. Backend usage is extra.
- Vision: gpt-6-luna, standard short-context input $0.10/million tokens and output $0.50/million tokens. Image inputs contribute input tokens; there is no separate continuous video stream sent to the API.
- The consulted model pages do not state an introductory-price expiration for either model. No historical benchmark rates are used.

Sources: [GPT-Live 1](https://developers.openai.com/api/docs/models/gpt-live-1), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [image inputs](https://developers.openai.com/api/docs/guides/images-vision). Raw web-tool responses are saved in research-agent-costs/raw.

## Workload assumptions and estimate

Preview requests every four seconds run locally through ffmpeg and incur no OpenAI charge. Scene analysis normally runs every twelve seconds during an active voice session: approximately 300 image analyses per hour, plus startup, manual refreshes and delegated camera questions. Six-second result caching reduces duplicated closely spaced requests.

An illustrative analysis using 1,000 input tokens (image plus prompt) and 200 output tokens costs (1000 × $0.10 + 200 × $0.50) / 1,000,000 = $0.0002. At 300/hour that is $0.06/hour. These token counts are assumptions, not measured usage. A rough budgeting allowance of $0.05–$0.15/hour covers moderately larger descriptions/input usage; the actual amount may differ and should be calibrated from API usage after the first real calls. Output is capped at 450 tokens per analysis.

| Open voice time | Voice | Estimated vision | Estimated total |
| --- | ---: | ---: | ---: |
| 10 minutes | $0.50 | $0.01–$0.03 | $0.51–$0.53 |
| 1 hour | $3.00 | $0.05–$0.15 | $3.05–$3.15 |
| 4 hours | $12.00 | $0.20–$0.60 | $12.20–$12.60 |
| 6 hours | $18.00 | $0.30–$0.90 | $18.30–$18.90 |

Budget about $13 for four hours. This excludes electricity, internet and taxes. It assumes one voice session at a time, current rates and the current vision model. The default session limit is now 30 minutes (`SESSION_LIMIT_SECONDS=1800`, also the maximum): one session can span several groups on a busy night, so an open session costs about $3/hour and up to $1.50 per capped session whether or not anyone is talking. A session ends after 30 seconds of confident all-zero reads or at the limit, and is not restarted for the same party after the limit; the four-hour estimate assumes the porch is busy enough to keep a session open. Stop closes paid voice time; mute does not. With the voice session stopped, preview alone is free of OpenAI charges, while manual scene refresh still incurs a small vision request charge.

## Measured costs: `GET /api/costs`

Prices re-verified 2026-10-25 from the official model pages (raw copies in research-agent-costs/raw/*_recheck.md) and held in one table in `costs.mjs`:

| Model | Unit | Price | Source |
| --- | --- | ---: | --- |
| gpt-6-luna | 1M input tokens (images count as input tokens; no separate image price is published) | $0.10 | [model page](https://developers.openai.com/api/docs/models/gpt-6-luna) |
| gpt-6-luna | 1M cached input tokens | $0.01 | same |
| gpt-6-luna | 1M output tokens | $0.50 | same |
| gpt-live-1 | minute, billed per second | $0.05 | [model page](https://developers.openai.com/api/docs/models/gpt-live-1) |

Any price that could not be verified is returned with `"verified":null,"status":"unverified"`.

The server records billed usage per request: every Responses/Decisions call (`usage` tokens, by model and purpose) and every Live session (`usage.seconds` from `session.usage.updated` / `session.closed`). If a session ends with no final usage, open duration is used and counted in `estimated_seconds`; real usage later replaces the estimate.

`GET /api/costs` returns `{as_of, pricing[], since_start, today, session, rate_usd_per_hour_last_10min}`. `since_start` and `today` share one shape: `total_usd`, `by_category` (`judge` and `scene` with `usd, calls, input_tokens, output_tokens, cached_tokens, by_purpose{}`; `live` with `usd, seconds, sessions, estimated_seconds`) and `by_model`. `today` (local date) also has `date` and is saved to `data/costs/<date>.json` (gitignored, 0700/0600, debounced) and reloaded on restart; `since_start` resets on restart. Set `COSTS_DIR` to relocate it. `session` (null when no porch session is open) has the same shape for the current porch session. `rate_usd_per_hour_last_10min` is spend over the last 10 minutes times six.

## Judge (Decisions) cost with three parallel judges — estimated October 25, 2026

Price, rechecked against the saved official model page (research-agent-costs/raw/2026-10-25_official-openai-tool-responses.json, gpt-6-luna): input $0.10/M tokens, cached input $0.01/M, output $0.50/M. No introductory-price expiration is stated there. Output is a few choice labels per question; treated as negligible (not measured).

Calls per second (each capture cycle is at most 1 s; a cycle longer than 1 s because of latency lowers these):

| Situation | Judges per cycle | Calls/s |
| --- | --- | ---: |
| Yard empty | Presence every 5 s | 0.2 |
| People present, before COSTUMES fires for the party | Presence + Motion + Costume | up to 3 |
| People present, after COSTUMES fired (Costume paused) | Presence + Motion | up to 2 |
| First sighting after an empty read | Presence, then Motion + Costume | 3 in that cycle |

Tokens per call. The only measurement is the old single 12-question call at about 1,200 tokens, whose request text was 25,948 characters plus one image. The new request text sizes are 1,742 (Presence), 7,082 (Motion, two images) and 20,579 (Costume) characters. Per-judge tokens below are therefore ESTIMATES scaled from that one measurement (assuming about 400 tokens per image), with a pessimistic bound at 4 characters per token. Calibrate from `/api/costs` after the first real night; the Judge category there is now split into `judge-presence`, `judge-motion` and `judge-costume`.

| Judge | Estimated tokens/call | Pessimistic |
| --- | ---: | ---: |
| Presence | about 450 | about 850 |
| Motion | about 1,000 | about 2,600 |
| Costume | about 1,050 | about 5,600 |

| Situation | Tokens/s | Judge cost per hour (estimate) | Pessimistic |
| --- | ---: | ---: | ---: |
| Yard empty | about 90 | about $0.03 | about $0.06 |
| People present, all three judges | about 2,500 | about $0.90 | about $3.20 |
| People present, Costume paused | about 1,450 | about $0.52 | about $1.20 |

For comparison the old single judge at about 1,200 tokens/s while people were present was about $0.43/hour. The estimate keeps the Judge below the $3/hour voice session; only the pessimistic all-three-judges case exceeds it, which is why Costume pauses after COSTUMES. A four-hour night with people present half the time is about $2 estimated, about $6-7 pessimistic. Unverified: no live Decisions call was made with these requests, so actual tokens, latency and billing of two images in one request are not measured.

## Gemini 3.8 Live backend (`VOICE_BACKEND=gemini`, verified 2026-10-26)

Source: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) (saved under `research-agent-gemini-live/raw/`). Model `gemini-3.8-live`, PAID tier only (the free tier lets Google use the data to improve its products; visitors include children). No introductory-price expiry is listed on the page.

| Stream | Paid-tier price | Per minute |
| --- | ---: | ---: |
| Audio in | $3.00 / 1M tokens | $0.005 |
| Image/video in (JPEG frames) | $1.00 / 1M tokens | $0.002 |
| Audio out | $12.00 / 1M tokens | $0.018 |
| Text in / out | $0.75 / $4.50 per 1M | negligible (prompts, instructions) |

Unlike gpt-live-1, an open Gemini connection that is not streaming costs nothing by itself: you pay for what is sent and spoken. The always-on mode therefore pays audio-in only while the mic is unpaused (group state not EMPTY, or a visit running; `GEMINI_MODE=all-gemini` sends mic audio and video only while SIDEWALK/PATH/PORCH plus a 5 s tail, the same cost shape as events mode), video only while the group is SIDEWALK/PATH/PORCH or a visit runs, and audio-out only while it talks.

`/api/costs` -> `by_category.live.by_backend.gemini`: `{usd, seconds, sessions, parts:{connected_seconds, audio_in_seconds, video_seconds, audio_out_seconds}}` plus `live.backend`; `by_model['gemini-3.8-live']`. These are computed from what the client actually streamed (bytes of mic audio sent, JPEG frames sent / fps, bytes of audio received), not from `usageMetadata` (its token counts are per-turn context sizes, so summing them would overcount); the latest `usageMetadata` is kept in `status().usage` for audit. Idle gaps between visits are recorded as their own periods (not counted as sessions). Calibrate against the Google AI Studio billing page after a real evening.

Per visit (3 minutes of conversation near the porch, about 45 s of speech out):

| | gemini-3.8-live | gpt-live-1 ($0.05/min) |
| --- | ---: | ---: |
| 3 min audio in | $0.015 | |
| 3 min video (1 fps) | $0.006 | |
| 45 s audio out | $0.0135 | |
| Voice total | about $0.035 | $0.15 (+ pre-warm waste $0.004-$0.0125 per passer) |

Four hours always-on (mode ON, one session kept open, 4 h x $0.05/min = $12.00 for gpt-live-1 if it were also kept open):

| Scenario | Audio in | Video | Audio out | Total |
| --- | ---: | ---: | ---: | ---: |
| Typical: someone near 20% of the time (48 min), 10 min of speech | $0.24 | $0.10 | $0.18 | about $0.52 |
| Worst case: never EMPTY (240 min), 30 min of speech | $1.20 | $0.48 | $0.54 | about $2.22 |

The vision Judges (gpt-6-luna, presence fallback, costume reads) are unchanged and billed by OpenAI as before. With `GEMINI_SEE_COSTUMES=on` (default) the delegated costume-description call is skipped, saving a few cents per visit; Judge costume labels are still sent as a hint. Unverified assumptions: speech-out minutes, and that Gemini does not bill the held context again per turn (the pricing page lists only the rates above).

## Live pre-warm (2026-10-26)

gpt-live-1 bills $0.05 per minute of OPEN session, per second, silent or not (see the table above); there is no separate audio-minute rate, so a connected-but-silent pre-warmed session costs exactly the same per second as a talking one. Pre-warm (`PREWARM=on`, default) opens the session when someone is on the sidewalk and closes it after `PREWARM_MAX_MS` (15000) without reaching the path, or when the group goes EMPTY.

- Worst case per sidewalk passer who never reaches the path: 15 s x $0.05/60 = $0.0125 (plus a second or two of connect/close). Typical passer (sidewalk for about 5-8 s): about $0.004-$0.007.
- A passer who does come up the path: no waste; the warm seconds (about 2-5 s, about $0.002-$0.004) are the start of the session that would have been opened anyway.
- 100 sidewalk passers per night = about $0.40-$1.25 extra. The group is not re-warmed after a timeout until the sidewalk is EMPTY.
- `/api/costs` -> `by_category.live.prewarm`: `{sessions, used_sessions, wasted_sessions, seconds, wasted_seconds, usd, wasted_usd}` (attribution only; `total_usd` already includes these seconds through the normal Live usage). Estimates above are unmeasured; read `wasted_usd` after a real evening.


## Replay costs (2026-10-26)

A replay with a real backend costs what the live conversation would for that clip: Gemini = mic seconds sent + video frames (1 fps) + audio out at the rates above; gpt-live = connected seconds at $0.05/min; `--judges real` adds the luna Judge reads. Typical 1-3 minute clip with Gemini: a few cents (see the Gemini table). `--judges recorded|fake` and `--backend fake` cost nothing. The run's `cost_usd`/`cost_breakdown` come from the replay's own `/api/costs`; `--max-cost` (CLI, bulk) and the UI cap stop a run when reached; bulk gives each run only the remaining budget. Unverified: the real cost of an all-day bulk run (use a small cap first).
