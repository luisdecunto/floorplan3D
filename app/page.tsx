"use client";

/* eslint-disable @next/next/no-img-element */

import {
  ArrowRight,
  Box,
  Check,
  ChevronLeft,
  CircleHelp,
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
  Smartphone,
  Sparkles,
  X,
} from "lucide-react";
import { ChangeEvent, lazy, ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { sampleLevels, type Level } from "./scene-data";

const TwinViewer = lazy(() => import("./twin-viewer"));

type AppStage = "welcome" | "analyzing" | "workspace";
type ViewMode = "review" | "twin";

type SourceRegion = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

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

async function findPlanRegions(url: string): Promise<SourceRegion[]> {
  try {
    const image = await loadImage(url);
    const maxSide = 720;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return [];
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;

    const cols = 56;
    const rows = Math.max(28, Math.round((height / width) * cols));
    const occupied = new Uint8Array(cols * rows);
    for (let gy = 0; gy < rows; gy += 1) {
      for (let gx = 0; gx < cols; gx += 1) {
        const x0 = Math.floor((gx / cols) * width);
        const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / cols) * width));
        const y0 = Math.floor((gy / rows) * height);
        const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / rows) * height));
        let dark = 0;
        let sampled = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const index = (y * width + x) * 4;
            const luminance = 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
            if (pixels[index + 3] > 32 && luminance < 205) dark += 1;
            sampled += 1;
          }
        }
        if (sampled > 0 && dark / sampled > 0.035) occupied[gy * cols + gx] = 1;
      }
    }

    const expanded = new Uint8Array(occupied.length);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (!occupied[y * cols + x]) continue;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) expanded[ny * cols + nx] = 1;
          }
        }
      }
    }

    const visited = new Uint8Array(expanded.length);
    const boxes: Array<{ minX: number; minY: number; maxX: number; maxY: number; cells: number }> = [];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const start = y * cols + x;
        if (!expanded[start] || visited[start]) continue;
        const queue: Array<[number, number]> = [[x, y]];
        visited[start] = 1;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let cells = 0;
        for (let cursor = 0; cursor < queue.length; cursor += 1) {
          const [cx, cy] = queue[cursor];
          cells += 1;
          minX = Math.min(minX, cx);
          maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy);
          maxY = Math.max(maxY, cy);
          const neighbors: Array<[number, number]> = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
          neighbors.forEach(([nx, ny]) => {
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
            const next = ny * cols + nx;
            if (!expanded[next] || visited[next]) return;
            visited[next] = 1;
            queue.push([nx, ny]);
          });
        }
        const boxWidth = maxX - minX + 1;
        const boxHeight = maxY - minY + 1;
        if (cells >= 22 && boxWidth >= 6 && boxHeight >= 6) boxes.push({ minX, minY, maxX, maxY, cells });
      }
    }

    const selected = boxes
      .sort((a, b) => b.cells - a.cells)
      .slice(0, 4)
      .sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));

    if (!selected.length) {
      return [{ id: "ground", name: "Floor 1", x: 0.03, y: 0.03, width: 0.94, height: 0.94, confidence: 0.58 }];
    }

    return selected.map((box, index) => ({
      id: index === 0 ? "ground" : index === 1 ? "upper" : `level-${index + 1}`,
      name: index === 0 ? "Ground floor" : index === 1 ? "First floor" : `Floor ${index + 1}`,
      x: Math.max(0, (box.minX - 1) / cols),
      y: Math.max(0, (box.minY - 1) / rows),
      width: Math.min(1, (box.maxX - box.minX + 3) / cols),
      height: Math.min(1, (box.maxY - box.minY + 3) / rows),
      confidence: Math.max(0.62, 0.93 - index * 0.05),
    }));
  } catch {
    return [{ id: "ground", name: "Floor 1", x: 0.03, y: 0.03, width: 0.94, height: 0.94, confidence: 0.52 }];
  }
}

export default function Home() {
  const [stage, setStage] = useState<AppStage>("welcome");
  const [viewMode, setViewMode] = useState<ViewMode>("review");
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [regions, setRegions] = useState<SourceRegion[]>(sampleRegions);
  const [activeLevel, setActiveLevel] = useState("ground");
  const [visibleLevels, setVisibleLevels] = useState(() => new Set(["ground", "upper"]));
  const [exploded, setExploded] = useState(false);
  const [analysisStep, setAnalysisStep] = useState(0);
  const [mobilePanel, setMobilePanel] = useState<"levels" | "canvas" | "details">("canvas");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const selectedLevel = sampleLevels.find((level) => level.id === activeLevel) ?? sampleLevels[0];

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0];
    if (!nextFile) return;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setFile(nextFile);
    setImageUrl(nextFile.type.startsWith("image/") ? URL.createObjectURL(nextFile) : null);
  }

  async function analyze(useSample = false) {
    setStage("analyzing");
    setAnalysisStep(0);
    await sleep(420);
    setAnalysisStep(1);
    let proposedRegions = sampleRegions;
    if (!useSample && imageUrl) proposedRegions = await findPlanRegions(imageUrl);
    await sleep(520);
    setAnalysisStep(2);
    await sleep(560);
    setRegions(proposedRegions);
    setActiveLevel(proposedRegions[0]?.id ?? "ground");
    setVisibleLevels(new Set(proposedRegions.slice(0, 2).map((region) => region.id)));
    setStage("workspace");
  }

  function toggleLevel(id: string) {
    setVisibleLevels((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (stage === "analyzing") return <AnalysisScreen step={analysisStep} />;

  if (stage === "workspace") {
    return (
      <Workspace
        activeLevel={activeLevel}
        exploded={exploded}
        imageUrl={imageUrl}
        mobilePanel={mobilePanel}
        regions={regions}
        selectedLevel={selectedLevel}
        setActiveLevel={setActiveLevel}
        setExploded={setExploded}
        setMobilePanel={setMobilePanel}
        setStage={setStage}
        setViewMode={setViewMode}
        toggleLevel={toggleLevel}
        viewMode={viewMode}
        visibleLevels={visibleLevels}
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
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.svg,.dxf,.dwg"
              onChange={chooseFile}
              className="visually-hidden"
            />
            {!file ? (
              <button className="drop-zone" onClick={() => fileInputRef.current?.click()}>
                <span className="upload-icon"><ImageUp size={24} /></span>
                <span className="drop-copy">
                  <strong>Upload your floorplan</strong>
                  <small>JPG, PNG, PDF, SVG or CAD file</small>
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
            <p className="privacy-note"><ShieldCheck size={13} /> Private project by default. You control retention.</p>
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
        <Promise icon={<Layers3 size={19} />} title="Multi-level" copy="Separate, align and stack every floor." />
        <Promise icon={<Ruler size={19} />} title="Real dimensions" copy="Recover scale or calibrate one known length." />
        <Promise icon={<Smartphone size={19} />} title="Made for mobile" copy="Review your model from wherever you are." />
      </section>
    </main>
  );
}

function Workspace({
  activeLevel,
  exploded,
  imageUrl,
  mobilePanel,
  regions,
  selectedLevel,
  setActiveLevel,
  setExploded,
  setMobilePanel,
  setStage,
  setViewMode,
  toggleLevel,
  viewMode,
  visibleLevels,
}: {
  activeLevel: string;
  exploded: boolean;
  imageUrl: string | null;
  mobilePanel: "levels" | "canvas" | "details";
  regions: SourceRegion[];
  selectedLevel: Level;
  setActiveLevel: (id: string) => void;
  setExploded: (value: boolean) => void;
  setMobilePanel: (panel: "levels" | "canvas" | "details") => void;
  setStage: (stage: AppStage) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleLevel: (id: string) => void;
  viewMode: ViewMode;
  visibleLevels: Set<string>;
}) {
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <button className="back-button" onClick={() => setStage("welcome")} aria-label="Back to upload"><ChevronLeft size={20} /></button>
        <Brand compact />
        <div className="project-name"><span>Project</span><strong>Sample residence</strong></div>
        <div className="workspace-status"><span className="saved-dot" />Saved on this device</div>
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
              const level = sampleLevels[index] ?? sampleLevels[1];
              const selected = activeLevel === region.id;
              const visible = visibleLevels.has(region.id);
              return (
                <button key={region.id} className={`level-card ${selected ? "selected" : ""}`} onClick={() => setActiveLevel(region.id)}>
                  <span className="level-thumb"><PlanLines variant={index === 0 ? "ground" : "upper"} /></span>
                  <span className="level-card-copy">
                    <small>{index === 0 ? "BASE LEVEL" : `LEVEL ${index + 1}`}</small>
                    <strong>{region.name}</strong>
                    <em>{level.area.toFixed(1)} m² · {Math.round(region.confidence * 100)}% match</em>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="visibility-toggle"
                    aria-label={`${visible ? "Hide" : "Show"} ${region.name}`}
                    onClick={(event) => { event.stopPropagation(); toggleLevel(region.id); }}
                    onKeyDown={(event) => { if (event.key === "Enter") toggleLevel(region.id); }}
                  >
                    {visible ? <Eye size={16} /> : <EyeOff size={16} />}
                  </span>
                </button>
              );
            })}
          </div>
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
              <PlanReview imageUrl={imageUrl} regions={regions} activeLevel={activeLevel} setActiveLevel={setActiveLevel} />
            ) : (
              <Suspense fallback={<div className="viewer-loading"><Box size={22} /><span>Building the 3D twin…</span></div>}>
                <TwinViewer exploded={exploded} visibleLevels={visibleLevels} />
              </Suspense>
            )}
            <div className="canvas-hint">
              {viewMode === "review" ? <><ScanLine size={14} /> Tap a region to review that level</> : <><Move3D size={14} /> Drag to orbit · Pinch to zoom</>}
            </div>
          </div>
        </section>

        <aside className={`detail-panel ${mobilePanel === "details" ? "mobile-active" : ""}`}>
          <div className="panel-heading details-heading">
            <div><span className="panel-kicker">Review status</span><h2>{selectedLevel.name}</h2></div>
            <span className="match-badge"><Check size={13} /> {activeLevel === "ground" ? "96" : "91"}%</span>
          </div>

          <div className="progress-row"><span><i className="complete" /><i className="complete" /><i className="complete" /><i /></span><em>3 of 4 checks</em></div>

          <div className="detail-section">
            <span className="detail-label">Structure</span>
            <div className="stat-grid">
              <div><strong>{selectedLevel.roomCount}</strong><span>rooms</span></div>
              <div><strong>{selectedLevel.wallCount}</strong><span>walls</span></div>
              <div><strong>{selectedLevel.openingCount}</strong><span>openings</span></div>
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
            <div><strong>{selectedLevel.scaleStatus === "resolved" ? "Scale verified" : "One measurement needed"}</strong><p>{selectedLevel.scaleStatus === "resolved" ? "Dimensions agree across this floor." : "Draw a line across a known wall and enter its length."}</p></div>
            <button>{selectedLevel.scaleStatus === "resolved" ? "Review" : "Measure"}</button>
          </div>

          <div className="detail-footer">
            <button className="primary-action">Confirm this level <ArrowRight size={17} /></button>
            <p>The structural detector will replace the sample geometry in the next service milestone.</p>
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

function PlanReview({ imageUrl, regions, activeLevel, setActiveLevel }: { imageUrl: string | null; regions: SourceRegion[]; activeLevel: string; setActiveLevel: (id: string) => void }) {
  return (
    <div className={`plan-review ${imageUrl ? "has-image" : "sample-review"}`}>
      {imageUrl ? <img src={imageUrl} alt="Uploaded floorplan" /> : <SampleSheet />}
      <div className="region-overlay">
        {regions.map((region, index) => (
          <button
            key={region.id}
            className={`region-box ${activeLevel === region.id ? "active" : ""}`}
            style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
            onClick={() => setActiveLevel(region.id)}
          >
            <span>{index + 1}</span><strong>{region.name}</strong><em>{Math.round(region.confidence * 100)}%</em>
          </button>
        ))}
      </div>
    </div>
  );
}

function AnalysisScreen({ step }: { step: number }) {
  const steps = ["Reading the document", "Separating floor regions", "Preparing the review workspace"];
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
        <p className="analysis-note">Structural wall detection is intentionally a separate service milestone.</p>
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

function Promise({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
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
