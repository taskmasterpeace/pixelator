import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import { buildForgeExport, FORGE_EXPORT_DIRECTIONS } from "./forge-export.mjs";

async function makeFrame({
  width = 36,
  height = 52,
  left = 10,
  top = 8,
  bodyWidth = 16,
  bodyHeight = 36,
  color = [92, 59, 44, 255],
} = {}) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = top; y < top + bodyHeight; y += 1) {
    for (let x = left; x < left + bodyWidth; x += 1) {
      const index = (y * width + x) * 4;
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
      pixels[index + 3] = color[3];
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function makeFixture({ emptyUrl = null, offPaletteUrl = null, framesPerDirection = 4 } = {}) {
  const images = new Map();
  const directions = [];
  for (const [directionIndex, direction] of FORGE_EXPORT_DIRECTIONS.entries()) {
    const frames = [];
    for (let frameIndex = 0; frameIndex < framesPerDirection; frameIndex += 1) {
      const url = `https://assets.test/${direction}-${frameIndex}.png`;
      frames.push(url);
      images.set(url, await makeFrame({
        left: 8 + frameIndex * 2,
        top: 5 + ((directionIndex + frameIndex) % 4),
        bodyHeight: 34 + ((directionIndex + frameIndex) % 3),
        color: url === offPaletteUrl ? [0, 255, 255, 255] : [92, 59, 44, 255],
      }));
    }
    directions.push({ direction, frame_count: framesPerDirection, frames });
    images.set(`https://assets.test/rotation-${direction}.png`, await makeFrame());
  }
  if (emptyUrl) {
    images.set(emptyUrl, await makeFrame({ bodyWidth: 0, bodyHeight: 0 }));
  }
  return {
    character: {
      id: "character-1",
      name: "road-survivor",
      rotation_urls: Object.fromEntries(FORGE_EXPORT_DIRECTIONS.map((direction) => [
        direction,
        `https://assets.test/rotation-${direction}.png`,
      ])),
      animations: [{
        animation_type: "walk-8dir-4f",
        display_name: "Walk · 8 directions · 4 frames",
        animation_group_id: "animation-group-1",
        directions,
      }],
    },
    images,
  };
}

function fixtureFetch(images) {
  return async (url) => {
    const frame = images.get(String(url));
    if (!frame) return new Response("missing fixture", { status: 404 });
    return new Response(frame, { status: 200, headers: { "content-type": "image/png" } });
  };
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pixelator-forge-export-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("preserves raw frames and builds a deterministic 4 by 8 normalized sheet", async () => {
  await withTempDirectory(async (outputRoot) => {
    const { character, images } = await makeFixture();
    const sourceBuffer = await makeFrame({ left: 10, top: 8 });
    for (const direction of FORGE_EXPORT_DIRECTIONS) {
      images.set(`https://assets.test/rotation-${direction}.png`, sourceBuffer);
    }

    const first = await buildForgeExport({
      character,
      source: { name: "road-survivor.png", buffer: sourceBuffer },
      characterId: "road-survivor",
      runId: "run-a",
      prompt: "walking with restrained survival weight",
      seed: 230823,
      outputRoot,
      fetchImpl: fixtureFetch(images),
    });
    const second = await buildForgeExport({
      character,
      source: { name: "road-survivor.png", buffer: sourceBuffer },
      characterId: "road-survivor",
      runId: "run-b",
      prompt: "walking with restrained survival weight",
      seed: 230823,
      outputRoot,
      fetchImpl: fixtureFetch(images),
    });

    const sheetMetadata = await sharp(first.sheetPath).metadata();
    assert.equal(sheetMetadata.width, 384);
    assert.equal(sheetMetadata.height, 768);
    assert.equal(sheetMetadata.channels, 4);
    assert.deepEqual(first.manifest.directions, FORGE_EXPORT_DIRECTIONS);
    assert.equal(first.manifest.frameWidth, 96);
    assert.equal(first.manifest.frameHeight, 96);
    assert.equal(first.manifest.frameCount, 4);
    assert.equal(first.manifest.frameDurationMs, 140);
    assert.equal(first.manifest.sheet.sha256.length, 64);
    assert.equal(first.manifest.sheet.sha256, second.manifest.sheet.sha256);
    assert.equal(first.validation.ok, true);
    assert.equal(first.validation.frames.length, 32);
    assert.ok(first.validation.frames.every((frame) => frame.padding >= 2));
    assert.ok(first.validation.directions.every((direction) => direction.feetBandPx <= 2));
    assert.ok(first.validation.directions.every((direction) => direction.centroidDriftPx <= 2));
    assert.ok(first.zipBuffer.byteLength > 1_000);
    assert.ok((await stat(path.join(first.packageRoot, "raw", "walk", "south", "frame_000.png"))).size > 0);
    assert.ok((await stat(path.join(first.packageRoot, "normalized", "walk", "north-east", "frame_003.png"))).size > 0);

    const manifestOnDisk = JSON.parse(await readFile(first.manifestPath, "utf8"));
    assert.equal(manifestOnDisk.sheet.sha256, first.manifest.sheet.sha256);
  });
});

test("rejects an animation missing one of the four required frames", async () => {
  await withTempDirectory(async (outputRoot) => {
    const { character, images } = await makeFixture({ framesPerDirection: 3 });
    const sourceBuffer = await makeFrame();
    await assert.rejects(
      () => buildForgeExport({
        character,
        source: { name: "road-survivor.png", buffer: sourceBuffer },
        characterId: "road-survivor",
        runId: "run-three-frames",
        prompt: "walk",
        seed: 230823,
        outputRoot,
        fetchImpl: fixtureFetch(images),
      }),
      (error) => error.code === "EXPORT_VALIDATION" && /exactly four/i.test(error.message),
    );
  });
});

test("rejects an empty provider frame instead of packing invisible gameplay art", async () => {
  await withTempDirectory(async (outputRoot) => {
    const emptyUrl = "https://assets.test/south-2.png";
    const { character, images } = await makeFixture({ emptyUrl });
    const sourceBuffer = await makeFrame();
    await assert.rejects(
      () => buildForgeExport({
        character,
        source: { name: "road-survivor.png", buffer: sourceBuffer },
        characterId: "road-survivor",
        runId: "run-empty",
        prompt: "walk",
        seed: 230823,
        outputRoot,
        fetchImpl: fixtureFetch(images),
      }),
      (error) => error.code === "EXPORT_VALIDATION" && /south frame 2 is empty/i.test(error.message),
    );
  });
});

test("blocks an export whose generated colors abandon the locked source palette", async () => {
  await withTempDirectory(async (outputRoot) => {
    const offPaletteUrl = "https://assets.test/west-1.png";
    const { character, images } = await makeFixture({ offPaletteUrl });
    const sourceBuffer = await makeFrame({ color: [92, 59, 44, 255] });
    await assert.rejects(
      () => buildForgeExport({
        character,
        source: { name: "road-survivor.png", buffer: sourceBuffer },
        characterId: "road-survivor",
        runId: "run-palette",
        prompt: "walk",
        seed: 230823,
        outputRoot,
        fetchImpl: fixtureFetch(images),
        paletteTolerance: 24,
        paletteDriftThreshold: 0.02,
      }),
      (error) => error.code === "EXPORT_VALIDATION" && /palette drift/i.test(error.message),
    );
  });
});
