# Playback Pacing Build Log

The NVR delivers frames faster than real-time (~1.3-2x for main streams,
~2.5x for sub). Without throttling, playback runs too fast. The web
client solves this with a JS display loop that holds decoded frames
until `wallElapsed * playSpeed >= ptsElapsed`. We can't replicate that
on iOS because `AVSampleBufferDisplayLayer` couples decode and display
— you can't "decode now, display later." This log records what we
tried to throttle in-band instead, what worked, and why.

## What works

### Server-side pacing via ACK pause
Pause ACKs when PTS lead exceeds a threshold. The server's flow-control
window fills, the server stops sending. A resume timer fires when wall
catches up. This is the only mechanism that bounds the in-flight buffer
under sustained over-delivery. Used as a rare safety net (high
threshold) rather than the primary throttle.

### Per-connection adaptive ACK rate (all-frame mode)
Server releases ~32 frames per ACK window regardless of camera. The
right ACK gap therefore depends on how much video time those 32 frames
represent: `targetGap = 32 × observedPtsPerFrameMs / speed`, clamped to
[100, 5000] ms. Falls back to a 33.3 ms (30 fps) default until the
first delta is observed; resets when a task restarts so a new channel
can adapt.

### Per-connection adaptive ACK rate (keyframe mode)
Keyframe mode releases exactly 3 keyframes per ACK regardless of gap
(verified on 250/500/750/1000 ms in a probe sweep). Effective rate is
`3 × GOP / ACK_gap_sec`, so `targetGap = (3 × observedGopSec × 1000) /
speed`. GOP is measured as the median of the last 5 keyframe PTS
deltas, defaulting to 2 s. Restart resets the observer because GOP
varies per camera.

### Absolute ACK scheduling (jitter-robust)
Relative scheduling (`lastAckWall + targetGap` where `lastAckWall =
Date.now()` at fire time) absorbs RN setTimeout dispatch jitter
(~10-20 ms/cycle) into each subsequent cycle's baseline, drifting the
actual cadence above target. At 8x with a 750 ms target, actual cadence
drifts to ~760-770 ms, server delivers at ~7.89× while CMTimebase
advances at rate=8, lag accumulates linearly, eventually triggers a
burst render every cycle. Fix: a `nextAckWall` field tracks the
absolute wall-clock fire time and advances by exactly `targetGap`
regardless of when setTimeout actually fires. Late fires shorten the
next delay rather than contaminating the baseline. Re-anchor only when
behind by more than one gap (avoids firing a catch-up burst after a
stall). Reset in `restart()`, `seekInPlace()`, `pause()`, `close()`.

### MIN-over-window for `ptsPerFrame` estimation
An EMA of consecutive-frame PTS deltas with a 5-500 ms filter
stabilises at a biased value because frame drops are one-sided (they
only inflate consecutive deltas to 66/99/133 ms). The EMA settles at
35-48 ms instead of 33.3 ms, `targetGap` inflates ~20%, content falls
seconds behind wall-clock. MIN over a 20-sample sliding window is
unbiased against one-sided outliers, but plain MIN latches onto 5-11 ms
near-duplicate PTS deltas the server occasionally emits (fragment
boundaries / burst artifacts; no real NVR camera runs >40 fps). MIN
with the filter floor raised to 20 ms is robust against both.

### Native gap detection + timebase re-anchor
If more than 500 ms passes between `feed()` calls, the next sample
sets `needsTimebaseAnchor = true` and `needsKeyframeAfterGap = true`.
Re-anchoring after a gap prevents the queued samples from all being
"late" relative to the timebase and rendering as a fast burst on
resume. Gating on keyframe prevents green from a stale reference. The
display layer holds the last rendered frame during the gap — no green,
no black.

### Explicit `CMSampleTimingInfo.duration`
Computed from the PTS delta between consecutive frames, clamped to
[1 ms, 10 s]. Without an explicit duration the display layer doesn't
pace within a delivery burst, so even server-paced playback shows as
slightly fast. The upper bound matters in keyframe-only mode (speed > 4)
where keyframe-to-keyframe PTS gaps are ~5 s: a 200 ms clamp treated
these as outliers and rendered keyframes ASAP instead of holding them
for their natural interval.

### Pacing baseline re-alignment (initial post-restart only)
If `leadMs < -1000` when the first frames after a restart arrive,
re-set `sharedSeekWall`/`sharedSeekUnix` to the current frame. This
fixes the ~10 s of fast playback after a grid load (baseline set
seconds before frames actually arrive). Removed once adaptive ACK rate
made it unnecessary in steady state; preserved for the initial
post-restart window.

### Skip pacing check on user-paused connections
`sharedSeekUnix` is process-global, so any connection's re-align
affects every connection's pacing math. When `setSpeed` crosses the
keyframe threshold it restarts *all* connections including user-paused
ones (background channels in single-cam view). The paused channel
re-opens at `seekFrom = lastPts - 12s` (stale), receives the server's
initial ~32-frame window before pacing kicks in, hits the re-align
branch with hugely-negative `leadMs`, and corrupts the shared baseline
— observed as a 124-second pause on the active channel. Fix: pacing
checks return early on `userPaused` connections. They still receive
the server's initial window but can't move the shared baseline.

### Synchronous store subscribe for scrub dispatch
Scrub→flush dispatch via a `useEffect` on `seekEpoch` adds React
commit latency between scrub and flush. `playbackStore.subscribe`
fires synchronously inside the scrub's `set()`, before re-render and
commit. Removes several ms from the dispatch path on a hot scrub.

## What doesn't work (with why)

- **CMTimebase alone (no server pacing).** Set up correctly (verified
  via logs) but does not reliably pace display under 11 concurrent
  streams. The buffer grows unbounded and the display layer
  eventually misbehaves. CMTimebase is necessary for smoothness
  *within* a burst, but is not sufficient as the only throttle.
- **JS-side frame delay via setTimeout.** Holding H.264 bytes away
  from the decoder breaks the reference chain — green frames.
  Copying bytes first avoided buffer invalidation but green
  persisted: `AVSampleBufferDisplayLayer` couples decode and display.
- **Skip-based pacing (receive + ACK, don't deliver).** Without
  pausing ACKs, the server's lead grows unbounded and the skip is
  permanent. With pausing ACKs, skip + waitKey interaction creates
  cycles — strictly worse than just pausing ACKs.
- **Sub-stream for grid playback.** Lower source fps but delivered at
  ~25 fps; PTS advances at ~2.5× wall, oscillation extreme. The web
  client also uses main (`stream_index=1`) for all recording
  playback. On the test NVR, sub bitrate isn't actually lower.
- **EMA for `ptsPerFrame` estimation.** Drops are one-sided outliers
  that bias the EMA upward. See "MIN-over-window" above.
- **Relative ACK scheduling.** RN setTimeout jitter accumulates. See
  "Absolute ACK scheduling" above.
- **Signalling JS pacing-pause to native to pause the timebase.** At
  1x-4x, net rate drops below `speed` proportional to time paused
  (1x becomes visibly too slow). At 8x, the server queues during the
  pause and all of it drains on resume → ~30 s jumps.
- **Re-anchoring the timebase to a sample's PTS when that sample is
  late.** Mid-stream backward timebase moves confuse the display
  layer, producing erratic playback at 8x.
- **JS pre-buffer (50+ `feed()` calls flushed as a burst on restart).**
  Added originally to mask pre-adaptive-ACK over-delivery oscillation.
  Once ACK pacing matched real time, the pre-buffer just populated the
  display layer with ~2 s of future-PTS samples on every restart —
  the source of pre-scrub bleed. Removing it (~290 lines deleted) was
  necessary to fix scrub cleanliness.
- **`displayLayer.flush()` for scrub.** Apple's docs: "discard
  pending enqueued sample buffers" — does not include the displayed
  image. The last pre-scrub frame stays frozen on screen during the
  keyframe-fetch wait. `flushAndRemoveImage()` is the right call.
  Even so, pending `feed()` calls already on the main queue execute
  *before* flush runs (FIFO) and repopulate the layer; need a
  seek-target gate in `feed()` to drop stale-PTS samples that arrive
  in that window.
- **`waitingForKeyframe = true` on every pacing resume.** Caused
  loading-watchdog cascades (keyframes are ~5 s apart, loading
  watchdog is also 5 s, constant race) and a 5 s P-frame drop after
  each resume. The decoder's reference chain *is* intact after a
  pacing pause (server stays on the same sequence), so the gate is
  unnecessary. Green prevention belongs in native gap detection.

## Key protocol facts (verified)

- Server ACKs: only multiples of 8 honored in all-frame mode
  (`seq % 8 === 0`). Any value in keyframe mode.
- Server flow-control window: ~32 frames in all-frame mode.
- Keyframe mode releases **exactly 3 keyframes per ACK**, regardless
  of ACK cadence. Effective rate `= 3 × GOP / ACK_gap_sec`.
- Server echoes `task_id` UPPERCASE in binary frame envelopes
  regardless of client casing.
- Keyframe cadence (GOP) **varies per camera** — the test NVR
  delivers 2 s GOP on `stream_index=1`. Don't hard-code.
- `start_time`/`end_time` must be integer unix seconds (fractional →
  NVR seeks to earliest recording).
- The web client uses the server-assigned `frameIndex` (SHFL `seq`
  field) as the `play_frame_index` ACK value.
- The NVR invalidates earlier HTTP tokens on every new login for the
  same user. Only the most recent login's token is accepted; stale
  tokens silently return 200 + empty payloads. `sessionStore` must
  be updated after *every* login (primary, extras, playback-manager
  reservations).

## Probe data: all-frame rate vs ACK gap

Sweep on two cameras — a 30 fps main-model camera (Ch1) and a 10 fps
odd-model camera (Ch12). `rate × gap ≈ 32 × ptsPerFrame` per camera
(~1080 for the 30 fps cameras, ~3200 for the 10 fps). The server
releases ~32 frames per ACK window regardless of camera — the right
gap depends on how much video time those 32 frames represent.

| Gap (ms) | Ch1 (30 fps) | Ch12 (10 fps) |
|---------:|-------------:|--------------:|
|      100 |       10.69x |        30.19x |
|      160 |        6.76x |        20.20x |
|      200 |        5.42x |        16.25x |
|      250 |        4.37x |        12.84x |
|      320 |        3.44x |             - |
|      400 |        2.76x |             - |
|      500 |        2.24x |             - |
|      700 |        1.63x |             - |

For 1.0x delivery: Ch1 ≈ 1080 ms, Ch12 ≈ 3200 ms. No single global
value works — hence per-connection adaptation.

## Architecture today

- Main stream (`stream_index=1`) for all recording playback (grid and
  single-cam).
- Per-connection adaptive ACK rate. All-frame uses MIN-over-20 of
  consecutive PTS deltas with a 20 ms floor; keyframe mode uses
  median GOP from the last 5 keyframes.
- Absolute ACK scheduling via `nextAckWall`.
- Server-side ACK pause as a rare safety net at a high `PACING_LEAD_MS`
  threshold; pacing checks skip user-paused connections.
- CMTimebase anchored to the first frame, rate = `speed`. Explicit
  `CMSampleTimingInfo.duration` per sample (clamped [1 ms, 10 s]).
- Native gap detection: >500 ms feed() gap → re-anchor + keyframe gate
  on the next sample.
- Scrub flushes via `flushAndRemoveImage()`, sets timebase rate to 0,
  drops late-arriving samples in `feed()` via a seek-target gate,
  re-anchors on the first post-scrub sample. Dispatched
  synchronously via `playbackStore.subscribe`.

## Lessons learned

- **EMA → windowed-MIN when outliers are one-sided.** EMA stabilises
  at a biased value when drops or losses can only inflate; MIN is
  unbiased in that case.
- **Filter floors matter.** A 5 ms floor lets server artifacts
  through; raise the floor to the lowest physically-plausible value
  on any supported camera (40 fps → 20 ms in our case).
- **Absolute > relative scheduling for steady-cadence timers under
  RN.** setTimeout dispatch is jittery; relative schedulers absorb
  the jitter into their baseline. Anchor to absolute wall time.
- **Read Apple's docs literally.** "Discard pending enqueued sample
  buffers" excludes the displayed image. There's usually a sibling
  method (`flushAndRemoveImage`) with the behavior you actually want.
- **When a fix layer's original justification disappears, reconsider
  whether it's still pulling its weight.** The JS pre-buffer existed
  to mask over-delivery oscillation. Once adaptive ACK pacing fixed
  the underlying cause, the pre-buffer became dead weight with real
  side-effects.
- **Synchronous store subscribe vs `useEffect` for time-critical
  dispatch.** Zustand vanilla stores allow synchronous subscriptions
  to `set()`; useful when a native call must fire *before* React
  reconciliation.
- **Compound root causes happen.** Pre-scrub bleed had four
  necessary-but-not-sufficient fixes (pre-buffer removal, flush vs
  flushAndRemoveImage, seek-target gate in `feed()`, timebase rate=0
  on flush) plus one orthogonal latency cut (sync subscribe). Don't
  declare victory after the first fix.
- **Fix at the right layer.** 8x chop was originally blamed on the
  display layer; the actual cause was a client ACK rate that invited
  the server to burst at 127×. Probes against the protocol exposed
  this; speculation about the display layer wouldn't have.

## Open issues

- **Occasional green frames.** Rare, no consistent reproducer; one
  observed instance didn't surface a `displayLayer.status = .failed`.
  May be a transient VideoToolbox artifact rather than a code bug.
  Candidate next steps if it gets worse: gate every pacing resume on
  a keyframe (accept a brief freeze), or flush the display layer on
  resume to clear stale decode state.
- **Residual ~16 ms scrub flicker.** One CADisplayLink tick can fire
  between the scrub event and `flush` executing on the native main
  queue, rendering samples already in the queue. Reducing further
  would require moving NAL parsing off the main queue or JSI-based
  flush dispatch — both significantly more invasive than the ~60×
  improvement already achieved.
- **Pacing oscillation residual.** ACK pause as a safety net still
  produces a small visible pause at the buffer cap (`PACING_LEAD_MS
  = 5000`). At ~2x delivery this works out to ~5 s smooth +
  ~2.5 s pause/resume = ~7.5 s period — much less frequent than
  earlier shorter thresholds, but not zero.
