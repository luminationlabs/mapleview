# bench/

Microbenchmarks for the JS playback hot path. These run in pure Node via
vitest's bench mode, so they're hermetic, fast, and don't need a device or
simulator.

## Fixtures

`bench/fixtures/*.bin` ship as synthetic frames — valid WS + SHFL
framing with deterministic-random payload bytes of the same sizes as
real captures. The parsers under bench (`parseWSFrame`, `parseSHFL`)
only validate the wrapper and slice the payload, so synthetic frames
exercise the same code paths as real ones while keeping camera imagery
out of the repo.

Regenerate them with:

```sh
npx tsx bench/fixtures/generate.ts
```

If you'd rather bench against real captures from your own NVR, run the
capture probe to overwrite the fixtures locally (do not commit):

```sh
npx tsx src/nvr/__tests__/integration/30-capture-frames.ts
```

## Run

```sh
npm run bench
```

Vitest reports `ops/sec ± stddev` per case. To compare a refactor
A/B, run the bench on `main`, save the output, switch to your branch,
run again. Anything that changes by more than ~3× the reported stddev
is real.

## What's covered

- **`parseWSFrame`** — header decode + JSON.parse of the per-frame
  envelope. One of the candidates for moving into native.
- **`parseSHFL`** — fixed-size header reads. Cheap, but called per
  frame, so worth quantifying.
- **Combined hot path** — what `handleBinaryMessage` does for every
  binary WS message before it hits the sink.
- **Sink-style copy** vs **subarray** — the `new Uint8Array(nal)` in
  `use-playback.ts:43` allocates a fresh buffer per frame. The diff
  between these two cases tells you how much of the per-frame budget
  goes to that defensive copy.

Fixtures vary in size (sub P-frame ≈ a few KB, 4K HEVC IDR can be
hundreds of KB), so each case prints byte sizes alongside the name.

## What's not covered here

- JS↔native bridge crossing cost. Microbenches in Node can't measure
  the Expo Modules dispatch; that needs the synthetic feed-loop in the
  simulator described in `docs/playback-pacing-log.md`-adjacent perf
  notes.
- Native-side parsing (`splitAnnexBNALUnits`, `extractParameterSets`,
  `createSampleBuffer`). Those have their own XCTest `measure` block;
  see the iOS module's test target.

## Files

- `parsing.bench.ts` — the bench cases.
- `fixtures/` — committed `.bin` frames + `fixtures.json` metadata + `generate.ts` (synthetic-fixture builder).
- `captures/` — gitignored. Reserved for the longer replay-stream
  capture used by the localhost replay server.
