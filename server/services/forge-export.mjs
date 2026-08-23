import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { zipSync } from "fflate";
import sharp from "sharp";

export const FORGE_EXPORT_DIRECTIONS = Object.freeze([
  "south",
  "south-west",
  "west",
  "north-west",
  "north",
  "north-east",
  "east",
  "south-east",
]);

const FRAME_SIZE = 96;
const FRAME_COUNT = 4;
const FRAME_DURATION_MS = 140;
const SHEET_WIDTH = FRAME_SIZE * FRAME_COUNT;
const SHEET_HEIGHT = FRAME_SIZE * FORGE_EXPORT_DIRECTIONS.length;
const CONTENT_LIMIT = 88;
const GROUND_BASELINE = 93;

export class ForgeExportError extends Error {
  constructor(message, { code = "EXPORT", details = null } = {}) {
    super(message);
    this.name = "ForgeExportError";
    this.code = code;
    this.details = details;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeSegment(value, label) {
  const segment = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!segment) throw new ForgeExportError(`${label} is required.`, { code: "EXPORT_INPUT" });
  return segment;
}

function validationFailure(errors) {
  return new ForgeExportError(errors.join(" "), {
    code: "EXPORT_VALIDATION",
    details: { errors },
  });
}

function animationForCharacter(character) {
  return (character.animations || []).find((animation) =>
    animation.animation_type === "walk-8dir-4f" ||
    animation.display_name === "Walk · 8 directions · 4 frames",
  );
}

function alphaStats(data, width, height, channels) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let opaqueCount = 0;
  let sumX = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = channels >= 4 ? data[(y * width + x) * channels + 3] : 255;
      if (alpha <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      opaqueCount += 1;
    }
  }
  if (opaqueCount === 0) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centroidX: sumX / opaqueCount,
    opaqueCount,
  };
}

async function decodePng(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
    bounds: alphaStats(data, info.width, info.height, info.channels),
  };
}

function paletteFromDecoded(decoded) {
  const counts = new Map();
  const { data, width, height, channels } = decoded;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * channels;
    const alpha = channels >= 4 ? data[offset + 3] : 255;
    if (alpha <= 8) continue;
    const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 256)
    .map(([key]) => key.split(",").map(Number));
}

function paletteDrift(decoded, palette, tolerance) {
  if (palette.length === 0 || !decoded.bounds) return 1;
  const maximumSquaredDistance = tolerance * tolerance;
  let opaque = 0;
  let drifted = 0;
  const { data, width, height, channels } = decoded;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * channels;
    const alpha = channels >= 4 ? data[offset + 3] : 255;
    if (alpha <= 8) continue;
    opaque += 1;
    let nearest = Number.POSITIVE_INFINITY;
    for (const [red, green, blue] of palette) {
      const distance =
        (data[offset] - red) ** 2 +
        (data[offset + 1] - green) ** 2 +
        (data[offset + 2] - blue) ** 2;
      if (distance < nearest) nearest = distance;
      if (nearest <= maximumSquaredDistance) break;
    }
    if (nearest > maximumSquaredDistance) drifted += 1;
  }
  return opaque === 0 ? 1 : drifted / opaque;
}

async function fetchPng(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new ForgeExportError(`Could not download provider asset ${url} (${response.status}).`, {
      code: "ASSET_DOWNLOAD",
    });
  }
  return Buffer.from(await response.arrayBuffer());
}

async function collectZipFiles(root, directory = root, output = {}) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectZipFiles(root, absolute, output);
    } else {
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      output[relative] = new Uint8Array(await readFile(absolute));
    }
  }
  return output;
}

export async function buildForgeExport({
  character,
  source,
  characterId,
  runId,
  prompt,
  seed,
  outputRoot,
  fetchImpl = globalThis.fetch,
  paletteTolerance = 48,
  paletteDriftThreshold = 0.08,
}) {
  const characterSlug = safeSegment(characterId, "Character id");
  const runSlug = safeSegment(runId, "Run id");
  if (!Buffer.isBuffer(source?.buffer) || source.buffer.length === 0) {
    throw new ForgeExportError("A non-empty source PNG buffer is required.", { code: "EXPORT_INPUT" });
  }
  if (typeof fetchImpl !== "function") {
    throw new ForgeExportError("A fetch implementation is required for provider assets.", { code: "EXPORT_INPUT" });
  }

  const animation = animationForCharacter(character);
  if (!animation) {
    throw validationFailure(["Character has no walk-8dir-4f animation."]);
  }
  const directionMap = new Map((animation.directions || []).map((direction) => [direction.direction, direction]));
  const structureErrors = [];
  for (const direction of FORGE_EXPORT_DIRECTIONS) {
    const entry = directionMap.get(direction);
    if (!entry) structureErrors.push(`Missing canonical direction ${direction}.`);
    else if (entry.frames?.length !== FRAME_COUNT) {
      structureErrors.push(`${direction} must contain exactly four walk frames.`);
    }
  }
  if (structureErrors.length > 0) throw validationFailure(structureErrors);

  const packageRoot = path.join(outputRoot, characterSlug, runSlug);
  const sourceDirectory = path.join(packageRoot, "source");
  const rawRotationsDirectory = path.join(packageRoot, "raw", "rotations");
  const rawWalkDirectory = path.join(packageRoot, "raw", "walk");
  const normalizedWalkDirectory = path.join(packageRoot, "normalized", "walk");
  const sheetsDirectory = path.join(packageRoot, "sheets");
  await mkdir(path.dirname(packageRoot), { recursive: true });
  await mkdir(packageRoot, { recursive: false });
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(rawRotationsDirectory, { recursive: true }),
    mkdir(rawWalkDirectory, { recursive: true }),
    mkdir(normalizedWalkDirectory, { recursive: true }),
    mkdir(sheetsDirectory, { recursive: true }),
  ]);
  const sourcePath = path.join(sourceDirectory, "south-reference.png");
  await writeFile(sourcePath, source.buffer);

  const rotationEntries = Object.entries(character.rotation_urls || {})
    .filter(([direction, url]) => FORGE_EXPORT_DIRECTIONS.includes(direction) && typeof url === "string");
  await Promise.all(rotationEntries.map(async ([direction, url]) => {
    const buffer = await fetchPng(url, fetchImpl);
    await writeFile(path.join(rawRotationsDirectory, `${direction}.png`), buffer);
  }));

  const rawFrames = [];
  for (const direction of FORGE_EXPORT_DIRECTIONS) {
    const directionDirectory = path.join(rawWalkDirectory, direction);
    await mkdir(directionDirectory, { recursive: true });
    const entry = directionMap.get(direction);
    for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex += 1) {
      const buffer = await fetchPng(entry.frames[frameIndex], fetchImpl);
      const rawPath = path.join(directionDirectory, `frame_${String(frameIndex).padStart(3, "0")}.png`);
      await writeFile(rawPath, buffer);
      rawFrames.push({ direction, frameIndex, buffer, rawPath });
    }
  }

  const decodedFrames = [];
  const emptyErrors = [];
  for (const frame of rawFrames) {
    const decoded = await decodePng(frame.buffer);
    if (!decoded.bounds) {
      emptyErrors.push(`${frame.direction} frame ${frame.frameIndex} is empty.`);
    }
    decodedFrames.push({ ...frame, decoded });
  }
  if (emptyErrors.length > 0) throw validationFailure(emptyErrors);

  const maximumWidth = Math.max(...decodedFrames.map((frame) => frame.decoded.bounds.width));
  const maximumHeight = Math.max(...decodedFrames.map((frame) => frame.decoded.bounds.height));
  const sharedScale = Math.min(CONTENT_LIMIT / maximumWidth, CONTENT_LIMIT / maximumHeight);
  const sourceDecoded = await decodePng(source.buffer);
  const sourcePalette = paletteFromDecoded(sourceDecoded);
  const normalizedFrames = [];

  for (const frame of decodedFrames) {
    const { bounds } = frame.decoded;
    const resizedWidth = Math.max(1, Math.round(bounds.width * sharedScale));
    const resizedHeight = Math.max(1, Math.round(bounds.height * sharedScale));
    const cropped = await sharp(frame.buffer)
      .ensureAlpha()
      .extract({ left: bounds.minX, top: bounds.minY, width: bounds.width, height: bounds.height })
      .resize(resizedWidth, resizedHeight, { kernel: sharp.kernel.nearest, fit: "fill" })
      .png()
      .toBuffer();
    const croppedDecoded = await decodePng(cropped);
    const idealLeft = Math.round(FRAME_SIZE / 2 - croppedDecoded.bounds.centroidX);
    const left = Math.max(2, Math.min(FRAME_SIZE - 2 - resizedWidth, idealLeft));
    const top = GROUND_BASELINE - resizedHeight + 1;
    const normalized = await sharp({
      create: {
        width: FRAME_SIZE,
        height: FRAME_SIZE,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: cropped, left, top }])
      .png()
      .toBuffer();
    const normalizedDirectory = path.join(normalizedWalkDirectory, frame.direction);
    await mkdir(normalizedDirectory, { recursive: true });
    const normalizedPath = path.join(
      normalizedDirectory,
      `frame_${String(frame.frameIndex).padStart(3, "0")}.png`,
    );
    await writeFile(normalizedPath, normalized);
    const decoded = await decodePng(normalized);
    const padding = Math.min(
      decoded.bounds.minX,
      decoded.bounds.minY,
      FRAME_SIZE - 1 - decoded.bounds.maxX,
      FRAME_SIZE - 1 - decoded.bounds.maxY,
    );
    normalizedFrames.push({
      direction: frame.direction,
      frameIndex: frame.frameIndex,
      buffer: normalized,
      path: normalizedPath,
      decoded,
      padding,
      paletteDrift: paletteDrift(decoded, sourcePalette, paletteTolerance),
      sha256: sha256(normalized),
    });
  }

  const frameValidation = normalizedFrames.map((frame) => ({
    direction: frame.direction,
    frameIndex: frame.frameIndex,
    padding: frame.padding,
    footY: frame.decoded.bounds.maxY,
    centroidX: Number(frame.decoded.bounds.centroidX.toFixed(3)),
    paletteDrift: Number(frame.paletteDrift.toFixed(6)),
    sha256: frame.sha256,
  }));
  const directionValidation = FORGE_EXPORT_DIRECTIONS.map((direction) => {
    const frames = frameValidation.filter((frame) => frame.direction === direction);
    const feet = frames.map((frame) => frame.footY);
    const centroids = frames.map((frame) => frame.centroidX);
    return {
      direction,
      feetBandPx: Math.max(...feet) - Math.min(...feet),
      centroidDriftPx: Number((Math.max(...centroids) - Math.min(...centroids)).toFixed(3)),
      maximumPaletteDrift: Math.max(...frames.map((frame) => frame.paletteDrift)),
    };
  });
  const validationErrors = [];
  for (const frame of frameValidation) {
    if (frame.padding < 2) validationErrors.push(`${frame.direction} frame ${frame.frameIndex} has less than two pixels of padding.`);
    if (frame.paletteDrift > paletteDriftThreshold) {
      validationErrors.push(`${frame.direction} frame ${frame.frameIndex} palette drift exceeds the locked threshold.`);
    }
  }
  for (const direction of directionValidation) {
    if (direction.feetBandPx > 2) validationErrors.push(`${direction.direction} feet drift exceeds two pixels.`);
    if (direction.centroidDriftPx > 2) validationErrors.push(`${direction.direction} horizontal centroid drift exceeds two pixels.`);
  }
  if (validationErrors.length > 0) throw validationFailure(validationErrors);

  const composites = normalizedFrames.map((frame) => ({
    input: frame.buffer,
    left: frame.frameIndex * FRAME_SIZE,
    top: FORGE_EXPORT_DIRECTIONS.indexOf(frame.direction) * FRAME_SIZE,
  }));
  const sheetBuffer = await sharp({
    create: {
      width: SHEET_WIDTH,
      height: SHEET_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites).png().toBuffer();
  const sheetPath = path.join(sheetsDirectory, "walk-8dir-4f.png");
  await writeFile(sheetPath, sheetBuffer);

  const manifest = {
    schemaVersion: 1,
    characterId: characterSlug,
    providerCharacterId: character.id,
    providerAnimationGroupId: animation.animation_group_id || null,
    runId: runSlug,
    provider: "pixellab-v2",
    source: {
      name: source.name,
      path: "source/south-reference.png",
      sha256: sha256(source.buffer),
    },
    prompt,
    seed,
    directions: [...FORGE_EXPORT_DIRECTIONS],
    frameWidth: FRAME_SIZE,
    frameHeight: FRAME_SIZE,
    frameCount: FRAME_COUNT,
    frameDurationMs: FRAME_DURATION_MS,
    sheet: {
      path: "sheets/walk-8dir-4f.png",
      width: SHEET_WIDTH,
      height: SHEET_HEIGHT,
      sha256: sha256(sheetBuffer),
    },
    rawPath: "raw",
    normalizedPath: "normalized",
    normalizedFrames: frameValidation,
    validation: {
      paletteTolerance,
      paletteDriftThreshold,
      directions: directionValidation,
    },
  };
  const manifestPath = path.join(packageRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const zipFiles = await collectZipFiles(packageRoot);
  const zipBuffer = Buffer.from(zipSync(zipFiles, { level: 6 }));
  return {
    packageRoot,
    sheetPath,
    manifestPath,
    zipBuffer,
    manifest,
    validation: {
      ok: true,
      frames: frameValidation,
      directions: directionValidation,
      errors: [],
    },
  };
}
