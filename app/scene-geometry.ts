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
  opening: StairwellOpening;
  width: number;
  lowerFlight: {
    start: [number, number];
    end: [number, number];
    fromElevation: number;
    toElevation: number;
    stepCount: number;
  };
  upperFlight: {
    start: [number, number];
    end: [number, number];
    fromElevation: number;
    toElevation: number;
    stepCount: number;
  };
  landing: {
    x: number;
    z: number;
    width: number;
    depth: number;
    elevation: number;
  };
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
  const width = clamp(stair.width * 1.1, 1.4, 2.8);
  const depth = clamp(stair.depth * 0.94, 2, 3.25);
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

function stairEnds(stair: Stair) {
  if (stair.runAxis === "vertical") return {
    front: [stair.x, stair.z + stair.depth * 0.42] as [number, number],
    back: [stair.x, stair.z - stair.depth * 0.42] as [number, number],
  };
  return {
    front: [stair.x + stair.width * 0.42, stair.z] as [number, number],
    back: [stair.x - stair.width * 0.42, stair.z] as [number, number],
  };
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
    const lowerEnds = stairEnds(pair.lowerStair);
    const upperEnds = stairEnds(pair.upperStair);
    const opening = stairwellOpening(upper.level);
    if (!opening) continue;
    const fromElevation = lower.level.elevation + lower.index * explodeDistance + 0.06;
    const toElevation = upper.level.elevation + upper.index * explodeDistance + 0.04;
    const landingElevation = (fromElevation + toElevation) / 2;
    const lowerSteps = Math.round(clamp((landingElevation - fromElevation) / 0.19, 6, 11));
    const upperSteps = Math.round(clamp((toElevation - landingElevation) / 0.19, 6, 11));
    const verticalRun = pair.lowerStair.runAxis === "vertical" && pair.upperStair.runAxis === "vertical";
    const clearance = 0.08;
    const crossSize = verticalRun ? opening.width : opening.depth;
    const runSize = verticalRun ? opening.depth : opening.width;
    const availableCross = Math.max(1.16, crossSize - clearance * 2);
    const baseFlightWidth = clamp(Math.min(lowerCross, upperCross) * 0.5, 0.72, 1.18);
    const flightWidth = Math.max(0.56, Math.min(baseFlightWidth, availableCross / 2));
    const detectedSeparation = verticalRun
      ? Math.abs(lowerEnds.front[0] - upperEnds.front[0])
      : Math.abs(lowerEnds.front[1] - upperEnds.front[1]);
    const desiredSeparation = detectedSeparation > flightWidth * 0.35 ? detectedSeparation : flightWidth * 0.96;
    const laneSeparation = clamp(desiredSeparation, flightWidth * 0.72, Math.max(flightWidth * 0.72, availableCross - flightWidth));
    const laneDirection = verticalRun
      ? Math.sign(lowerEnds.front[0] - upperEnds.front[0]) || 1
      : Math.sign(lowerEnds.front[1] - upperEnds.front[1]) || 1;
    const crossCenter = verticalRun ? opening.x : opening.z;
    const lowerLane = crossCenter + laneDirection * laneSeparation / 2;
    const upperLane = crossCenter - laneDirection * laneSeparation / 2;
    const landingRun = Math.min(flightWidth * 1.08, Math.max(0.62, runSize * 0.34));
    const openingRear = verticalRun ? opening.z - opening.depth / 2 : opening.x - opening.width / 2;
    const openingFront = verticalRun ? opening.z + opening.depth / 2 : opening.x + opening.width / 2;
    const landingRear = openingRear + clearance;
    const landingCenter = landingRear + landingRun / 2;
    const landingJoint = landingRear + landingRun;
    const flightFrontLimit = openingFront - clearance;
    const minimumRun = Math.min(0.48, Math.max(0.24, (flightFrontLimit - landingJoint) * 0.3));
    const fitFront = (value: number) => clamp(value, landingJoint + minimumRun, flightFrontLimit);
    const lowerFront = fitFront(verticalRun ? lowerEnds.front[1] : lowerEnds.front[0]);
    const upperFront = fitFront(verticalRun ? upperEnds.front[1] : upperEnds.front[0]);
    const lowerStart: [number, number] = verticalRun ? [lowerLane, lowerFront] : [lowerFront, lowerLane];
    const lowerLanding: [number, number] = verticalRun ? [lowerLane, landingJoint] : [landingJoint, lowerLane];
    const upperLanding: [number, number] = verticalRun ? [upperLane, landingJoint] : [landingJoint, upperLane];
    const upperEnd: [number, number] = verticalRun ? [upperLane, upperFront] : [upperFront, upperLane];
    const landingSpan = laneSeparation + flightWidth;
    connections.push({
      id: `${lower.level.id}-to-${upper.level.id}`,
      lowerLevelId: lower.level.id,
      upperLevelId: upper.level.id,
      opening,
      width: flightWidth,
      lowerFlight: { start: lowerStart, end: lowerLanding, fromElevation, toElevation: landingElevation, stepCount: lowerSteps },
      upperFlight: { start: upperLanding, end: upperEnd, fromElevation: landingElevation, toElevation, stepCount: upperSteps },
      landing: {
        x: verticalRun ? crossCenter : landingCenter,
        z: verticalRun ? landingCenter : crossCenter,
        width: verticalRun ? landingSpan : landingRun,
        depth: verticalRun ? landingRun : landingSpan,
        elevation: landingElevation,
      },
    });
  }
  return connections;
}
