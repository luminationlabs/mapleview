# NVR integration probes

Scripts that talk to a real NVR to measure server behavior the app currently
guesses at: per-session WS cap, login-invalidation timing, minimum safe stagger
between opens, live+playback interaction, post-login settle window.

These are **not** unit tests. They don't run under `npm test` (vitest's `include`
globs `*.test.ts`; these are `NN-name.ts`). Run them by hand when you want to
check assumptions against the real device.

## Setup

1. `npm install` (picks up new `ws` and `tsx` devDeps).
2. `cp src/nvr/__tests__/integration/credentials.example.json src/nvr/__tests__/integration/credentials.json`.
3. Fill in host / username / password. `channelId` is optional — if empty, the
   harness picks the first online channel. `playbackStart` / `playbackEnd` are
   unix seconds; leave `0` to default to "30 minutes ago .. 15 minutes ago".
4. `credentials.json` and `results/` are gitignored.

## Running

```sh
npx tsx src/nvr/__tests__/integration/01-session-cap.ts
npx tsx src/nvr/__tests__/integration/02-login-invalidation.ts
npx tsx src/nvr/__tests__/integration/03-stagger-threshold.ts
npx tsx src/nvr/__tests__/integration/04-live-playback-mix.ts
npx tsx src/nvr/__tests__/integration/05-post-login-settle.ts
npx tsx src/nvr/__tests__/integration/12-zero-stagger-at-cap.ts
npx tsx src/nvr/__tests__/integration/14-parallel-playback-fanout.ts
npx tsx src/nvr/__tests__/integration/15-restart-fanout.ts
npx tsx src/nvr/__tests__/integration/16-all-frame-ack-rate.ts
npx tsx src/nvr/__tests__/integration/18-main-stream-index-sweep.ts
npx tsx src/nvr/__tests__/integration/19-preview-stream-index-sweep.ts
npx tsx src/nvr/__tests__/integration/30-capture-frames.ts
```

Each probe prints a summary to stdout and writes timestamped JSON to
`results/`. Each has a 90-second watchdog so a hung probe can't hang your
terminal indefinitely.

## What each probe measures

### `01-session-cap.ts` — per-session WS cap

Login once, then open preview WSes sequentially on that session with 500ms
spacing (no login-invalidation race). Reports the slot index at which the NVR
starts rejecting upgrades. Confirms or refutes the assumption that
`MAX_STREAMS_PER_SESSION = 6`.

### `02-login-invalidation.ts` — new login invalidates old session

Opens a preview on session A and waits for first frame. Logs in again as
session B, then attempts a fresh preview on session A at `t = 0, 100, 500, 2000
ms` after B completed. Independently, samples whether the original WS on A
still delivers frames. Answers:

- After a new login on the same user, how fast does the old session's
  sessionId become invalid for **new** WS upgrades?
- Do **existing** WSes on the old session keep delivering?

### `03-stagger-threshold.ts` — minimum safe inter-open delay

After login settles (500ms grace), sweep inter-open delays `[0, 25, 50, 100,
200, 500, 1000]` ms. For each delay, open 4 preview WSes on the same session
at that spacing and record the success rate. Reveals whether the current
300ms stagger is overkill, insufficient, or about right.

### `04-live-playback-mix.ts` — shared cap vs per-type

Open 3 preview + 3 playback WSes on one session, staggered. Count successes
to see whether the cap is shared (6 total) or per-type (6 of each). Then open
a 7th of each type to confirm which direction rejection occurs.

### `12-zero-stagger-at-cap.ts` — is the per-session stagger still needed at cap?

Probe 03 covered 4 opens at 0ms (below cap); probe 06 covered 12 opens at 0ms
(over cap). The untested case is exactly 6 opens at zero stagger on one
session. Runs N trials, each a fresh login + 6 back-to-back opens with no
delay. If every trial reports 6/6 first-frames, `OPEN_STAGGER_MS` is dead
weight and removing it saves up to 1.5s per session on cold launch.

### `05-post-login-settle.ts` — post-login WS latency

Fresh login ×5, each time immediately attempt one WS upgrade. Record login
duration and upgrade duration. If upgrades reliably succeed at `t ≈ 0ms`
after login, the 300ms pre-open delay is unnecessary; if there's a settle
window, you'll see it here.

### `14-parallel-playback-fanout.ts` — Recorded-tab fan-out watchdog crossings

Simulates the Recorded-tab scrub cascade: open N=8 parallel playback streams
at 1x across the session pool (primary first, extra logins serialized as
capacity runs out). Measures per-stream `sessionAcquireMs`, `upgradeMs`,
`createConnectionMs`, `firstKeyframeMs`, and `maxInterKeyframeGapMs` over
a 30s steady-state window. Flags streams that exceed `LOADING_WATCHDOG_MS`
(5000ms) at any stage — those correspond exactly to the watchdog-reopen
events visible in the app's debug log.

Env: `PROBE_FANOUT_N=12 PROBE_OBSERVE_SECONDS=60 npx tsx 14-parallel-playback-fanout.ts`.
Verdict distinguishes open-path starvation (fixable by preloading sessions /
starting the watchdog later) from steady-state unfairness (fixable only by
reducing concurrent playbacks or lengthening the watchdog).

### `15-restart-fanout.ts` — seekAll restart-cycle watchdog crossings

Companion to 14, targeting the Recorded-tab scrub path. Opens N streams,
lets them reach first keyframe + steady state, then fires a simultaneous
`restart` burst on every stream (close old task_id → open new task_id +
all_frame, same three-command sequence `PlaybackConnection.restart` uses).
Measures post-restart `firstKeyframeMs` and steady-state keyframe gaps,
counts old-task_id stragglers per stream (the BUG-007 pre-gate window).

Env: `PROBE_PAUSED_COUNT=7 PROBE_SEEK_FORWARD_SEC=60 npx tsx 15-restart-fanout.ts`.
`PROBE_PAUSED_COUNT` makes the last K streams stop ACKing after restart,
mirroring Recorded single-cam's `pauseAllExcept`. Verdict tells us whether
the NVR is starving concurrent restarts or the cause is client-side.

### `16-all-frame-ack-rate.ts` — all-frame ACK gap vs effective rate

Sweeps ACK gap values against a single playback connection and measures
the resulting effective playback rate (PTS-advance per wall-second). The
current `ACK_GAP_MS_AT_1X = 100` was a guess; probe 16 identifies the
right gap per-camera empirically.

Env: `PROBE_GAPS=100,200,500 PROBE_MEASURE_SEC=10 npx tsx 16-all-frame-ack-rate.ts`.
`PROBE_CHANNEL_ID='{0000000C-0000-0000-0000-000000000000}'` targets a
specific camera — useful when cameras in the grid have different fps
or GOP.

### `30-capture-frames.ts` — populate `bench/fixtures/`

One-shot probe that opens three short-lived playback streams (sub at
`stream_index=2`, transcoded main at `stream_index=1`, HQ 4K HEVC at
`stream_index=0`) and saves one of each frame variety needed by the JS
parsing benches: keyframe + P-frame for sub and main-h264, keyframe for
main-h265, and a `frameType=4` resync keyframe captured by issuing a
restart on the main-h264 connection. Output goes to `bench/fixtures/`
at the repo root with a `fixtures.json` metadata sidecar. After this
runs once, `npm run bench` works hermetically without an NVR.

## Output

Each probe writes `results/<probe>-<iso-timestamp>.json` containing the raw
per-attempt records plus a summary. Keep these alongside findings in
`docs/PROTOCOL.md` so the assumptions behind our reliability code stay
inspectable.
