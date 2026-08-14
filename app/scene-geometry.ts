import type { Level, Stair } from "./scene-data";

export type StairwellOpening = {
  x: number;
  z: number;
  width: number;
  depth: number;
};

export type SlabPiece = {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
};

export type StairConnection = {
  id: string;
  lowerLevelId: string;
  upperLevelId: string;
  start: [number, number];
  end: [number, number];
  width: number;
  stepCount: number;
  fromElevation: number;
  toElevation: number;
};

export type SceneFootprint = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export function sceneFootprint(levels: Level[]): SceneFootprint {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  levels.forEach((level) => {
    minX = Math.min(minX, level.slab.x - level.slab.width / 2);
    maxX = Math.max(maxX, level.slab.x + level.slab.width / 2);
    minZ = Math.min(minZ, level.slab.z - level.slab.depth / 2);
    maxZ = Math.max(maxZ, level.slab.z + level.slab.depth / 2);
    (level.outdoorAreas ?? []).forEach((area) => {
      minX = Math.min(minX, area.x - area.width / 2);
      maxX = Math.max(maxX, area.x + area.width / 2);
      minZ = Math.min(minZ, area.z - area.depth / 2);
      maxZ = Math.max(maxZ, area.z + area.depth / 2);
    });
  });
  if (!Number.isFinite(minX)) return { minX: -5, maxX: 5, minZ: -4, maxZ: 4, centerX: 0, centerZ: 0 };
  return { minX, maxX, minZ, maxZ, centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2 };
}

export function stairwellOpening(level: Level): StairwellOpening | null {
  const stair = [...(level.stairs ?? [])].sort((a, b) => b.confidence - a.confidence)[0];
  if (!stair) return null;
  const width = clamp(stair.width * 0.7, 0.95, 1.65);
  const depth = clamp(stair.depth * 0.68, 1.35, 2.35);
  const halfWidth = level.slab.width / 2;
  const halfDepth = level.slab.depth / 2;
  return {
    x: clamp(stair.x, level.slab.x - halfWidth + width / 2 + 0.08, level.slab.x + halfWidth - width / 2 - 0.08),
    z: clamp(stair.z, level.slab.z - halfDepth + depth / 2 + 0.08, level.slab.z + halfDepth - depth / 2 - 0.08),
    width,
    depth,
  };
}

export function slabPieces(level: Level, opening: StairwellOpening | null): SlabPiece[] {
  if (!opening) return [{ id: "whole", ...level.slab }];
  const left = level.slab.x - level.slab.width / 2;
  const right = level.slab.x + level.slab.width / 2;
  const back = level.slab.z - level.slab.depth / 2;
  const front = level.slab.z + level.slab.depth / 2;
  const openingLeft = clamp(opening.x - opening.width / 2, left, right);
  const openingRight = clamp(opening.x + opening.width / 2, left, right);
  const openingBack = clamp(opening.z - opening.depth / 2, back, front);
  const openingFront = clamp(opening.z + opening.depth / 2, back, front);
  const pieces: SlabPiece[] = [];
  const add = (id: string, minX: number, maxX: number, minZ: number, maxZ: number) => {
    if (maxX - minX <= 0.04 || maxZ - minZ <= 0.04) return;
    pieces.push({ id, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, width: maxX - minX, depth: maxZ - minZ });
  };
  add("left", left, openingLeft, back, front);
  add("right", openingRight, right, back, front);
  add("back", openingLeft, openingRight, back, openingBack);
  add("front", openingLeft, openingRight, openingFront, front);
  return pieces;
}

function stairEndpoint(stair: Stair, departure: boolean): [number, number] {
  const direction = departure ? 1 : -1;
  if (stair.runAxis === "vertical") return [stair.x, stair.z + direction * stair.depth * 0.42];
  return [stair.x + direction * stair.width * 0.42, stair.z];
}

export function buildStairConnections(levels: Level[], explodeDistance = 0): StairConnection[] {
  const ordered = levels
    .map((level, index) => ({ level, index }))
    .sort((a, b) => a.level.elevation - b.level.elevation);
  const connections: StairConnection[] = [];

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const lower = ordered[index];
    const upper = ordered[index + 1];
    const candidates = (lower.level.stairs ?? []).flatMap((lowerStair) => (
      (upper.level.stairs ?? []).map((upperStair) => ({
        lowerStair,
        upperStair,
        distance: Math.hypot(lowerStair.x - upperStair.x, lowerStair.z - upperStair.z),
      }))
    )).sort((a, b) => a.distance - b.distance || (b.lowerStair.confidence + b.upperStair.confidence) - (a.lowerStair.confidence + a.upperStair.confidence));
    const pair = candidates[0];
    if (!pair) continue;
    const lowerCross = pair.lowerStair.runAxis === "vertical" ? pair.lowerStair.width : pair.lowerStair.depth;
    const upperCross = pair.upperStair.runAxis === "vertical" ? pair.upperStair.width : pair.upperStair.depth;
    const start = stairEndpoint(pair.lowerStair, true);
    const rawEnd = stairEndpoint(pair.upperStair, false);
    const opening = stairwellOpening(upper.level);
    const end: [number, number] = opening ? [
      clamp(rawEnd[0], opening.x - opening.width * 0.42, opening.x + opening.width * 0.42),
      clamp(rawEnd[1], opening.z - opening.depth * 0.42, opening.z + opening.depth * 0.42),
    ] : rawEnd;
    const fromElevation = lower.level.elevation + lower.index * explodeDistance + 0.06;
    const toElevation = upper.level.elevation + upper.index * explodeDistance + 0.04;
    connections.push({
      id: `${lower.level.id}-to-${upper.level.id}`,
      lowerLevelId: lower.level.id,
      upperLevelId: upper.level.id,
      start,
      end,
      width: clamp(Math.min(lowerCross, upperCross) * 0.5, 0.78, 1.18),
      stepCount: Math.round(clamp((toElevation - fromElevation) / 0.19, 12, 20)),
      fromElevation,
      toElevation,
    });
  }
  return connections;
}
