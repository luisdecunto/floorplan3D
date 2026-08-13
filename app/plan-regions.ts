export type ComponentBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cells: number;
};

export type SourceRegion = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  hasOutdoorArea?: boolean;
  nameEdited?: boolean;
};

export const LEVEL_NAME_OPTIONS = [
  "Basement",
  "Ground floor",
  "First floor",
  "Second floor",
  "Third floor",
  "Fourth floor",
  "Mezzanine",
  "Attic",
];

function boxWidth(box: ComponentBox) {
  return box.maxX - box.minX + 1;
}

function boxHeight(box: ComponentBox) {
  return box.maxY - box.minY + 1;
}

function axisGap(aMin: number, aMax: number, bMin: number, bMax: number) {
  if (aMax < bMin) return bMin - aMax - 1;
  if (bMax < aMin) return aMin - bMax - 1;
  return 0;
}

function overlap(aMin: number, aMax: number, bMin: number, bMax: number) {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin) + 1);
}

function mergeBoxes(a: ComponentBox, b: ComponentBox): ComponentBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    cells: a.cells + b.cells,
  };
}

function canAttach(component: ComponentBox, core: ComponentBox) {
  const gapX = axisGap(component.minX, component.maxX, core.minX, core.maxX);
  const gapY = axisGap(component.minY, component.maxY, core.minY, core.maxY);
  const distance = Math.hypot(gapX, gapY);
  const allowedGap = Math.max(2, Math.min(4, Math.round(Math.min(boxWidth(core), boxHeight(core)) * 0.18)));
  const alignedX = overlap(component.minX, component.maxX, core.minX, core.maxX) >= Math.min(3, boxWidth(component));
  const alignedY = overlap(component.minY, component.maxY, core.minY, core.maxY) >= Math.min(3, boxHeight(component));
  const isSatellite = component.cells / Math.max(1, core.cells) <= 0.48;

  return isSatellite && distance <= allowedGap && (alignedX || alignedY || distance <= 1.5);
}

/**
 * Selects the large disconnected floorplans while folding nearby, smaller
 * components (balconies, terraces and their labels) into the relevant plan.
 * Similarly-sized neighboring components remain separate floors.
 */
export function selectPlanBoxes(components: ComponentBox[], limit = 4, canvas?: { cols: number; rows: number }) {
  const mainCandidates = components
    .filter((box) => box.cells >= 22 && boxWidth(box) >= 6 && boxHeight(box) >= 6)
    .sort((a, b) => b.cells - a.cells);

  const groups: ComponentBox[] = [];
  const grouped = new Set<ComponentBox>();

  for (const candidate of mainCandidates) {
    const hostIndex = groups.findIndex((group) => canAttach(candidate, group));
    if (hostIndex >= 0) groups[hostIndex] = mergeBoxes(groups[hostIndex], candidate);
    else groups.push({ ...candidate });
    grouped.add(candidate);
  }

  const satellites = components
    .filter((component) => !grouped.has(component))
    .sort((a, b) => b.cells - a.cells);

  for (const satellite of satellites) {
    let hostIndex = -1;
    let closest = Number.POSITIVE_INFINITY;
    groups.forEach((group, index) => {
      if (!canAttach(satellite, group)) return;
      const gapX = axisGap(satellite.minX, satellite.maxX, group.minX, group.maxX);
      const gapY = axisGap(satellite.minY, satellite.maxY, group.minY, group.maxY);
      const distance = Math.hypot(gapX, gapY);
      if (distance < closest) {
        closest = distance;
        hostIndex = index;
      }
    });
    if (hostIndex >= 0) groups[hostIndex] = mergeBoxes(groups[hostIndex], satellite);
  }

  let floorGroups = groups;
  if (canvas && groups.length > 2) {
    const centralGroups = groups.filter((group) => {
      const centerX = ((group.minX + group.maxX) / 2) / canvas.cols;
      const centerY = ((group.minY + group.maxY) / 2) / canvas.rows;
      return centerX >= 0.18 && centerX <= 0.78 && centerY >= 0.08 && centerY <= 0.92;
    });
    if (centralGroups.length > 0 && centralGroups.length < groups.length) floorGroups = centralGroups;
  }

  return floorGroups
    .sort((a, b) => b.cells - a.cells)
    .slice(0, limit)
    .sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));
}

export function detectPlanBoxes(pixels: ArrayLike<number>, width: number, height: number) {
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
          if (pixels[index + 3] > 32 && luminance < 220) dark += 1;
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
  const components: ComponentBox[] = [];
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
      const widthInCells = maxX - minX + 1;
      const heightInCells = maxY - minY + 1;
      if (cells >= 5 && widthInCells >= 2 && heightInCells >= 2) components.push({ minX, minY, maxX, maxY, cells });
    }
  }

  const selected = selectPlanBoxes(components, 4, { cols, rows });
  return { selected, components, cols, rows };
}

export function detectPlanRegions(pixels: ArrayLike<number>, width: number, height: number): SourceRegion[] {
  const { selected, cols, rows } = detectPlanBoxes(pixels, width, height);
  if (!selected.length) {
    return [{ id: "ground", name: "Floor 1", x: 0.03, y: 0.03, width: 0.94, height: 0.94, confidence: 0.58 }];
  }

  return selected.map((box, index) => ({
    id: index === 0 ? "ground" : index === 1 ? "upper" : `level-${index + 1}`,
    name: defaultLevelName(index),
    x: Math.max(0, (box.minX - 1) / cols),
    y: Math.max(0, (box.minY - 1) / rows),
    width: Math.min(1, (box.maxX - box.minX + 3) / cols),
    height: Math.min(1, (box.maxY - box.minY + 3) / rows),
    confidence: Math.max(0.62, 0.93 - index * 0.05),
  }));
}

export function defaultLevelName(index: number) {
  return LEVEL_NAME_OPTIONS[index + 1] ?? `Floor ${index + 1}`;
}

export function resequenceRegions(regions: SourceRegion[]) {
  return regions.map((region, index) => ({
    ...region,
    name: region.nameEdited ? region.name : defaultLevelName(index),
  }));
}

export function moveRegion(regions: SourceRegion[], id: string, offset: -1 | 1) {
  const from = regions.findIndex((region) => region.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= regions.length) return regions;
  const next = [...regions];
  [next[from], next[to]] = [next[to], next[from]];
  return resequenceRegions(next);
}

export function resizeRegion(region: SourceRegion, amount: number) {
  const minSize = 0.08;
  const x = Math.max(0, Math.min(1 - minSize, region.x - amount));
  const y = Math.max(0, Math.min(1 - minSize, region.y - amount));
  const right = Math.max(x + minSize, Math.min(1, region.x + region.width + amount));
  const bottom = Math.max(y + minSize, Math.min(1, region.y + region.height + amount));

  return { ...region, x, y, width: right - x, height: bottom - y };
}
