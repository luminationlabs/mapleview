/**
 * Microbenchmarks for the JS playback hot path.
 *
 * Run:
 *   npm run bench
 *
 * If you see "missing fixtures" errors, regenerate them:
 *   npx tsx bench/fixtures/generate.ts
 *
 * Each `bench()` is a candidate operation that runs in the JS playback
 * pipeline today. The numbers help decide which moves to native are
 * worth the refactor cost.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bench, describe } from "vitest";
import { parseWSFrame } from "../src/nvr/ws-frame";
import { parseSHFL } from "../src/nvr/shfl";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");

const FIXTURE_NAMES = [
  "sub-pframe.bin",
  "sub-keyframe.bin",
  "main-h264-pframe.bin",
  "main-h264-keyframe.bin",
  "main-h265-keyframe.bin",
] as const;
type FixtureName = (typeof FIXTURE_NAMES)[number];

function loadFixture(name: FixtureName): Uint8Array {
  const path = join(FIXTURES_DIR, name);
  if (!existsSync(path)) {
    throw new Error(
      `missing fixture ${path}\n\n` +
        `Regenerate synthetic fixtures:\n` +
        `  npx tsx bench/fixtures/generate.ts\n`,
    );
  }
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const fixtures = Object.fromEntries(
  FIXTURE_NAMES.map((name) => [name, loadFixture(name)]),
) as Record<FixtureName, Uint8Array>;

// Pre-extract intermediate forms so each bench measures one specific stage.
const wsParsed = Object.fromEntries(
  FIXTURE_NAMES.map((name) => [name, parseWSFrame(fixtures[name])]),
) as Record<FixtureName, ReturnType<typeof parseWSFrame>>;

const shflPayloads = Object.fromEntries(
  FIXTURE_NAMES.map((name) => [name, parseSHFL(wsParsed[name].payload).payload]),
) as Record<FixtureName, Uint8Array>;

describe("parseWSFrame (header decode + JSON.parse)", () => {
  for (const name of FIXTURE_NAMES) {
    bench(`${name} (${fixtures[name].byteLength}B)`, () => {
      parseWSFrame(fixtures[name]);
    });
  }
});

describe("parseSHFL (after WS frame parse)", () => {
  for (const name of FIXTURE_NAMES) {
    bench(`${name}`, () => {
      parseSHFL(wsParsed[name].payload);
    });
  }
});

describe("parseWSFrame + parseSHFL (full JS hot path per frame)", () => {
  for (const name of FIXTURE_NAMES) {
    bench(`${name}`, () => {
      const ws = parseWSFrame(fixtures[name]);
      parseSHFL(ws.payload);
    });
  }
});

describe("sink-style payload copy (Uint8Array clone)", () => {
  // Mirrors use-playback.ts:43 — the per-frame allocation that crosses
  // the JS↔native bridge today. Whether this is worth eliminating
  // depends on payload size, so each fixture's NAL size is shown.
  for (const name of FIXTURE_NAMES) {
    const payload = shflPayloads[name];
    bench(`${name} (${payload.byteLength}B NAL)`, () => {
      const _copy = new Uint8Array(payload);
    });
  }
});

describe("subarray (zero-copy alternative)", () => {
  // Reference number: what the sink would cost if we trusted the bridge
  // to handle subarrays. Diff vs the copy bench above quantifies the
  // potential win of dropping the defensive clone.
  for (const name of FIXTURE_NAMES) {
    const payload = shflPayloads[name];
    bench(`${name} (${payload.byteLength}B NAL)`, () => {
      const _view = payload.subarray(0, payload.byteLength);
    });
  }
});
