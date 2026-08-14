"use client";

/* eslint-disable @next/next/no-img-element */

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Box,
  Check,
  ChevronLeft,
  CircleHelp,
  Download,
  Eye,
  EyeOff,
  ImageUp,
  Layers3,
  Maximize2,
  Menu,
  MoreHorizontal,
  Move3D,
  Ruler,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { ChangeEvent, lazy, ReactNode, Suspense, useEffect, useRef, useState } from "react";
import {
  detectPlanRegions,
  LEVEL_NAME_OPTIONS,
  moveRegion,
  resequenceRegions,
  resizeRegion,
  type SourceRegion,
} from "./plan-regions";
import { sampleLevels, type Level } from "./scene-data";
import {
  addDocumentOpening,
  createFloorplanDocumentV2,
  documentRegions,
  documentStructures,
  realignDocumentStairs,
  removeDocumentWall,
  suggestBuildingOrder,
  undoLastDocumentEdit,
  type FloorplanDocumentV2,
} from "./floorplan-document";
import { downloadProject, loadLatestProjectLocally, parseProject, saveProjectLocally } from "./project-storage";
import {
  alignAdjacentStairStructures,
  detectFloorStructures,
  structureToLevel,
  type DetectedStructure,
} from "./structure-detector";

const TwinViewer = lazy(() => import("./twin-viewer"));

type AppStage = "welcome" | "analyzing" | "workspace";
type ViewMode = "review" | "twin";
type AnalysisSize = { width: number; height: number };
type StructureMap = Record<string, DetectedStructure>;

const sampleRegions: SourceRegion[] = [
  { id: "ground", name: "Ground floor", x: 0.05, y: 0.14, width: 0.42, height: 0.68, confidence: 0.96 },
  { id: "upper", name: "First floor", x: 0.53, y: 0.14, width: 0.42, height: 0.68, confidence: 0.91 },
];

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function loadImage(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

async function inspectFloorplan(url: string): Promise<{ regions: SourceRegion[]; structures: StructureMap; size: AnalysisSize; previewDataUrl?: string }> {
  try {
    const image = await loadImage(url);
    // Preserve thin balcony rails and stair treads. At 900 px the browser's
    // bilinear resize can erase these one-pixel signals in phone screenshots.
    // 1280 px remains modest for mobile memory while retaining the structure.
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let regions = detectPlanRegions(pixels, width, height);
    let structures = detectFloorStructures(pixels, width, height, regions);
    Object.values(structures).forEach((structure) => {
      const cropX = Math.max(0, Math.floor(structure.footprint.x));
      const cropY = Math.max(0, Math.floor(structure.footprint.y));
      const cropWidth = Math.max(1, Math.min(width - cropX, Math.ceil(structure.footprint.width)));
      const cropHeight = Math.max(1, Math.min(height - cropY, Math.ceil(structure.footprint.height)));
      const floorCanvas = document.createElement("canvas");
      floorCanvas.width = cropWidth;
      floorCanvas.height = cropHeight;
      floorCanvas.getContext("2d")?.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      structure.floorTextureUrl = floorCanvas.toDataURL("image/jpeg", 0.86);
    });
    regions = regions.map((region) => ({
      ...region,
      hasOutdoorArea: structures[region.id]?.outdoorAreas.length > 0,
      confidence: structures[region.id]
        ? Math.min(region.confidence, structures[region.id].confidence)
        : region.confidence,
    }));

    // A rail-enclosed exterior platform is useful ordering evidence in a
    // two-level plan: suggest the enclosed plan below the balcony level while
    // retaining the explicit reverse/relabel controls for ambiguous cases.
    regions = suggestBuildingOrder(regions, structures);
    structures = alignAdjacentStairStructures(regions, structures);
    return { regions, structures, size: { width, height }, previewDataUrl: canvas.toDataURL("image/jpeg", 0.9) };
  } catch {
    const regions = [{ id: "ground", name: "Floor 1", x: 0.03, y: 0.03, width: 0.94, height: 0.94, confidence: 0.42 }];
    return { regions, structures: {}, size: { width: 1, height: 1 } };
  }
}

function buildPreviewLevels(regions: SourceRegion[], structures: StructureMap): Level[] {
  return regions.map((region, index) => {
    const detected = structures[region.id];
    if (detected?.walls.length >= 3) return structureToLevel(detected, region, index);
    const template = sampleLevels[Math.min(index, sampleLevels.length - 1)];
    return {
      ...template,
      id: region.id,
      name: region.name,
      shortName: index === 0 ? "BASE" : `${index}F`,
      elevation: index * 3.05,
      detectionConfidence: region.confidence,
    };
  });
}

export default function Home() {
  const [stage, setStage] = useState<AppStage>("welcome");
  const [viewMode, setViewMode] = useState<ViewMode>("review");
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [regions, setRegions] = useState<SourceRegion[]>(sampleRegions);
  const [structures, setStructures] = useState<StructureMap>({});
  const [analysisSize, setAnalysisSize] = useState<AnalysisSize | null>(null);
  const [activeLevel, setActiveLevel] = useState("ground");
  const [visibleLevels, setVisibleLevels] = useState(() => new Set(["ground", "upper"]));
  const [exploded, setExploded] = useState(false);
  const [wallOpacity, setWallOpacity] = useState(1);
  const [analysisStep, setAnalysisStep] = useState(0);
  const [mobilePanel, setMobilePanel] = useState<"levels" | "canvas" | "details">("canvas");
  const [document, setDocument] = useState<FloorplanDocumentV2 | null>(null);
  const [lastProject, setLastProject] = useState<FloorplanDocumentV2 | null>(null);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [projectMessage, setProjectMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  useEffect(() => {
    loadLatestProjectLocally().then(setLastProject).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!document) return;
    const timeout = window.setTimeout(() => {
      saveProjectLocally(document)
        .then(() => setLastProject(document))
        .catch(() => setProjectMessage("Local save is unavailable in this browser."));
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [document]);

  const previewLevels = buildPreviewLevels(regions, structures);
  const selectedRegion = regions.find((region) => region.id === activeLevel) ?? regions[0];
  const selectedLevel = previewLevels.find((level) => level.id === activeLevel) ?? previewLevels[0] ?? sampleLevels[0];

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0];
    if (!nextFile) return;
    const supported = ["image/jpeg", "image/png", "image/webp"].includes(nextFile.type);
    if (!supported || nextFile.size > 20 * 1024 * 1024) {
      setProjectMessage(!supported ? "Choose a JPG, PNG or WebP image." : "This image is larger than the 20 MB limit.");
      event.target.value = "";
      return;
    }
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setFile(nextFile);
    setImageUrl(URL.createObjectURL(nextFile));
    setProjectMessage(null);
  }

  async function analyze(useSample = false) {
    setStage("analyzing");
    setAnalysisStep(0);
    await sleep(420);
    setAnalysisStep(1);
    let proposedRegions = sampleRegions;
    let proposedStructures: StructureMap = {};
    let proposedSize: AnalysisSize | null = null;
    let proposedPreviewDataUrl: string | undefined;
    if (!useSample && imageUrl) {
      const analysis = await inspectFloorplan(imageUrl);
      proposedRegions = analysis.regions;
      proposedStructures = analysis.structures;
      proposedSize = analysis.size;
      proposedPreviewDataUrl = analysis.previewDataUrl;
    }
    await sleep(520);
    setAnalysisStep(2);
    await sleep(460);
    setAnalysisStep(3);
    await sleep(420);
    setRegions(proposedRegions);
    setStructures(proposedStructures);
    setDocument(!useSample && proposedSize && Object.keys(proposedStructures).length ? createFloorplanDocumentV2({
      name: file?.name ?? "Floorplan project",
      mimeType: file?.type ?? "image/unknown",
      width: proposedSize.width,
      height: proposedSize.height,
      regions: proposedRegions,
      structures: proposedStructures,
      previewDataUrl: proposedPreviewDataUrl,
    }) : null);
    setAnalysisSize(proposedSize);
    setActiveLevel(proposedRegions[0]?.id ?? "ground");
    setVisibleLevels(new Set(proposedRegions.slice(0, 2).map((region) => region.id)));
    setWallOpacity(1);
    setSelectedWallId(null);
    setProjectMessage(null);
    setStage("workspace");
  }

  async function importProject(event: ChangeEvent<HTMLInputElement>) {
    const projectFile = event.target.files?.[0];
    if (!projectFile) return;
    try {
      const imported = parseProject(await projectFile.text());
      setDocument(imported);
      setRegions(documentRegions(imported));
      setStructures(documentStructures(imported));
      setImageUrl(imported.source.previewDataUrl ?? null);
      setAnalysisSize({ width: imported.source.width, height: imported.source.height });
      setActiveLevel(imported.levels[0].id);
      setVisibleLevels(new Set(imported.levels.map((level) => level.id)));
      setSelectedWallId(null);
      setProjectMessage("Project imported. The source texture is restored when it was included in the project.");
      setStage("workspace");
    } catch (error) {
      setProjectMessage(error instanceof Error ? error.message : "This project could not be imported.");
    } finally {
      event.target.value = "";
    }
  }

  function openProject(project: FloorplanDocumentV2) {
    setDocument(project);
    setRegions(documentRegions(project));
    setStructures(documentStructures(project));
    setImageUrl(project.source.previewDataUrl ?? null);
    setAnalysisSize({ width: project.source.width, height: project.source.height });
    setActiveLevel(project.levels[0].id);
    setVisibleLevels(new Set(project.levels.map((level) => level.id)));
    setSelectedWallId(null);
    setProjectMessage("Local project restored.");
    setStage("workspace");
  }

  function removeSelectedWall() {
    if (!document || !selectedWallId) return;
    const next = removeDocumentWall(document, activeLevel, selectedWallId);
    setDocument(next);
    setStructures(documentStructures(next));
    setSelectedWallId(null);
    setProjectMessage("Wall removed and the space marked open. Undo is available.");
  }

  function addOpening(kind: "door" | "window") {
    if (!document || !selectedWallId) return;
    const next = addDocumentOpening(document, activeLevel, selectedWallId, kind);
    setDocument(next);
    setStructures(documentStructures(next));
    setProjectMessage(`${kind === "door" ? "Door" : "Window"} added at the wall midpoint. Drag positioning is the next editor refinement.`);
  }

  function undoEdit() {
    if (!document) return;
    const next = undoLastDocumentEdit(document);
    setDocument(next);
    setStructures(documentStructures(next));
    setProjectMessage("Last structural edit undone.");
  }

  function alignStairs() {
    if (!document) return;
    const next = realignDocumentStairs(document);
    setDocument(next);
    setStructures(documentStructures(next));
    setProjectMessage("Stair shafts aligned across adjacent floors.");
  }

  function confirmLevel() {
    if (!document) return;
    const now = new Date().toISOString();
    setDocument({
      ...document,
      updatedAt: now,
      levels: document.levels.map((level) => level.id === activeLevel ? { ...level, confirmed: true } : level),
      issues: document.issues.map((issue) => (
        issue.levelId === activeLevel || issue.code === "floor-order" ? { ...issue, resolved: true } : issue
      )),
    });
    setProjectMessage(`${selectedRegion.name} confirmed.`);
  }

  function toggleLevel(id: string) {
    setVisibleLevels((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function moveLevel(id: string, offset: -1 | 1) {
    setRegions((current) => {
      const next = moveRegion(current, id, offset);
      setDocument((project) => project ? {
        ...project,
        updatedAt: new Date().toISOString(),
        levels: next.map((region, order) => {
          const level = project.levels.find((candidate) => candidate.id === region.id)!;
          return { ...level, order, elevation: order * 3.05, name: region.name, sourceRegion: region };
        }),
      } : project);
      return next;
    });
  }

  function reverseLevelOrder() {
    setRegions((current) => {
      const next = resequenceRegions([...current].reverse());
      setDocument((project) => project ? {
        ...project,
        updatedAt: new Date().toISOString(),
        levels: next.map((region, order) => {
          const level = project.levels.find((candidate) => candidate.id === region.id)!;
          return { ...level, order, elevation: order * 3.05, name: region.name, sourceRegion: region };
        }),
      } : project);
      return next;
    });
  }

  function renameLevel(id: string, name: string) {
    setRegions((current) => current.map((region) => (
      region.id === id ? { ...region, name, nameEdited: true } : region
    )));
    setDocument((project) => project ? {
      ...project,
      updatedAt: new Date().toISOString(),
      levels: project.levels.map((level) => level.id === id ? {
        ...level,
        name,
        sourceRegion: { ...level.sourceRegion, name, nameEdited: true },
      } : level),
    } : project);
  }

  function resizeLevelBoundary(id: string, amount: number) {
    setRegions((current) => current.map((region) => (
      region.id === id ? resizeRegion(region, amount) : region
    )));
    setDocument((project) => project ? {
      ...project,
      updatedAt: new Date().toISOString(),
      levels: project.levels.map((level) => level.id === id ? {
        ...level,
        sourceRegion: resizeRegion(level.sourceRegion, amount),
      } : level),
    } : project);
  }

  function toggleOutdoorArea(id: string, included: boolean) {
    setRegions((current) => current.map((region) => {
      if (region.id !== id) return region;
      const next = { ...region, hasOutdoorArea: included };
      return included && !region.hasOutdoorArea ? resizeRegion(next, 0.035) : next;
    }));
    setDocument((project) => project ? {
      ...project,
      updatedAt: new Date().toISOString(),
      levels: project.levels.map((level) => level.id === id ? {
        ...level,
        sourceRegion: { ...level.sourceRegion, hasOutdoorArea: included },
      } : level),
    } : project);
  }

  if (stage === "analyzing") return <AnalysisScreen step={analysisStep} />;

  if (stage === "workspace") {
    return (
      <Workspace
        activeLevel={activeLevel}
        addOpening={addOpening}
        alignStairs={alignStairs}
        analysisSize={analysisSize}
        confirmLevel={confirmLevel}
        document={document}
        exploded={exploded}
        imageUrl={imageUrl}
        mobilePanel={mobilePanel}
        moveLevel={moveLevel}
        previewLevels={previewLevels}
        projectMessage={projectMessage}
        regions={regions}
        renameLevel={renameLevel}
        resizeLevelBoundary={resizeLevelBoundary}
        reverseLevelOrder={reverseLevelOrder}
        removeSelectedWall={removeSelectedWall}
        selectedLevel={selectedLevel}
        selectedRegion={selectedRegion}
        selectedWallId={selectedWallId}
        structures={structures}
        setActiveLevel={setActiveLevel}
        setExploded={setExploded}
        setMobilePanel={setMobilePanel}
        setSelectedWallId={setSelectedWallId}
        setStage={setStage}
        setViewMode={setViewMode}
        setWallOpacity={setWallOpacity}
        toggleLevel={toggleLevel}
        toggleOutdoorArea={toggleOutdoorArea}
        undoEdit={undoEdit}
        viewMode={viewMode}
        visibleLevels={visibleLevels}
        wallOpacity={wallOpacity}
      />
    );
  }

  return (
    <main className="welcome-shell">
      <header className="marketing-header">
        <Brand />
        <div className="header-actions">
          <span className="prototype-pill"><span /> Early build</span>
          <button className="icon-button mobile-only" aria-label="Open menu"><Menu size={20} /></button>
        </div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow"><Sparkles size={14} /> Structure before decoration</p>
          <h1>Your home,<br /><em>rebuilt in space.</em></h1>
          <p className="hero-lede">
            Turn an ordinary floorplan into a precise, multi-level digital twin you can inspect from every angle.
          </p>

          <div className="upload-panel">
            <input ref={projectInputRef} type="file" accept="application/json,.json" onChange={importProject} className="visually-hidden" />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={chooseFile}
              className="visually-hidden"
            />
            {!file ? (
              <button className="drop-zone" onClick={() => fileInputRef.current?.click()}>
                <span className="upload-icon"><ImageUp size={24} /></span>
                <span className="drop-copy">
                  <strong>Upload your floorplan</strong>
                  <small>JPG, PNG or WebP · up to 20 MB</small>
                </span>
                <span className="browse-label">Choose file</span>
              </button>
            ) : (
              <div className="file-ready">
                <span className="file-type">{file.name.split(".").pop()?.toUpperCase().slice(0, 4) || "FILE"}</span>
                <span className="file-copy"><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB · Ready to inspect</small></span>
                <button className="icon-button" onClick={() => { setFile(null); setImageUrl(null); }} aria-label="Remove file"><X size={18} /></button>
              </div>
            )}

            <button className="primary-action" disabled={!file} onClick={() => analyze(false)}>
              Find floors <ArrowRight size={18} />
            </button>
            <button className="sample-action" onClick={() => analyze(true)}>
              Explore the sample residence
            </button>
            <button className="sample-action import-project-action" onClick={() => projectInputRef.current?.click()}>
              <Upload size={13} /> Import a V2 project
            </button>
            {lastProject && (
              <button className="resume-project-action" onClick={() => openProject(lastProject)}>
                <span><strong>Continue {lastProject.name}</strong><small>Saved {new Date(lastProject.updatedAt).toLocaleString()}</small></span>
                <ArrowRight size={16} />
              </button>
            )}
            {projectMessage && <p className="project-message">{projectMessage}</p>}
            <p className="privacy-note"><ShieldCheck size={13} /> Analysis and project storage stay on this device.</p>
          </div>
        </div>

        <div className="hero-visual" aria-label="Two-level floorplan becoming a 3D building">
          <div className="visual-caption visual-caption-top"><ScanLine size={15} /><span>2 plans found</span></div>
          <div className="paper-plan paper-plan-back"><PlanLines variant="upper" /></div>
          <div className="paper-plan paper-plan-front"><PlanLines variant="ground" /></div>
          <div className="height-guide"><span>5.25 m</span></div>
          <div className="visual-caption visual-caption-bottom"><Box size={15} /><span>Metric structure</span></div>
        </div>
      </section>

      <section className="promise-strip" aria-label="Product capabilities">
        <PromiseCard icon={<Layers3 size={19} />} title="Multi-level" copy="Separate, align and stack every floor." />
        <PromiseCard icon={<Ruler size={19} />} title="Real dimensions" copy="Recover scale or calibrate one known length." />
        <PromiseCard icon={<Smartphone size={19} />} title="Made for mobile" copy="Review your model from wherever you are." />
      </section>
    </main>
  );
}

function Workspace({
  activeLevel,
  addOpening,
  alignStairs,
  analysisSize,
  confirmLevel,
  document,
  exploded,
  imageUrl,
  mobilePanel,
  moveLevel,
  previewLevels,
  projectMessage,
  regions,
  renameLevel,
  resizeLevelBoundary,
  reverseLevelOrder,
  removeSelectedWall,
  selectedLevel,
  selectedRegion,
  selectedWallId,
  structures,
  setActiveLevel,
  setExploded,
  setMobilePanel,
  setSelectedWallId,
  setStage,
  setViewMode,
  setWallOpacity,
  toggleLevel,
  toggleOutdoorArea,
  undoEdit,
  viewMode,
  visibleLevels,
  wallOpacity,
}: {
  activeLevel: string;
  addOpening: (kind: "door" | "window") => void;
  alignStairs: () => void;
  analysisSize: AnalysisSize | null;
  confirmLevel: () => void;
  document: FloorplanDocumentV2 | null;
  exploded: boolean;
  imageUrl: string | null;
  mobilePanel: "levels" | "canvas" | "details";
  moveLevel: (id: string, offset: -1 | 1) => void;
  previewLevels: Level[];
  projectMessage: string | null;
  regions: SourceRegion[];
  renameLevel: (id: string, name: string) => void;
  resizeLevelBoundary: (id: string, amount: number) => void;
  reverseLevelOrder: () => void;
  removeSelectedWall: () => void;
  selectedLevel: Level;
  selectedRegion: SourceRegion;
  selectedWallId: string | null;
  structures: StructureMap;
  setActiveLevel: (id: string) => void;
  setExploded: (value: boolean) => void;
  setMobilePanel: (panel: "levels" | "canvas" | "details") => void;
  setSelectedWallId: (id: string | null) => void;
  setStage: (stage: AppStage) => void;
  setViewMode: (mode: ViewMode) => void;
  setWallOpacity: (opacity: number) => void;
  toggleLevel: (id: string) => void;
  toggleOutdoorArea: (id: string, included: boolean) => void;
  undoEdit: () => void;
  viewMode: ViewMode;
  visibleLevels: Set<string>;
  wallOpacity: number;
}) {
  const selectedWall = structures[activeLevel]?.walls.find((wall) => wall.id === selectedWallId) ?? null;
  const levelIssues = document?.issues.filter((issue) => !issue.levelId || issue.levelId === activeLevel) ?? [];
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <button className="back-button" onClick={() => setStage("welcome")} aria-label="Back to upload"><ChevronLeft size={20} /></button>
        <Brand compact />
        <div className="project-name"><span>V2 project</span><strong>{document?.name ?? "Sample residence"}</strong></div>
        <div className="workspace-status"><span className="saved-dot" />Saved on this device</div>
        {document && <button className="header-tool" onClick={() => downloadProject(document)}><Download size={16} /><span>Export</span></button>}
        {document?.edits.length ? <button className="icon-button" onClick={undoEdit} aria-label="Undo last structural edit"><Undo2 size={18} /></button> : null}
        <button className="icon-button" aria-label="Project options"><MoreHorizontal size={20} /></button>
      </header>

      <div className="workspace-grid">
        <aside className={`level-rail ${mobilePanel === "levels" ? "mobile-active" : ""}`}>
          <div className="panel-heading">
            <div><span className="panel-kicker">Detected structure</span><h2>{regions.length} {regions.length === 1 ? "level" : "levels"}</h2></div>
            <button className="icon-button small" aria-label="Level help"><CircleHelp size={16} /></button>
          </div>
          <p className="panel-intro">Confirm that the plan regions belong to separate floors.</p>
          <div className="level-list">
            {regions.map((region, index) => {
              const level = previewLevels[index] ?? sampleLevels[1];
              const selected = activeLevel === region.id;
              const visible = visibleLevels.has(region.id);
              return (
                <div
                  key={region.id}
                  className={`level-card ${selected ? "selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveLevel(region.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setActiveLevel(region.id);
                  }}
                >
                  <span className="level-thumb"><PlanLines variant={index === 0 ? "ground" : "upper"} /></span>
                  <span className="level-card-copy">
                    <small>{index === 0 ? "BASE LEVEL" : `LEVEL ${index + 1}`}</small>
                    <strong>{region.name}</strong>
                    <em>{level.area.toFixed(1)} m² · {Math.round(region.confidence * 100)}% match{region.hasOutdoorArea ? " · outdoor" : ""}</em>
                  </span>
                  <span className="level-card-actions">
                    <button
                      disabled={index === 0}
                      aria-label={`Move ${region.name} down in the building`}
                      onClick={(event) => { event.stopPropagation(); moveLevel(region.id, -1); }}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      disabled={index === regions.length - 1}
                      aria-label={`Move ${region.name} up in the building`}
                      onClick={(event) => { event.stopPropagation(); moveLevel(region.id, 1); }}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      className="visibility-toggle"
                      aria-label={`${visible ? "Hide" : "Show"} ${region.name}`}
                      onClick={(event) => { event.stopPropagation(); toggleLevel(region.id); }}
                    >
                      {visible ? <Eye size={16} /> : <EyeOff size={16} />}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
          {regions.length > 1 && (
            <button className="secondary-button" onClick={reverseLevelOrder}><ArrowUpDown size={16} /> Reverse floor order</button>
          )}
          <button className="secondary-button"><ScanLine size={16} /> Split or add a level</button>
          <div className="rail-tip"><Sparkles size={15} /><span>We use whitespace, labels and disconnected structure to propose separate floors.</span></div>
        </aside>

        <section className={`canvas-panel ${mobilePanel === "canvas" ? "mobile-active" : ""}`}>
          <div className="canvas-toolbar">
            <div className="view-switch" role="group" aria-label="View mode">
              <button className={viewMode === "review" ? "active" : ""} onClick={() => setViewMode("review")}><ScanLine size={16} /> Plan review</button>
              <button className={viewMode === "twin" ? "active" : ""} onClick={() => setViewMode("twin")}><Box size={16} /> 3D twin</button>
            </div>
            <div className="canvas-actions">
              {viewMode === "twin" && <button className={`toolbar-button ${exploded ? "active" : ""}`} onClick={() => setExploded(!exploded)}><Move3D size={16} /> Explode</button>}
              <button className="toolbar-button desktop-only"><Maximize2 size={16} /> Fit</button>
            </div>
          </div>

          <div className="canvas-stage">
            {viewMode === "review" ? (
              <PlanReview
                imageUrl={imageUrl}
                regions={regions}
                structures={structures}
                analysisSize={analysisSize}
                activeLevel={activeLevel}
                selectedWallId={selectedWallId}
                setActiveLevel={setActiveLevel}
                setSelectedWallId={setSelectedWallId}
              />
            ) : (
              <Suspense fallback={<div className="viewer-loading"><Box size={22} /><span>Building the 3D twin…</span></div>}>
                <TwinViewer exploded={exploded} levels={previewLevels} visibleLevels={visibleLevels} wallOpacity={wallOpacity} />
              </Suspense>
            )}
            {viewMode === "twin" && (
              <label className="wall-opacity-control">
                <span><SlidersHorizontal size={14} /> Wall opacity</span>
                <input
                  type="range"
                  min="0.15"
                  max="1"
                  step="0.05"
                  value={wallOpacity}
                  onChange={(event) => setWallOpacity(Number(event.target.value))}
                />
                <output>{Math.round(wallOpacity * 100)}%</output>
              </label>
            )}
            <div className="canvas-hint">
              {viewMode === "review" ? <><ScanLine size={14} /> Tap a region to review that level</> : <><Move3D size={14} /> Drag to orbit · Pinch to zoom</>}
            </div>
          </div>
        </section>

        <aside className={`detail-panel ${mobilePanel === "details" ? "mobile-active" : ""}`}>
          <div className="panel-heading details-heading">
            <div><span className="panel-kicker">Review status</span><h2>{selectedLevel.name}</h2></div>
            <span className="match-badge"><Check size={13} /> {Math.round((selectedLevel.detectionConfidence ?? selectedRegion.confidence) * 100)}%</span>
          </div>

          <div className="progress-row"><span><i className="complete" /><i className="complete" /><i className="complete" /><i /></span><em>3 of 4 checks</em></div>

          {projectMessage && <div className="project-message workspace-message">{projectMessage}</div>}

          {document && (
            <div className="detail-section v2-runtime-card">
              <span className="detail-label">V2 reconstruction</span>
              <strong>Editable hybrid structure</strong>
              <p>{document.model.runtime === "geometry-fallback" ? "Geometry and topology fallback active. Semantic model output will use this same review document." : `${document.model.runtime.toUpperCase()} semantic model active.`}</p>
              <button className="inline-action" onClick={alignStairs}><ArrowUpDown size={14} /> Align shared stair shaft</button>
            </div>
          )}

          {document && !selectedWall && (
            <div className="detail-section wall-review-list">
              <span className="detail-label">Wall review</span>
              <p>Select any detected boundary to inspect or mark it as open space.</p>
              <div>
                {(structures[activeLevel]?.walls ?? []).map((wall, index) => (
                  <button key={wall.id} onClick={() => setSelectedWallId(wall.id)}>
                    <span>{index + 1}</span>
                    <strong>{wall.axis === "horizontal" ? "Horizontal" : "Vertical"} wall</strong>
                    <em>{Math.round(wall.confidence * 100)}%</em>
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedWall && (
            <div className="detail-section selected-wall-card">
              <span className="detail-label">Selected boundary</span>
              <strong>{selectedWall.axis === "horizontal" ? "Horizontal" : "Vertical"} wall · {Math.round(selectedWall.confidence * 100)}% evidence</strong>
              <p>If this line is furniture, a dimension, or an open boundary, mark it as open. The original proposal remains in edit history.</p>
              <div className="opening-actions">
                <button onClick={() => addOpening("door")}>Add door</button>
                <button onClick={() => addOpening("window")}>Add window</button>
              </div>
              <button className="danger-action" onClick={removeSelectedWall}><Trash2 size={14} /> Mark as open space</button>
            </div>
          )}

          {levelIssues.length > 0 && (
            <div className="detail-section issue-list">
              <span className="detail-label">Review queue</span>
              {levelIssues.slice(0, 4).map((issue) => <p key={issue.id}>{issue.message}</p>)}
            </div>
          )}

          <div className="detail-section correction-section">
            <span className="detail-label">Level identity</span>
            <label className="level-name-field">
              <span>Which floor is this?</span>
              <select value={selectedRegion.name} onChange={(event) => renameLevel(selectedRegion.id, event.target.value)}>
                {LEVEL_NAME_OPTIONS.map((name) => <option key={name} value={name}>{name}</option>)}
                {!LEVEL_NAME_OPTIONS.includes(selectedRegion.name) && <option value={selectedRegion.name}>{selectedRegion.name}</option>}
              </select>
            </label>
            <label className="outdoor-area-toggle">
              <input
                type="checkbox"
                aria-label="Balcony or terrace belongs to this level"
                checked={Boolean(selectedRegion.hasOutdoorArea)}
                onChange={(event) => toggleOutdoorArea(selectedRegion.id, event.target.checked)}
              />
              <span><strong>Balcony or terrace belongs to this level</strong><small>Includes nearby exterior lines in the plan boundary.</small></span>
            </label>
            <div className="boundary-controls">
              <button onClick={() => resizeLevelBoundary(selectedRegion.id, 0.025)}><Maximize2 size={14} /> Include more</button>
              <button onClick={() => resizeLevelBoundary(selectedRegion.id, -0.025)}><ScanLine size={14} /> Tighten outline</button>
            </div>
          </div>

          <div className="detail-section">
            <span className="detail-label">Structure</span>
            <div className="stat-grid">
              <div><strong>{selectedLevel.roomCount}</strong><span>rooms</span></div>
              <div><strong>{selectedLevel.wallCount}</strong><span>walls</span></div>
              <div><strong>{selectedLevel.openingCount}</strong><span>openings</span></div>
              <div><strong>{selectedLevel.stairs?.length ?? 0}</strong><span>stairs</span></div>
            </div>
          </div>

          <div className="detail-section">
            <span className="detail-label">Dimensions</span>
            <DetailRow label="Floor area" value={`${selectedLevel.area.toFixed(1)} m²`} />
            <DetailRow label="Ceiling" value={`${selectedLevel.ceilingHeight.toFixed(2)} m`} />
            <DetailRow label="Scale" value={selectedLevel.scaleStatus === "resolved" ? "Resolved" : "Measurement needed"} warning={selectedLevel.scaleStatus === "needed"} />
          </div>

          <div className="attention-card">
            <span className="attention-icon"><Ruler size={18} /></span>
            <div><strong>{selectedLevel.source === "detected" ? "Multi-pass structure" : selectedLevel.scaleStatus === "resolved" ? "Scale verified" : "One measurement needed"}</strong><p>{selectedLevel.source === "detected" ? "Thick strokes, wall topology and opening evidence are cross-checked before geometry is accepted." : selectedLevel.scaleStatus === "resolved" ? "Dimensions agree across this floor." : "Draw a line across a known wall and enter its length."}</p></div>
            <button>{selectedLevel.scaleStatus === "resolved" ? "Review" : "Measure"}</button>
          </div>

          <div className="detail-footer">
            <button className="primary-action" onClick={confirmLevel}>Confirm this level <ArrowRight size={17} /></button>
            <p>{selectedLevel.source === "detected" ? "Blue = walls · amber = openings · purple = stairs · green = balcony or terrace. Source-plan details remain visible on the 3D floor." : "The sample demonstrates the review flow with prepared geometry."}</p>
          </div>
        </aside>
      </div>

      <nav className="mobile-nav" aria-label="Workspace panels">
        <button className={mobilePanel === "levels" ? "active" : ""} onClick={() => setMobilePanel("levels")}><Layers3 size={19} /><span>Levels</span></button>
        <button className={mobilePanel === "canvas" ? "active" : ""} onClick={() => setMobilePanel("canvas")}><Box size={19} /><span>Model</span></button>
        <button className={mobilePanel === "details" ? "active" : ""} onClick={() => setMobilePanel("details")}><Ruler size={19} /><span>Review</span></button>
      </nav>
    </main>
  );
}

function PlanReview({
  imageUrl,
  regions,
  structures,
  analysisSize,
  activeLevel,
  selectedWallId,
  setActiveLevel,
  setSelectedWallId,
}: {
  imageUrl: string | null;
  regions: SourceRegion[];
  structures: StructureMap;
  analysisSize: AnalysisSize | null;
  activeLevel: string;
  selectedWallId: string | null;
  setActiveLevel: (id: string) => void;
  setSelectedWallId: (id: string | null) => void;
}) {
  return (
    <div className={`plan-review ${imageUrl ? "has-image" : "sample-review"}`}>
      {imageUrl ? <img src={imageUrl} alt="Uploaded floorplan" /> : <SampleSheet />}
      {analysisSize && (
        <svg
          className="structure-overlay"
          viewBox={`0 0 ${analysisSize.width} ${analysisSize.height}`}
          preserveAspectRatio="none"
          aria-label="Detected walls, openings and exterior areas"
        >
          {regions.flatMap((region) => structures[region.id]?.outdoorAreas.map((area) => (
            <rect
              key={`${region.id}-${area.id}`}
              className={`detected-outdoor ${activeLevel === region.id ? "active" : ""}`}
              x={area.x}
              y={area.y}
              width={area.width}
              height={area.height}
            />
          )) ?? [])}
          {regions.flatMap((region) => structures[region.id]?.stairs.map((stair) => (
            <g key={`${region.id}-${stair.id}`} className={`detected-stair ${activeLevel === region.id ? "active" : ""}`}>
              <rect x={stair.x} y={stair.y} width={stair.width} height={stair.height} />
              {Array.from({ length: Math.min(12, stair.stepCount) }, (_, index) => {
                const count = Math.min(12, stair.stepCount);
                const progress = (index + 1) / (count + 1);
                return stair.runAxis === "vertical"
                  ? <line key={index} x1={stair.x} x2={stair.x + stair.width} y1={stair.y + stair.height * progress} y2={stair.y + stair.height * progress} />
                  : <line key={index} y1={stair.y} y2={stair.y + stair.height} x1={stair.x + stair.width * progress} x2={stair.x + stair.width * progress} />;
              })}
            </g>
          )) ?? [])}
          {regions.flatMap((region) => structures[region.id]?.walls.map((wall) => (
            <g
              key={`${region.id}-${wall.id}`}
              className={`${activeLevel === region.id ? "active" : ""} ${activeLevel === region.id && selectedWallId === wall.id ? "selected" : ""}`}
            >
              <line
                className="detected-wall-hit"
                x1={wall.start[0]}
                y1={wall.start[1]}
                x2={wall.end[0]}
                y2={wall.end[1]}
                strokeWidth={Math.max(14, wall.thickness * 1.8)}
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveLevel(region.id);
                  setSelectedWallId(wall.id);
                }}
              />
              <line
                className="detected-wall-halo"
                x1={wall.start[0]}
                y1={wall.start[1]}
                x2={wall.end[0]}
                y2={wall.end[1]}
                strokeWidth={Math.max(4, wall.thickness * 1.05)}
              />
              <line
                className="detected-wall"
                x1={wall.start[0]}
                y1={wall.start[1]}
                x2={wall.end[0]}
                y2={wall.end[1]}
                strokeWidth={Math.max(2, wall.thickness * 0.72)}
              />
              {wall.openings.map((opening, index) => {
                const dx = wall.end[0] - wall.start[0];
                const dy = wall.end[1] - wall.start[1];
                const length = Math.max(1, Math.hypot(dx, dy));
                const from = opening.offset / length;
                const to = (opening.offset + opening.width) / length;
                return (
                  <line
                    key={`${wall.id}-opening-${index}`}
                    className={`detected-opening ${opening.kind}`}
                    x1={wall.start[0] + dx * from}
                    y1={wall.start[1] + dy * from}
                    x2={wall.start[0] + dx * to}
                    y2={wall.start[1] + dy * to}
                    strokeWidth={Math.max(4, wall.thickness)}
                  />
                );
              })}
            </g>
          )) ?? [])}
        </svg>
      )}
      <div className="region-overlay">
        {regions.map((region, index) => (
          <button
            key={region.id}
            className={`region-box ${activeLevel === region.id ? "active" : ""}`}
            style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
            onClick={() => setActiveLevel(region.id)}
          >
            <span>{index + 1}</span>
            <strong>{region.name}</strong>
            <em>{Math.round(region.confidence * 100)}%</em>
            {region.hasOutdoorArea && <small>Balcony / terrace detected</small>}
          </button>
        ))}
      </div>
      {analysisSize && <div className="detection-legend"><span className="wall" />Walls <span className="opening" />Doors/windows <span className="stair" />Stairs <span className="outdoor" />Balcony</div>}
    </div>
  );
}

function AnalysisScreen({ step }: { step: number }) {
  const steps = ["Reading the document", "Separating floor regions", "Tracing walls and openings", "Cross-checking the structure"];
  return (
    <main className="analysis-screen">
      <Brand />
      <div className="analysis-card">
        <div className="scan-illustration"><span className="scan-beam" /><PlanLines variant="ground" /></div>
        <p className="eyebrow"><ScanLine size={14} /> Document intake</p>
        <h1>Finding the plans<br />inside your file.</h1>
        <div className="analysis-steps">
          {steps.map((label, index) => (
            <div key={label} className={index < step ? "done" : index === step ? "current" : ""}>
              <span>{index < step ? <Check size={14} /> : index + 1}</span><strong>{label}</strong>
            </div>
          ))}
        </div>
        <p className="analysis-note">Geometry is accepted only when stroke, topology and opening evidence agree.</p>
      </div>
    </main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "compact" : ""}`}>
      <span className="brand-mark"><i /><i /><i /></span>
      <span className="brand-word">PLANFORM</span>
    </div>
  );
}

function PromiseCard({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return <div className="promise"><span>{icon}</span><div><strong>{title}</strong><p>{copy}</p></div></div>;
}

function DetailRow({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className="detail-row"><span>{label}</span><strong className={warning ? "warning" : ""}>{value}</strong></div>;
}

function PlanLines({ variant }: { variant: "ground" | "upper" }) {
  return (
    <div className={`plan-lines ${variant}`}>
      <i className="line line-a" /><i className="line line-b" /><i className="line line-c" /><i className="line line-d" />
      <i className="line line-e" /><i className="line line-f" /><i className="door-swing" /><i className="room-label label-a">LIVING</i><i className="room-label label-b">ROOM</i>
    </div>
  );
}

function SampleSheet() {
  return (
    <div className="sample-sheet">
      <div className="sheet-title"><strong>SAMPLE RESIDENCE</strong><span>PLAN SET · 1:100</span></div>
      <div className="sheet-plan first"><PlanLines variant="ground" /></div>
      <div className="sheet-plan second"><PlanLines variant="upper" /></div>
      <div className="sheet-label first-label">GROUND FLOOR</div>
      <div className="sheet-label second-label">FIRST FLOOR</div>
    </div>
  );
}
