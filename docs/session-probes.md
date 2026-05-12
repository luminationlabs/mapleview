# Session / WS Probe Findings

Build log for the integration probes under
`src/nvr/__tests__/integration/`. The probes talk to a real NVR and measure
behavior that the app previously guessed at. This is the hunches-and-analysis
file; confirmed facts have been promoted to `PROTOCOL.md`.

## What each probe tells us

| # | File | Result |
|---|---|---|
| 01 | `01-session-cap.ts` | Per-session cap = **6**. Attempts 1–6 stream; 7+ get HTTP 400. |
| 02 | `02-login-invalidation.ts` | New logins do **not** invalidate old session WS upgrades. Existing WSes survive too. |
| 03 | `03-stagger-threshold.ts` | 4 opens at any delay (0–1000ms) succeed 100%. Per-session stagger isn't load-bearing against burst 400s. |
| 04 | `04-live-playback-mix.ts` | Cap is shared across preview + playback. 3+3 OK; 7th of either type fails. |
| 05 | `05-post-login-settle.ts` | No post-login settle window; upgrade at t=0ms post-login succeeds 5/5. |
| 06 | `06-parallel-burst.ts` | 12 parallel opens on one session → exactly 6 succeed, 6 get HTTP 400. Reproduces production. |
| 07 | `07-parallel-logins.ts` | 4 parallel `login()` calls all succeed with distinct sessionIds and all produce WS-upgrade-capable sessions. `extraLoginChain` isn't needed. |
| 08 | `08-slot-release-timing.ts` | Characterizes NVR's slot-release timing after clean vs abrupt WS teardown. Used to tune background/foreground reopen. |
| 09 | `09-playback-keyframe-rate.ts` | Server sustains **~127x** effective playback rate when client ACKs each keyframe immediately. Server is NOT the bottleneck at 8x — client pacing is. |
| 10 | `10-playback-paced-acks.ts` | Server releases **exactly 3 keyframes per ACK** in keyframe-only mode, stable across 250–1000 ms gap sweep. Effective rate scales linearly: `rate = 3 × GOP / ACK_gap`. |
| 12 | `12-zero-stagger-at-cap.ts` | 6 opens at zero stagger on one session, 5 trials → **30/30 success**, all first frames in 118–248ms. Fills the gap between probe 03 (4/4 below cap) and probe 06 (over cap). Confirms `OPEN_STAGGER_MS` can be removed — savings ≈ 5 × 300ms = 1.5s on tail per session. |
| 20 | `20-upgrade-vs-login-race.ts` | **Refutes** the "concurrent extra-session login completing while P1 has in-flight WS upgrades causes them to 400" hypothesis. 9 runs across baseline / concurrent / full-fan all clean (0/27 failures). Login concurrency is not what produces production cold-launch 400s. |
| 21 | `21-coldlaunch-stress.ts` | Reproduces the 500ms close-window race **deterministically**: clean-close 6 fully-alive WSes on a session, immediately fire 6 fresh upgrades on the *same* session → consistently ~3/6 fail with HTTP 400. Mid-upgrade `ws.terminate()` (i.e., abort while CONNECTING/just-OPEN) **also** holds slots — counter to probe 08's "abrupt = 0ms recovery" finding, which only held for terminating fully-established streams. Kitchen-sink (12 upgrades + 2 logins + enumerate, no same-session reopen) → clean. |
| 22 | `22-coldlaunch-fullsim.ts` | **No global cap**: 24 concurrent WS upgrades distributed 6 across each of 4 sessions all succeed. 24 in the same microsecond across 4 pre-logged sessions also clean. The `cold-launch-interrupt` scenario (mirror reopenStreams: P1 opens + close 3 CONNECTING + finish wave on P1+P2) doesn't reproduce either. The 500ms race from probe 21 is the only mechanism we've reproduced; production cold-launch 400s remain unexplained in isolation. |
| 30 | `30-capture-frames.ts` | Captures one of each frame variety (sub P-frame + IDR, transcoded-main P-frame + IDR, HQ-main HEVC IDR) into `bench/fixtures/` for the JS parsing benchmarks. Side findings: **on this NVR, `stream_index=1` (transcoded main) and `stream_index=2` (sub) emit byte-identical bitstreams** for the same channel + time range; **every fresh `playback/open` first frame is `frameType=4`** (the resync IDR for the requested seek time, not just post-restart); **the server closes the WS shortly after `playback/close`** when no other tasks are active on it, so a probe that wants to reopen on the same WS needs another task already in flight. |

## Hypotheses that were refuted

The code carries several defensive mechanisms that were built against races
we can't actually observe on this NVR / firmware. Listed here so a future
cleanup pass knows what to simplify:

1. **"Parallel extra logins invalidate each other, causing in-flight WS
   upgrades to return 400"** — refuted by probe 02. New logins don't
   invalidate old session WS upgrades.
2. **"A post-login settle window is needed before WS upgrades"** — refuted by
   probe 05.
3. **"Per-session 300ms stagger is needed to avoid burst 400s"** — refuted by
   probe 03 (below cap) and confirmed safe at cap by probe 12 (6 opens at 0ms
   × 5 trials → 30/30). The problem in production is over-cap, not burst rate.
4. **"Cap is approximately 6"** — firmed up to exactly 6.

Mechanisms in `client.ts` that were motivated by (1)–(3) and can probably be
simplified once a fix for the actual cause lands:

- `extraLoginChain` (serialized extra-session logins) — probe 07 confirms
  parallel logins are safe. Remove.
- `openEpoch` stale-open abort guards — motivated by "stale sessions get
  invalidated". Since they don't, these guards are mostly redundant (they
  still protect against sink-detach races, which is a real case).
- `sessionFailures` tracking + eviction — the 1006 signal it tracks is real,
  but the cause isn't "bad session", it's "session is full". Evicting a
  session because we over-subscribed it makes the pool smaller, not better.

## Confirmed causes

### Cause 1: cold-launch race — fixed in `51ab417`

Probe 06 reproduces the exact pattern from the cold-launch log screenshot:
12 parallel WS upgrades on one session → 6 succeed, 6 fail with HTTP 400.

### Why it happens in `client.ts`

When N cameras attach in the same tick (cold launch of a 12-camera grid),
`attach()` is called N times synchronously. Each call runs `scheduleOpen()`
which starts a `doOpen()` async function. All N `doOpen`s enter
`await getAvailableSession()` before any of them has advanced past the await.

`getAvailableSession` chooses a session by:

```ts
if (streamCountForSession(primary) < MAX_STREAMS_PER_SESSION) return primary;
```

`streamCountForSession` reads `this.streamSessions` — which is only populated
at the **end** of `doOpen`, after `conn.open()` (client.ts:825). So all N
calls see count=0, return primary, and 6 of the 12 end up over-cap.

The `sessionOpenIndex` counter (per-session stagger) IS updated synchronously
and does space the upgrades out in time — but all still directed at the same
session. Spacing doesn't help when the target session is already full by the
time the later opens land.

`preloadSessionsFor(12)` does kick off 1 extra-session login in parallel,
but `getAvailableSession` never awaits it because primary always "has room"
at the moment each call checks.

### Fix

`liveClaims` map, incremented synchronously in `getAvailableSession` before
returning; released on every `doOpen` exit path (displacement,
`onConnectionFailed`, `onStalled`, successful transition to `streamSessions`).

Regression test: `concurrent attach distribution (race regression) > 12
concurrent attaches distribute no more than 6 per session` in
`src/nvr/__tests__/client.test.ts`.

### Cause 2: post-await login storm on Recorded-tab switch — fixed

After cause 1 was fixed, switching to the Recorded tab while all 12 live
streams still held slots produced a different 400 signature: **5 parallel
`extra session login starting` lines in the same millisecond**, followed by
3 `doLogin: status=fail` rejections and `openOne FAILED — no session
available` on multiple channels.

The sequence:

1. 12 live slots consumed, primary + extra 1 both at cap.
2. `playback-manager.openAll` calls `acquirePlaybackSlot` ×12.
3. First caller finds no room, starts login #3. Others await it via
   `pendingExtraSessions` — correct so far.
4. Login #3 resolves. ~12 awaiters resume. First 6 claim slots on the new
   session. Awaiters 7+ see the session is now at cap and **each falls
   through to `startExtraSessionLogin()` independently**, spawning N
   parallel logins in the same millisecond.
5. NVR tolerates ~4 concurrent logins (probe 07) but rejects more under
   load → `doLogin: status=fail`.

#### Fix

`getAvailableSession` became a bounded retry loop. After awaiting a pending
login, overflow callers `continue` back to the top of the loop; whichever
runs first synchronously starts one new login and pushes it to
`pendingExtraSessions`; the rest see that pending on their next iteration
and piggyback on it — not one login per overflow caller.

Regression test: `post-await cap check does not spawn a login per overflow
caller` in `src/nvr/__tests__/client.test.ts`. Asserts `maxConcurrent ≤ 2`
and `totalStarted ≤ 3` when 18 slots are acquired in parallel.

### Cause 3: 8x playback chop — fixed by GOP-aware ACK pacing

User report: at 8x in single-cam Recorded view, playback starts smooth
(~3–4 fps visible for 4–5s) then degrades to ~1 frame per second wall,
each showing 8s of advance. Earlier attempts (timebase pause sync,
re-anchor on late samples) made it worse.

Probes 09 + 10 pinned the root cause:

1. **Probe 09** — ACKing every keyframe immediately produced a sustained
   **127x effective rate**. Server can blast keyframes at 60–130 kf/s
   (GOP=2s) when unthrottled. The "1 fps" is NOT server-limited.

2. **Probe 10** — Sweeping ACK gap across 250/500/750/1000 ms showed the
   server consistently releases **exactly 3 keyframes per ACK**, and the
   effective rate scales linearly: `rate = 3 × GOP / ACK_gap_sec`. At
   GOP=2s, a 750 ms ACK gap yields ~8x.

What was happening: in keyframe mode the client's old ACK formula
(`ACK_GAP_MS_AT_1X / speed` = 12.5 ms at 8x) invited the server to burst
at 127x. Display layer at `rate=8` could only drain 4 kf/s, so iOS dropped
most samples — visible as 1 fps with big jumps. The PTS-lead pacing pause
fired too, making bursts worse.

#### Fix

In `playback-connection.ts`:
- `schedulePacedAck` uses `(framesPerAck × observedGopSec × 1000) / speed`
  in keyframe mode. `observedGopSec` tracks the median PTS delta between
  recent keyframes (defaults to 2s until sampled).
- `scheduleFrameDelivery` skips the `PACING_LEAD_MS` pause when
  `isKeyFrameMode` — ACK cadence controls rate; the lead-based pause was
  the wrong tool and actively harmful.
- `restart()` resets GOP-observer state (different cameras/modes can have
  different GOPs).

Result: ~4 fps smooth at 8x matching the expected display rate for the
observed 2s GOP.

## Running the probes

```sh
npx tsx src/nvr/__tests__/integration/01-session-cap.ts
# ... etc
```

Probes 20–22 must be run from the project root (they use relative imports
into `../../`):

```sh
cd /path/to/cameraview
npx tsx src/nvr/__tests__/integration/22-coldlaunch-fullsim.ts
```

Credentials live in `src/nvr/__tests__/integration/credentials.json`
(gitignored). Results are written to `results/` (also gitignored).
