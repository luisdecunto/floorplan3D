import { resequenceRegions, type SourceRegion } from "./plan-regions.ts";
import type { Level } from "./scene-data";
import {
  alignAdjacentStairStructures,
  structureToLevel,
  type DetectedStructure,
} from "./structure-detector.ts";

export const FLOORPLAN_SCHEMA_VERSION = 2 as const;

export type DetectionProvenance = "semantic-model" | "geometry" | "ocr" | "topology" | "user";

export type ReviewIssue = {
  id: string;
  levelId?: string;
  entityId?: string;
  severity: "info" | "warning" | "blocking";
  code:
    | "floor-order"
    | "low-confidence-wall"
    | "missing-stairs"
    | "unaligned-stairs"
    | "outdoor-area"
    | "scale-needed";
  message: string;
  resolved: boolean;
};

export type FloorplanEdit = {
  id: string;
  levelId: string;
  kind: "remove-wall" | "restore-wall" | "add-opening" | "rename-level" | "set-outdoor-area" | "align-stairs";
  entityId?: string;
  createdAt: string;
  before?: unknown;
  after?: unknown;
};

export type FloorplanLevelV2 = {
  id: string;
  name: string;
  order: number;
  elevation: number;
  sourceRegion: SourceRegion;
  structure: DetectedStructure;
  confidence: number;
  provenance: DetectionProvenance[];
  confirmed: boolean;
};

export type FloorplanDocumentV2 = {
  schemaVersion: typeof FLOORPLAN_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  model: {
    version: string;
    runtime: "webgpu" | "wasm" | "geometry-fallback";
  };
  source: {
    name: string;
    mimeType: string;
    width: number;
    height: number;
    previewDataUrl?: string;
  };
  levels: FloorplanLevelV2[];
  issues: ReviewIssue[];
  edits: FloorplanEdit[];
};

/**
 * Outdoor platforms are useful supporting evidence in an otherwise unlabeled
 * two-level sheet: a balcony normally belongs to an upper floor. The source's
 * top/bottom or left/right placement is never used as height by itself.
 */
export function suggestBuildingOrder(
  regions: SourceRegion[],
  structures: Record<string, DetectedStructure>,
) {
  if (regions.length !== 2) return resequenceRegions(regions);
  const withOutdoor = regions.filter((region) => structures[region.id]?.outdoorAreas.length);
  if (withOutdoor.length !== 1) return resequenceRegions(regions);
  return resequenceRegions([
    ...regions.filter((region) => region.id !== withOutdoor[0].id),
    withOutdoor[0],
  ]);
}

function identifier(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildIssues(levels: FloorplanLevelV2[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  if (levels.length > 1 && levels.every((level) => !level.sourceRegion.nameEdited)) {
    issues.push({
      id: "floor-order-review",
      severity: "info",
      code: "floor-order",
      message: "Confirm the detected floor order. Page position is never treated as building height.",
      resolved: false,
    });
  }
  levels.forEach((level) => {
    level.structure.walls
      .filter((wall) => wall.confidence < 0.7)
      .forEach((wall) => issues.push({
        id: `wall-confidence-${level.id}-${wall.id}`,
        levelId: level.id,
        entityId: wall.id,
        severity: "warning",
        code: "low-confidence-wall",
        message: "This wall has weak structural evidence. Review it before generating 3D.",
        resolved: false,
      }));
    if (levels.length > 1 && level.structure.stairs.length === 0) {
      issues.push({
        id: `stairs-missing-${level.id}`,
        levelId: level.id,
        severity: "warning",
        code: "missing-stairs",
        message: "No stair shaft was found on this level.",
        resolved: false,
      });
    }
    if (level.sourceRegion.hasOutdoorArea && level.structure.outdoorAreas.length === 0) {
      issues.push({
        id: `outdoor-manual-${level.id}`,
        levelId: level.id,
        severity: "info",
        code: "outdoor-area",
        message: "Outdoor space was marked manually; verify its extent in plan review.",
        resolved: false,
      });
    }
    issues.push({
      id: `scale-${level.id}`,
      levelId: level.id,
      severity: "info",
      code: "scale-needed",
      message: "Add one known measurement to resolve real-world scale.",
      resolved: false,
    });
  });
  return issues;
}

export function createFloorplanDocumentV2({
  name,
  mimeType,
  width,
  height,
  regions,
  structures,
  previewDataUrl,
}: {
  name: string;
  mimeType: string;
  width: number;
  height: number;
  regions: SourceRegion[];
  structures: Record<string, DetectedStructure>;
  previewDataUrl?: string;
}): FloorplanDocumentV2 {
  const aligned = alignAdjacentStairStructures(regions, structures);
  const now = new Date().toISOString();
  const levels = regions.map((region, order) => ({
    id: region.id,
    name: region.name,
    order,
    elevation: order * 3.05,
    sourceRegion: { ...region },
    structure: aligned[region.id],
    confidence: Math.min(region.confidence, aligned[region.id]?.confidence ?? region.confidence),
    provenance: ["geometry", "topology"] as DetectionProvenance[],
    confirmed: false,
  })).filter((level) => Boolean(level.structure));
  return {
    schemaVersion: FLOORPLAN_SCHEMA_VERSION,
    id: identifier("project"),
    name: name.replace(/\.[^.]+$/, "") || "Floorplan project",
    createdAt: now,
    updatedAt: now,
    model: { version: "v2-geometry-bootstrap", runtime: "geometry-fallback" },
    source: { name, mimeType, width, height, previewDataUrl },
    levels,
    issues: buildIssues(levels),
    edits: [],
  };
}

export function documentRegions(document: FloorplanDocumentV2) {
  return [...document.levels]
    .sort((a, b) => a.order - b.order)
    .map((level) => ({ ...level.sourceRegion, name: level.name }));
}

export function documentStructures(document: FloorplanDocumentV2) {
  return Object.fromEntries(document.levels.map((level) => [level.id, level.structure]));
}

export function documentSceneLevels(document: FloorplanDocumentV2): Level[] {
  return [...document.levels]
    .sort((a, b) => a.order - b.order)
    .map((level, index) => structureToLevel(level.structure, { ...level.sourceRegion, name: level.name }, index));
}

export function updateDocumentLevel(
  document: FloorplanDocumentV2,
  levelId: string,
  updater: (level: FloorplanLevelV2) => FloorplanLevelV2,
  edit?: Omit<FloorplanEdit, "id" | "levelId" | "createdAt">,
): FloorplanDocumentV2 {
  const now = new Date().toISOString();
  return {
    ...document,
    updatedAt: now,
    levels: document.levels.map((level) => level.id === levelId ? updater(level) : level),
    edits: edit ? [...document.edits, { ...edit, id: identifier("edit"), levelId, createdAt: now }] : document.edits,
  };
}

export function removeDocumentWall(document: FloorplanDocumentV2, levelId: string, wallId: string) {
  const level = document.levels.find((candidate) => candidate.id === levelId);
  const wall = level?.structure.walls.find((candidate) => candidate.id === wallId);
  if (!level || !wall) return document;
  return updateDocumentLevel(document, levelId, (current) => ({
    ...current,
    confirmed: false,
    structure: { ...current.structure, walls: current.structure.walls.filter((candidate) => candidate.id !== wallId) },
  }), { kind: "remove-wall", entityId: wallId, before: wall, after: null });
}

export function addDocumentOpening(
  document: FloorplanDocumentV2,
  levelId: string,
  wallId: string,
  kind: "door" | "window",
) {
  const level = document.levels.find((candidate) => candidate.id === levelId);
  const wall = level?.structure.walls.find((candidate) => candidate.id === wallId);
  if (!level || !wall) return document;
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const width = Math.min(length * 0.42, Math.max(12, length * (kind === "door" ? 0.18 : 0.24)));
  const offset = Math.max(0, length / 2 - width / 2);
  const before = [...wall.openings];
  const after = [...before, { kind, offset, width, confidence: 1 }];
  return updateDocumentLevel(document, levelId, (current) => ({
    ...current,
    confirmed: false,
    structure: {
      ...current.structure,
      walls: current.structure.walls.map((candidate) => candidate.id === wallId ? { ...candidate, openings: after } : candidate),
    },
  }), { kind: "add-opening", entityId: wallId, before, after });
}

export function undoLastDocumentEdit(document: FloorplanDocumentV2) {
  const edit = document.edits.at(-1);
  if (!edit) return document;
  if (edit.kind === "remove-wall" && edit.before) {
    const restored = updateDocumentLevel(document, edit.levelId, (level) => ({
      ...level,
      structure: { ...level.structure, walls: [...level.structure.walls, edit.before as DetectedStructure["walls"][number]] },
    }));
    return { ...restored, edits: document.edits.slice(0, -1) };
  }
  if (edit.kind === "add-opening" && Array.isArray(edit.before) && edit.entityId) {
    const restored = updateDocumentLevel(document, edit.levelId, (level) => ({
      ...level,
      structure: {
        ...level.structure,
        walls: level.structure.walls.map((wall) => wall.id === edit.entityId ? {
          ...wall,
          openings: edit.before as DetectedStructure["walls"][number]["openings"],
        } : wall),
      },
    }));
    return { ...restored, edits: document.edits.slice(0, -1) };
  }
  return { ...document, edits: document.edits.slice(0, -1), updatedAt: new Date().toISOString() };
}

export function realignDocumentStairs(document: FloorplanDocumentV2) {
  const regions = documentRegions(document);
  const aligned = alignAdjacentStairStructures(regions, documentStructures(document));
  const now = new Date().toISOString();
  return {
    ...document,
    updatedAt: now,
    levels: document.levels.map((level) => ({ ...level, structure: aligned[level.id] })),
    edits: [...document.edits, {
      id: identifier("edit"),
      levelId: document.levels[0]?.id ?? "building",
      kind: "align-stairs" as const,
      createdAt: now,
    }],
  };
}

export function validateFloorplanDocument(value: unknown): FloorplanDocumentV2 {
  if (!value || typeof value !== "object") throw new Error("Project JSON must contain an object.");
  const candidate = value as Partial<FloorplanDocumentV2>;
  if (candidate.schemaVersion !== FLOORPLAN_SCHEMA_VERSION) throw new Error("This project uses an unsupported schema version.");
  if (!Array.isArray(candidate.levels) || candidate.levels.length === 0) throw new Error("The project contains no levels.");
  if (!candidate.source || !candidate.model || !Array.isArray(candidate.edits) || !Array.isArray(candidate.issues)) {
    throw new Error("The project is incomplete.");
  }
  return candidate as FloorplanDocumentV2;
}
