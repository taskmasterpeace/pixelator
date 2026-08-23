export const FORGE_DIRECTIONS = [
  "south",
  "south-west",
  "west",
  "north-west",
  "north",
  "north-east",
  "east",
  "south-east",
] as const;

export type ForgeDirection = (typeof FORGE_DIRECTIONS)[number];

export interface ForgeManifest {
  schemaVersion: 1;
  characterId: string;
  runId: string;
  provider: "pixellab-v2";
  source: { name: string; sha256: string };
  prompt: string;
  seed: number;
  directions: ForgeDirection[];
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  frameDurationMs: number;
  sheet: { path: string; width: number; height: number; sha256: string };
  rawPath: string;
  normalizedPath: string;
}

export function directionFromVector(
  deltaX: number,
  deltaY: number,
  previous: ForgeDirection = "south",
): ForgeDirection {
  if (deltaX === 0 && deltaY === 0) return previous;
  const clockwiseFromSouth = Math.atan2(-deltaX, deltaY);
  const sector = Math.round(clockwiseFromSouth / (Math.PI / 4));
  return FORGE_DIRECTIONS[(sector + 8) % 8];
}

export function validateForgeManifest(manifest: ForgeManifest): string[] {
  const errors: string[] = [];
  if (
    manifest.directions.length !== FORGE_DIRECTIONS.length ||
    FORGE_DIRECTIONS.some((direction, index) => manifest.directions[index] !== direction)
  ) {
    errors.push("Directions must contain all eight canonical rows in order.");
  }
  if (manifest.frameCount !== 4) {
    errors.push("Every direction must contain exactly four frames.");
  }
  if (manifest.frameWidth !== 96 || manifest.frameHeight !== 96) {
    errors.push("Frames must be 96 by 96 pixels.");
  }
  if (manifest.sheet.width !== 384 || manifest.sheet.height !== 768) {
    errors.push("Sheet must be 384 by 768 pixels.");
  }
  return errors;
}
