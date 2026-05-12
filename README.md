# Maple View

[**Download on the App Store →**](https://apps.apple.com/us/app/maple-view-nvr-viewer/id6768069121)

A React Native / Expo iOS app for viewing live and recorded video from a Luma / TVT
NVR. The protocol is reverse-engineered from the device's web client; the
authoritative spec lives in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Features

- [x] 1/4/6/9/12/16-tile live grid + single-camera live view
- [x] Recorded playback: per-camera segments, scrub timeline,
      1×/2×/4×/8× speeds, pause / seek / skip-back
- [x] HQ (4K H.265) mode for live and recorded single-cam
- [x] Backgrounded session recovery + clustered-failure auto-retry
- [x] iOS, iPadOS, and Mac Catalyst
- [ ] Audio (live + recorded) — currently disabled with `audio/close`
      immediately after stream open
- [ ] Event indicators — motion / sensor / AI events (tripwire,
      perimeter, AOI entry/leave, intelligent) via the NVR's
      `state_info/subscribe` and `real_image/subscribe` channels
- [ ] Manual recording trigger
- [ ] Clip download / export (.mp4, via the NVR's `recordBuilder`)
- [ ] Android — the JS protocol stack is platform-agnostic, but the
      native video view (`modules/nvr-video-view/android/`) is a stub;
      a real renderer (e.g. `MediaCodec` + `SurfaceView`) is needed

## Requirements

- macOS with Xcode (current Expo SDK 55 + iOS targets).
- Node 20+.
- An NVR reachable over HTTP or HTTPS (typically on the same local network).
  Prefix the host with `https://` to use HTTPS for the API and WSS for
  WebSocket streams; otherwise plain HTTP / WS is used.

## Setup

Copy each `*.example` file alongside it and fill in your own identifiers:

```bash
cp .env.example .env.local     # APPLE_TEAM_ID — needed for any iOS build
cp app.json.example app.json   # then `eas init` to populate extra.eas.projectId
cp eas.json.example eas.json   # only needed for `eas build` / `eas submit`
```

`APPLE_TEAM_ID` is your 10-character Apple Developer Team ID — find it under
Membership Details on developer.apple.com or in App Store Connect.

## Run

```bash
npm install
npx expo run:ios          # iOS device / simulator
npm run mac               # Mac Catalyst
```

Native module changes (`modules/nvr-video-view/ios/NvrVideoView.swift`) require
a full rebuild. JS-only changes hot-reload.

## Test

```bash
npm test                  # unit tests (vitest)
```

Integration probes against real hardware live in
`src/nvr/__tests__/integration/` and are not auto-run — see that directory's
README for how to point them at an NVR.

## Architecture

Top-level structure:

| Path                             | Purpose                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `app/`                           | Expo Router screens (live, recorded, settings).                               |
| `src/nvr/`                       | Protocol stack: login, WS framing, SHFL demux, stream + playback connections. |
| `src/nvr/client.ts`              | NVR client singleton — orchestrates connect / foreground / hardRetry.         |
| `src/nvr/session-pool.ts`        | Session inventory + slot accounting (live + playback share the cap).          |
| `src/nvr/stream-registry.ts`     | Live-stream lifecycle: connections, sinks, retry chain, detach grace.         |
| `src/nvr/recovery-clusterer.ts`  | Detects clustered failures and triggers auto-recovery.                        |
| `src/nvr/playback-manager.ts`    | Recorded-playback orchestration (sessions, sinks, mode upgrades).             |
| `src/nvr/playback-connection.ts` | One per-channel WS for recorded playback. Pacing, seeks, ACKs.                |
| `src/store/`                     | Zustand stores for camera, playback, session, UI, lifecycle state.            |
| `src/hooks/`                     | React hooks bridging stores and managers to screens.                          |
| `modules/nvr-video-view/`        | Native video module — iOS uses `AVSampleBufferDisplayLayer` + `CMTimebase`; Android is a stub. |
| `docs/`                          | Protocol spec, pacing log, session probes.                                    |

## Documentation

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — authoritative protocol spec.
- [`docs/playback-pacing-log.md`](docs/playback-pacing-log.md) — what's been
  tried for pacing/flow-control and what works.
- [`docs/session-probes.md`](docs/session-probes.md) — session/login probe notes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).
