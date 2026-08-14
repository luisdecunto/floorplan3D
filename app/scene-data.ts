export type Opening = {
  kind: "door" | "window";
  offset: number;
  width: number;
  height: number;
  sill?: number;
  confidence?: number;
};

export type Wall = {
  id: string;
  start: [number, number];
  end: [number, number];
  thickness?: number;
  height?: number;
  openings?: Opening[];
  confidence?: number;
};

export type OutdoorArea = {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  side: "top" | "right" | "bottom" | "left";
  confidence: number;
};

export type Level = {
  id: string;
  name: string;
  shortName: string;
  elevation: number;
  ceilingHeight: number;
  area: number;
  roomCount: number;
  wallCount: number;
  openingCount: number;
  scaleStatus: "resolved" | "needed";
  slab: { width: number; depth: number; x: number; z: number };
  walls: Wall[];
  outdoorAreas?: OutdoorArea[];
  detectionConfidence?: number;
  source?: "sample" | "detected";
};

const groundWalls: Wall[] = [
  { id: "g-south", start: [-5, -3.5], end: [5, -3.5], openings: [{ kind: "door", offset: 1.25, width: 1.1, height: 2.2 }] },
  { id: "g-east", start: [5, -3.5], end: [5, 3.5], openings: [{ kind: "window", offset: 2.1, width: 1.8, height: 1.35, sill: 0.9 }] },
  { id: "g-north", start: [5, 3.5], end: [-5, 3.5], openings: [{ kind: "window", offset: 2.1, width: 2.4, height: 1.35, sill: 0.9 }] },
  { id: "g-west", start: [-5, 3.5], end: [-5, -3.5], openings: [{ kind: "window", offset: 2.6, width: 1.5, height: 1.35, sill: 0.9 }] },
  { id: "g-mid-v", start: [-0.9, -3.5], end: [-0.9, 1.1], openings: [{ kind: "door", offset: 2.25, width: 0.9, height: 2.1 }] },
  { id: "g-mid-h", start: [-5, 1.1], end: [-0.9, 1.1], openings: [{ kind: "door", offset: 2.6, width: 0.85, height: 2.1 }] },
  { id: "g-core", start: [2.2, -0.8], end: [5, -0.8], openings: [{ kind: "door", offset: 1.4, width: 0.85, height: 2.1 }] },
];

const upperWalls: Wall[] = [
  { id: "u-south", start: [-4, -3.5], end: [4, -3.5], openings: [{ kind: "window", offset: 2.7, width: 1.6, height: 1.35, sill: 0.9 }] },
  { id: "u-east", start: [4, -3.5], end: [4, 3.5], openings: [{ kind: "window", offset: 2.2, width: 1.5, height: 1.35, sill: 0.9 }] },
  { id: "u-north", start: [4, 3.5], end: [-4, 3.5], openings: [{ kind: "window", offset: 2.9, width: 2, height: 1.35, sill: 0.9 }] },
  { id: "u-west", start: [-4, 3.5], end: [-4, -3.5], openings: [{ kind: "window", offset: 2.2, width: 1.5, height: 1.35, sill: 0.9 }] },
  { id: "u-mid-v", start: [0.2, -3.5], end: [0.2, 3.5], openings: [{ kind: "door", offset: 1.7, width: 0.9, height: 2.1 }, { kind: "door", offset: 4.9, width: 0.9, height: 2.1 }] },
  { id: "u-mid-h", start: [-4, 0.45], end: [0.2, 0.45], openings: [{ kind: "door", offset: 1.8, width: 0.9, height: 2.1 }] },
];

export const sampleLevels: Level[] = [
  {
    id: "ground",
    name: "Ground floor",
    shortName: "GF",
    elevation: 0,
    ceilingHeight: 2.7,
    area: 67.8,
    roomCount: 4,
    wallCount: groundWalls.length,
    openingCount: 10,
    scaleStatus: "resolved",
    slab: { width: 10, depth: 7, x: 0, z: 0 },
    walls: groundWalls,
    outdoorAreas: [],
    detectionConfidence: 0.96,
    source: "sample",
  },
  {
    id: "upper",
    name: "First floor",
    shortName: "1F",
    elevation: 3.05,
    ceilingHeight: 2.55,
    area: 53.2,
    roomCount: 3,
    wallCount: upperWalls.length,
    openingCount: 9,
    scaleStatus: "needed",
    slab: { width: 8, depth: 7, x: 0, z: 0 },
    walls: upperWalls,
    outdoorAreas: [],
    detectionConfidence: 0.91,
    source: "sample",
  },
];
