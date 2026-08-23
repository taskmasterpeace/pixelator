import assert from "node:assert/strict";
import test from "node:test";

import {
  FORGE_DIRECTIONS,
  directionFromVector,
  inspectPngHeader,
  validateForgeManifest,
  type ForgeManifest,
} from "./characterForge.ts";

function pngHeader(width: number, height: number, colorType: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = colorType;
  return bytes;
}

test("classifies all eight orthographic movement sectors in canonical sheet order", () => {
  const vectors = [
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
  ] as const;

  assert.deepEqual(
    vectors.map(([deltaX, deltaY]) => directionFromVector(deltaX, deltaY, "south")),
    FORGE_DIRECTIONS,
  );
});

test("retains the previous facing when the movement vector is zero", () => {
  assert.equal(directionFromVector(0, 0, "north-east"), "north-east");
});

test("accepts the complete 4 by 8, 96 pixel runtime manifest contract", () => {
  const manifest: ForgeManifest = {
    schemaVersion: 1,
    characterId: "road-survivor",
    runId: "run_20260823_001",
    provider: "pixellab-v2",
    source: { name: "road-survivor.png", sha256: "a".repeat(64) },
    prompt: "low top-down road survivor walking with restrained survival weight",
    seed: 230823,
    directions: [...FORGE_DIRECTIONS],
    frameWidth: 96,
    frameHeight: 96,
    frameCount: 4,
    frameDurationMs: 140,
    sheet: {
      path: "sheets/walk-8dir-4f.png",
      width: 384,
      height: 768,
      sha256: "b".repeat(64),
    },
    rawPath: "raw",
    normalizedPath: "normalized",
  };

  assert.deepEqual(validateForgeManifest(manifest), []);
});

test("rejects a manifest that does not contain four frames per direction", () => {
  const invalid = {
    schemaVersion: 1,
    characterId: "road-survivor",
    runId: "run_20260823_001",
    provider: "pixellab-v2",
    source: { name: "road-survivor.png", sha256: "a".repeat(64) },
    prompt: "walk",
    seed: 230823,
    directions: [...FORGE_DIRECTIONS],
    frameWidth: 96,
    frameHeight: 96,
    frameCount: 3,
    frameDurationMs: 140,
    sheet: {
      path: "sheets/walk-8dir-4f.png",
      width: 384,
      height: 768,
      sha256: "b".repeat(64),
    },
    rawPath: "raw",
    normalizedPath: "normalized",
  } as ForgeManifest;

  assert.match(validateForgeManifest(invalid)[0], /four frames/i);
});

test("reads PNG dimensions and alpha support before a forge upload", () => {
  assert.deepEqual(inspectPngHeader(pngHeader(96, 128, 6)), {
    width: 96,
    height: 128,
    hasAlpha: true,
  });
  assert.deepEqual(inspectPngHeader(pngHeader(256, 192, 2)), {
    width: 256,
    height: 192,
    hasAlpha: false,
  });
});

test("rejects bytes that are not a PNG image", () => {
  assert.throws(() => inspectPngHeader(new Uint8Array(33)), /valid png/i);
});
