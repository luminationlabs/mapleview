# Contributing

Thanks for your interest. This is a small project; if you'd like to contribute,
please open an issue first to discuss the change.

## Before changing protocol code

The NVR protocol is reverse-engineered from the device's web client. Before
writing code that touches `src/nvr/`:

1. Read [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the authoritative spec for what
   we know about the wire format.
2. Read [`docs/playback-pacing-log.md`](docs/playback-pacing-log.md) before
   touching pacing / flow-control. These are tightly coupled systems where each
   change has non-obvious downstream effects; the log captures what's been
   tried, what worked, and what didn't.
3. Read [`docs/session-probes.md`](docs/session-probes.md) for the session /
   WS-upgrade model and the probe results that pinned down the per-session
   cap and cold-launch races.

Don't guess at protocol behaviour — verify from captures or the reference web
client code.

## Tests

```bash
npm test                  # unit tests, must pass
npm run typecheck         # TypeScript must be clean
```

Integration probes (`src/nvr/__tests__/integration/`) need real hardware and
are not auto-run. If you change pacing, flow-control, or session management,
re-run the relevant probes against an NVR — there's a `harness.ts` helper
and a `credentials.example.json` to copy.

## Style

- New code: short comments. Document non-obvious invariants and surprising
  workarounds; don't restate what well-named code already says.
- Don't reintroduce investigative narrative ("we tried X but it didn't work")
  in inline comments — those go in `docs/playback-pacing-log.md`.
- Prefer editing existing files over creating new ones.

## Bug reports

Include:

- NVR model and firmware version.
- iOS / iPadOS / Mac Catalyst version.
- The repro steps and what you expected vs. saw.
- If pacing is involved: WebSocket capture (a small amount of data is enough)
  is incredibly useful.
