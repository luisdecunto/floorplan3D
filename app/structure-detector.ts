import type { SourceRegion } from "./plan-regions";
import type { Level, Opening, OutdoorArea, Stair, Wall } from "./scene-data";

export type Axis = "horizontal" | "vertical";

export type DetectedOpening = {
  kind: "door" | "window";
  offset: number;
  width: number;
  confidence: number;
};

export type DetectedWall = {
  id: string;
  axis: Axis;
  start: [number, number];
  end: [number, number];
  thickness: number;
  confidence: number;
  openings: DetectedOpening[];
};

export type DetectedOutdoorArea = {
  id: string;
  side: "top" | "right" | "bottom" | "left";
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export type DetectedStair = {
  id: string;
  runAxis: Axis;
  x: number;
  y: number;
  width: number;
  height: number;
  stepCount: number;
  confidence: number;
};

export type DetectedStructure = {
  regionId: string;
  sourceWidth: number;
  sourceHeight: number;
  walls: DetectedWall[];
  outdoorAreas: DetectedOutdoorArea[];
  stairs: DetectedStair[];
  floorTextureUrl?: string;
  footprint: { x: number; y: number; width: number; height: number };
  roomCount: number;
  confidence: number;
  diagnostics: {
    threshold: number;
    wallThickness: number;
    geometryVotes: number;
    topologyVotes: number;
    openingVotes: number;
    stairVotes: number;
  };
};

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Segment = {
  axis: Axis;
  line: number;
  from: number;
  to: number;
  thickness: number;
  density: number;
};

type GapEvidence = { kind: "door" | "window"; confidence: number } | null;

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function luminance(pixels: ArrayLike<number>, index: number) {
  return 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
}

function otsuThreshold(pixels: ArrayLike<number>, width: number, bounds: Bounds) {
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const index = (y * width + x) * 4;
      if (pixels[index + 3] <= 32) continue;
      histogram[Math.round(luminance(pixels, index))] += 1;
      total += 1;
    }
  }

  let sum = 0;
  for (let value = 0; value < 256; value += 1) sum += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 145;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }
  return clamp(threshold + 18, 105, 188);
}

function paperBounds(pixels: ArrayLike<number>, width: number, height: number, region: SourceRegion): Bounds {
  const raw: Bounds = {
    minX: clamp(Math.floor(region.x * width), 0, width - 1),
    minY: clamp(Math.floor(region.y * height), 0, height - 1),
    maxX: clamp(Math.ceil((region.x + region.width) * width) - 1, 0, width - 1),
    maxY: clamp(Math.ceil((region.y + region.height) * height) - 1, 0, height - 1),
  };

  const acceptableRows: boolean[] = [];
  for (let y = raw.minY; y <= raw.maxY; y += 1) {
    let paper = 0;
    let sampled = 0;
    for (let x = raw.minX; x <= raw.maxX; x += 3) {
      const index = (y * width + x) * 4;
      if (pixels[index + 3] > 32 && luminance(pixels, index) > 205) paper += 1;
      sampled += 1;
    }
    // Phone chrome is almost completely dark; a floorplan wall can legitimately
    // occupy most of a row, so retain any row that still has a paper margin.
    acceptableRows.push(sampled > 0 && paper / sampled >= 0.08);
  }

  let bestStart = 0;
  let bestEnd = acceptableRows.length - 1;
  let runStart = -1;
  acceptableRows.forEach((acceptable, index) => {
    if (acceptable && runStart < 0) runStart = index;
    if ((!acceptable || index === acceptableRows.length - 1) && runStart >= 0) {
      const runEnd = acceptable && index === acceptableRows.length - 1 ? index : index - 1;
      if (runEnd - runStart > bestEnd - bestStart || bestEnd === acceptableRows.length - 1) {
        bestStart = runStart;
        bestEnd = runEnd;
      }
      runStart = -1;
    }
  });

  if (bestEnd - bestStart >= (raw.maxY - raw.minY) * 0.38) {
    raw.minY += bestStart;
    raw.maxY = raw.minY + (bestEnd - bestStart);
  }
  return raw;
}

function createMask(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  bounds: Bounds,
  threshold: number,
) {
  const mask = new Uint8Array(width * height);
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    let rowDark = 0;
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const index = (y * width + x) * 4;
      if (pixels[index + 3] > 32 && luminance(pixels, index) < threshold) {
        mask[y * width + x] = 1;
        rowDark += 1;
      }
    }
    if (rowDark / Math.max(1, bounds.maxX - bounds.minX + 1) > 0.94) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) mask[y * width + x] = 0;
    }
  }
  return mask;
}

function markLongRuns(mask: Uint8Array, width: number, height: number, bounds: Bounds, axis: Axis, minimumRun: number) {
  const result = new Uint8Array(width * height);
  const majorStart = axis === "horizontal" ? bounds.minY : bounds.minX;
  const majorEnd = axis === "horizontal" ? bounds.maxY : bounds.maxX;
  const minorStart = axis === "horizontal" ? bounds.minX : bounds.minY;
  const minorEnd = axis === "horizontal" ? bounds.maxX : bounds.maxY;

  for (let major = majorStart; major <= majorEnd; major += 1) {
    let start = -1;
    let lastDark = -1;
    let darkCount = 0;
    let gap = 0;
    const flush = () => {
      if (start < 0 || lastDark < start) return;
      const length = lastDark - start + 1;
      if (length >= minimumRun && darkCount / length >= 0.72) {
        for (let minor = start; minor <= lastDark; minor += 1) {
          const x = axis === "horizontal" ? minor : major;
          const y = axis === "horizontal" ? major : minor;
          result[y * width + x] = 1;
        }
      }
    };

    for (let minor = minorStart; minor <= minorEnd; minor += 1) {
      const x = axis === "horizontal" ? minor : major;
      const y = axis === "horizontal" ? major : minor;
      if (mask[y * width + x]) {
        if (start < 0) start = minor;
        lastDark = minor;
        darkCount += 1;
        gap = 0;
      } else if (start >= 0) {
        gap += 1;
        if (gap > 1) {
          flush();
          start = -1;
          lastDark = -1;
          darkCount = 0;
          gap = 0;
        }
      }
    }
    flush();
  }
  return result;
}

function maskComponents(mask: Uint8Array, width: number, height: number, bounds: Bounds, axis: Axis): Segment[] {
  const visited = new Uint8Array(mask.length);
  const components: Segment[] = [];
  const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const startIndex = y * width + x;
      if (!mask[startIndex] || visited[startIndex]) continue;
      const queue: Array<[number, number]> = [[x, y]];
      visited[startIndex] = 1;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let cells = 0;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const [cx, cy] = queue[cursor];
        cells += 1;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);
        offsets.forEach(([ox, oy]) => {
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < bounds.minX || nx > bounds.maxX || ny < bounds.minY || ny > bounds.maxY) return;
          const next = ny * width + nx;
          if (!mask[next] || visited[next]) return;
          visited[next] = 1;
          queue.push([nx, ny]);
        });
      }
      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const length = axis === "horizontal" ? boxWidth : boxHeight;
      const thickness = axis === "horizontal" ? boxHeight : boxWidth;
      if (length / Math.max(1, thickness) < 2.2) continue;
      components.push({
        axis,
        line: axis === "horizontal" ? (minY + maxY) / 2 : (minX + maxX) / 2,
        from: axis === "horizontal" ? minX : minY,
        to: axis === "horizontal" ? maxX : maxY,
        thickness,
        density: cells / Math.max(1, boxWidth * boxHeight),
      });
    }
  }
  return components;
}

function splitByStrokeSupport(
  segments: Segment[],
  mask: Uint8Array,
  width: number,
  height: number,
  minimumRun: number,
  trimSingleSupportedRun = false,
) {
  return segments.flatMap((segment) => {
    if (segment.thickness < 3 || segment.to - segment.from < minimumRun * 1.6) return [segment];
    const radius = Math.max(1, Math.floor(segment.thickness / 2));
    const supported: boolean[] = [];
    for (let coordinate = Math.floor(segment.from); coordinate <= Math.ceil(segment.to); coordinate += 1) {
      let dark = 0;
      let sampled = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const x = Math.round(segment.axis === "horizontal" ? coordinate : segment.line + offset);
        const y = Math.round(segment.axis === "horizontal" ? segment.line + offset : coordinate);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        if (mask[y * width + x]) dark += 1;
        sampled += 1;
      }
      supported.push(dark / Math.max(1, sampled) >= 0.62);
    }

    const pieces: Segment[] = [];
    let start = -1;
    let lastSupported = -1;
    let gap = 0;
    const flush = () => {
      if (start < 0 || lastSupported - start + 1 < Math.max(6, minimumRun * 0.24)) return;
      pieces.push({
        ...segment,
        from: segment.from + start,
        to: segment.from + lastSupported,
      });
    };
    supported.forEach((hasSupport, index) => {
      if (hasSupport) {
        if (start < 0) start = index;
        lastSupported = index;
        gap = 0;
      } else if (start >= 0) {
        gap += 1;
        if (gap > 1) {
          flush();
          start = -1;
          lastSupported = -1;
          gap = 0;
        }
      }
    });
    flush();
    if (pieces.length) {
      const supportedLength = pieces.reduce((sum, piece) => sum + piece.to - piece.from + 1, 0);
      const originalLength = segment.to - segment.from + 1;
      const trimmedLength = originalLength - supportedLength;
      const lonePiece = pieces[0];
      const attachedToOneEnd = pieces.length === 1 && (
        (lonePiece.from <= segment.from + 2 && lonePiece.to < segment.to - 2)
        || (lonePiece.to >= segment.to - 2 && lonePiece.from > segment.from + 2)
      );
      // A thick wall that meets a collinear dimension line is one connected
      // component: the component keeps the wall's thickness but inherits the
      // annotation's full length. Keep the one genuinely thick run when the
      // unsupported tail is substantial instead of restoring that virtual wall.
      if (
        pieces.length >= 2
        || (
          trimSingleSupportedRun
          && attachedToOneEnd
          && originalLength >= minimumRun * 5
          && trimmedLength >= Math.max(5, minimumRun * 0.45)
        )
      ) return pieces;
    }
    return [segment];
  });
}

function mergeOverlaps(segments: Segment[]) {
  const sorted = [...segments].sort((a, b) => (a.axis.localeCompare(b.axis)) || (a.line - b.line) || (a.from - b.from));
  const merged: Segment[] = [];
  for (const segment of sorted) {
    const previous = merged.at(-1);
    const lineTolerance = Math.max(2, Math.min(segment.thickness, previous?.thickness ?? segment.thickness) * 0.75);
    if (
      previous
      && previous.axis === segment.axis
      && Math.abs(previous.line - segment.line) <= lineTolerance
      && segment.from <= previous.to + 2
    ) {
      const previousLength = previous.to - previous.from + 1;
      const segmentLength = segment.to - segment.from + 1;
      const totalLength = previousLength + segmentLength;
      previous.line = (previous.line * previousLength + segment.line * segmentLength) / totalLength;
      previous.from = Math.min(previous.from, segment.from);
      previous.to = Math.max(previous.to, segment.to);
      previous.thickness = Math.max(previous.thickness, segment.thickness);
      previous.density = (previous.density * previousLength + segment.density * segmentLength) / totalLength;
    } else merged.push({ ...segment });
  }
  return merged;
}

function weightedPercentile(segments: Segment[], percentile: number) {
  const values = segments
    .map((segment) => ({ value: segment.thickness, weight: Math.max(1, segment.to - segment.from) }))
    .sort((a, b) => a.value - b.value);
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  let accumulated = 0;
  for (const item of values) {
    accumulated += item.weight;
    if (accumulated >= total * percentile) return item.value;
  }
  return values.at(-1)?.value ?? 3;
}

function segmentsIntersect(a: Segment, b: Segment, tolerance: number) {
  if (a.axis === b.axis) return false;
  const horizontal = a.axis === "horizontal" ? a : b;
  const vertical = a.axis === "vertical" ? a : b;
  return vertical.line >= horizontal.from - tolerance
    && vertical.line <= horizontal.to + tolerance
    && horizontal.line >= vertical.from - tolerance
    && horizontal.line <= vertical.to + tolerance;
}

function structuralSegments(segments: Segment[], minimumDimension: number, wallThickness: number) {
  const minimumThickness = Math.max(2, wallThickness * 0.32);
  const initial = segments.filter((segment) => (
    segment.thickness >= minimumThickness
    && segment.to - segment.from >= minimumDimension * 0.075
    && segment.density >= 0.32
  ));

  return initial.filter((segment) => {
    const length = segment.to - segment.from;
    const connected = initial.some((other) => other !== segment && segmentsIntersect(segment, other, Math.max(3, wallThickness * 0.8)));
    return length >= minimumDimension * 0.32
      || connected
      || (segment.thickness >= wallThickness * 0.72 && length >= minimumDimension * 0.13);
  });
}

function recoverWallAnchors(
  segments: Segment[],
  mask: Uint8Array,
  width: number,
  height: number,
  footprint: Bounds,
  wallThickness: number,
) {
  const clusters: Segment[][] = [];
  segments.forEach((segment) => {
    const cluster = clusters.find((candidate) => candidate[0].axis === segment.axis && Math.abs(candidate[0].line - segment.line) <= Math.max(3, wallThickness * 0.7));
    if (cluster) cluster.push(segment);
    else clusters.push([segment]);
  });

  const anchors: Segment[] = [];
  clusters.forEach((cluster) => {
    const axis = cluster[0].axis;
    const line = cluster.reduce((sum, segment) => sum + segment.line, 0) / cluster.length;
    const nearOuter = axis === "horizontal"
      ? Math.min(Math.abs(line - footprint.minY), Math.abs(line - footprint.maxY)) <= wallThickness * 2.2
      : Math.min(Math.abs(line - footprint.minX), Math.abs(line - footprint.maxX)) <= wallThickness * 2.2;
    const scanFrom = nearOuter
      ? (axis === "horizontal" ? footprint.minX : footprint.minY)
      : Math.min(...cluster.map((segment) => segment.from));
    const scanTo = nearOuter
      ? (axis === "horizontal" ? footprint.maxX : footprint.maxY)
      : Math.max(...cluster.map((segment) => segment.to));
    const thickness = nearOuter
      ? Math.max(wallThickness, ...cluster.map((segment) => segment.thickness))
      : Math.max(2, ...cluster.map((segment) => segment.thickness));
    const radius = Math.max(2, Math.round(thickness / 2));
    let start = -1;
    let lastSolid = -1;
    let gap = 0;
    const flush = () => {
      if (start < 0 || lastSolid - start + 1 < Math.max(4, wallThickness * 0.58)) return;
      anchors.push({ axis, line, from: start, to: lastSolid, thickness, density: 0.78 });
    };

    for (let coordinate = Math.floor(scanFrom); coordinate <= Math.ceil(scanTo); coordinate += 1) {
      let dark = 0;
      let sampled = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const x = Math.round(axis === "horizontal" ? coordinate : line + offset);
        const y = Math.round(axis === "horizontal" ? line + offset : coordinate);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        if (mask[y * width + x]) dark += 1;
        sampled += 1;
      }
      const solid = dark / Math.max(1, sampled) >= 0.48;
      if (solid) {
        if (start < 0) start = coordinate;
        lastSolid = coordinate;
        gap = 0;
      } else if (start >= 0) {
        gap += 1;
        if (gap > 1) {
          flush();
          start = -1;
          lastSolid = -1;
          gap = 0;
        }
      }
    }
    flush();
  });
  return mergeOverlaps([...segments, ...anchors]);
}

function longestPerpendicularRun(mask: Uint8Array, width: number, height: number, axis: Axis, coordinate: number, line: number, radius: number) {
  let longest = 0;
  for (let offset = -2; offset <= 2; offset += 1) {
    let current = 0;
    for (let delta = -radius; delta <= radius; delta += 1) {
      const x = Math.round(axis === "horizontal" ? coordinate + offset : line + delta);
      const y = Math.round(axis === "horizontal" ? line + delta : coordinate + offset);
      if (x < 0 || x >= width || y < 0 || y >= height) {
        current = 0;
      } else if (mask[y * width + x]) {
        current += 1;
        longest = Math.max(longest, current);
      } else current = 0;
    }
  }
  return longest;
}

function gapEvidence(
  mask: Uint8Array,
  windowMask: Uint8Array,
  width: number,
  height: number,
  axis: Axis,
  line: number,
  from: number,
  to: number,
  thickness: number,
  footprint: Bounds,
): GapEvidence {
  const gap = to - from;
  if (gap <= Math.max(3, thickness * 0.75)) return null;
  const radius = Math.max(5, Math.round(gap * 1.05));
  const perpendicular = Math.max(
    longestPerpendicularRun(mask, width, height, axis, from, line, radius),
    longestPerpendicularRun(mask, width, height, axis, to, line, radius),
  ) / gap;

  let windowParallel = 0;
  const lineRadius = Math.max(3, Math.round(thickness * 2.4));
  for (let offset = -lineRadius; offset <= lineRadius; offset += 1) {
    let dark = 0;
    let sampled = 0;
    for (let coordinate = Math.ceil(from); coordinate <= Math.floor(to); coordinate += 1) {
      const x = Math.round(axis === "horizontal" ? coordinate : line + offset);
      const y = Math.round(axis === "horizontal" ? line + offset : coordinate);
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (windowMask[y * width + x]) dark += 1;
      sampled += 1;
    }
    windowParallel = Math.max(windowParallel, dark / Math.max(1, sampled));
  }

  let arcDark = 0;
  let arcSampled = 0;
  const halfGap = Math.max(4, Math.round(gap));
  for (let major = -halfGap; major <= halfGap; major += 2) {
    for (let minor = Math.ceil(from); minor <= Math.floor(to); minor += 2) {
      const x = Math.round(axis === "horizontal" ? minor : line + major);
      const y = Math.round(axis === "horizontal" ? line + major : minor);
      if (x < 0 || x >= width || y < 0 || y >= height || Math.abs(major) <= thickness) continue;
      if (mask[y * width + x]) arcDark += 1;
      arcSampled += 1;
    }
  }
  const arcDensity = arcDark / Math.max(1, arcSampled);
  const outerTolerance = Math.max(4, thickness * 2.2);
  const onOuterWall = axis === "horizontal"
    ? Math.min(Math.abs(line - footprint.minY), Math.abs(line - footprint.maxY)) <= outerTolerance
    : Math.min(Math.abs(line - footprint.minX), Math.abs(line - footprint.maxX)) <= outerTolerance;

  if (onOuterWall && windowParallel >= 0.58) {
    return { kind: "window", confidence: clamp(0.62 + windowParallel * 0.3, 0.64, 0.94) };
  }
  if (perpendicular >= 0.34 && arcDensity >= 0.006) {
    return { kind: "door", confidence: clamp(0.56 + perpendicular * 0.23 + arcDensity * 1.5, 0.58, 0.94) };
  }
  const wallSpan = axis === "horizontal" ? footprint.maxX - footprint.minX : footprint.maxY - footprint.minY;
  if (!onOuterWall && gap <= wallSpan * 0.22 && (perpendicular >= 0.12 || arcDensity >= 0.003 || windowParallel >= 0.18)) {
    // Windows are very uncommon in partition walls. A bounded gap with either
    // a leaf, arc, or short cross-stroke is therefore stronger door evidence.
    return { kind: "door", confidence: clamp(0.57 + perpendicular * 0.18 + arcDensity + windowParallel * 0.08, 0.58, 0.88) };
  }
  if (windowParallel >= 0.34 || (onOuterWall && windowParallel >= 0.17)) {
    return { kind: "window", confidence: clamp(0.55 + windowParallel * 0.4, 0.57, 0.93) };
  }
  return null;
}

function segmentBounds(segments: Segment[], fallback: Bounds): Bounds {
  if (!segments.length) return fallback;
  const horizontal = segments.filter((segment) => segment.axis === "horizontal");
  const vertical = segments.filter((segment) => segment.axis === "vertical");
  if (horizontal.length >= 2 && vertical.length >= 2) {
    return {
      minX: Math.min(...vertical.map((segment) => segment.line)),
      maxX: Math.max(...vertical.map((segment) => segment.line)),
      minY: Math.min(...horizontal.map((segment) => segment.line)),
      maxY: Math.max(...horizontal.map((segment) => segment.line)),
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  segments.forEach((segment) => {
    if (segment.axis === "horizontal") {
      minX = Math.min(minX, segment.from);
      maxX = Math.max(maxX, segment.to);
      minY = Math.min(minY, segment.line);
      maxY = Math.max(maxY, segment.line);
    } else {
      minX = Math.min(minX, segment.line);
      maxX = Math.max(maxX, segment.line);
      minY = Math.min(minY, segment.from);
      maxY = Math.max(maxY, segment.to);
    }
  });
  return { minX, minY, maxX, maxY };
}

function railCandidates(segments: Segment[]) {
  const clusters: Segment[][] = [];
  [...segments].sort((a, b) => a.axis.localeCompare(b.axis) || a.line - b.line).forEach((segment) => {
    const cluster = clusters.find((candidate) => candidate[0].axis === segment.axis && Math.abs(candidate[0].line - segment.line) <= 3);
    if (cluster) cluster.push(segment);
    else clusters.push([segment]);
  });
  return clusters.map((cluster) => {
    const totalLength = cluster.reduce((sum, segment) => sum + segment.to - segment.from + 1, 0);
    return {
      axis: cluster[0].axis,
      line: cluster.reduce((sum, segment) => sum + segment.line * (segment.to - segment.from + 1), 0) / totalLength,
      from: Math.min(...cluster.map((segment) => segment.from)),
      to: Math.max(...cluster.map((segment) => segment.to)),
      thickness: Math.max(...cluster.map((segment) => segment.thickness)),
      density: cluster.reduce((sum, segment) => sum + segment.density, 0) / cluster.length,
    } satisfies Segment;
  });
}

function buildWalls(
  segments: Segment[],
  mask: Uint8Array,
  windowMask: Uint8Array,
  width: number,
  height: number,
  wallThickness: number,
  footprint: Bounds,
) {
  const clusters: Segment[][] = [];
  [...segments].sort((a, b) => a.axis.localeCompare(b.axis) || a.line - b.line || a.from - b.from).forEach((segment) => {
    const cluster = clusters.find((candidate) => {
      const reference = candidate[0];
      return reference.axis === segment.axis && Math.abs(reference.line - segment.line) <= Math.max(3, wallThickness * 0.7);
    });
    if (cluster) cluster.push(segment);
    else clusters.push([segment]);
  });

  const walls: DetectedWall[] = [];
  clusters.forEach((cluster) => {
    const axis = cluster[0].axis;
    const sorted = [...cluster].sort((a, b) => a.from - b.from);
    let wallStart = sorted[0].from;
    let wallEnd = sorted[0].to;
    let weightedLine = sorted[0].line;
    let totalWeight = sorted[0].to - sorted[0].from + 1;
    let thickness = sorted[0].thickness;
    let openings: DetectedOpening[] = [];

    const finish = () => {
      if (wallEnd - wallStart < 4) return;
      const line = weightedLine;
      const start: [number, number] = axis === "horizontal" ? [wallStart, line] : [line, wallStart];
      const end: [number, number] = axis === "horizontal" ? [wallEnd, line] : [line, wallEnd];
      walls.push({
        id: `detected-wall-${walls.length + 1}`,
        axis,
        start,
        end,
        thickness,
        confidence: clamp(0.66 + Math.min(0.2, (wallEnd - wallStart) / 900) + Math.min(0.08, thickness / 80), 0.64, 0.94),
        openings,
      });
    };

    for (let index = 1; index < sorted.length; index += 1) {
      const segment = sorted[index];
      if (segment.from <= wallEnd + 2) {
        const weight = segment.to - segment.from + 1;
        weightedLine = (weightedLine * totalWeight + segment.line * weight) / (totalWeight + weight);
        totalWeight += weight;
        wallEnd = Math.max(wallEnd, segment.to);
        thickness = Math.max(thickness, segment.thickness);
        continue;
      }
      const evidence = gapEvidence(mask, windowMask, width, height, axis, weightedLine, wallEnd, segment.from, thickness, footprint);
      const maximumOpening = Math.max(18, (axis === "horizontal" ? footprint.maxX - footprint.minX : footprint.maxY - footprint.minY) * 0.34);
      if (evidence && segment.from - wallEnd <= maximumOpening) {
        openings.push({
          kind: evidence.kind,
          offset: wallEnd - wallStart,
          width: segment.from - wallEnd,
          confidence: evidence.confidence,
        });
        const weight = segment.to - segment.from + 1;
        weightedLine = (weightedLine * totalWeight + segment.line * weight) / (totalWeight + weight);
        totalWeight += weight;
        wallEnd = segment.to;
        thickness = Math.max(thickness, segment.thickness);
      } else {
        finish();
        wallStart = segment.from;
        wallEnd = segment.to;
        weightedLine = segment.line;
        totalWeight = segment.to - segment.from + 1;
        thickness = segment.thickness;
        openings = [];
      }
    }
    finish();
  });
  return walls;
}

function trimUnsupportedWallTails(
  walls: DetectedWall[],
  mask: Uint8Array,
  width: number,
  height: number,
  minimumRun: number,
) {
  return walls.map((wall) => {
    const from = wall.axis === "horizontal" ? wall.start[0] : wall.start[1];
    const to = wall.axis === "horizontal" ? wall.end[0] : wall.end[1];
    const line = wall.axis === "horizontal" ? wall.start[1] : wall.start[0];
    const length = to - from + 1;
    if (wall.openings.length || wall.thickness < 4 || length < minimumRun * 5) return wall;

    const radius = Math.max(4, Math.ceil(wall.thickness));
    const crossSections: number[] = [];
    for (let coordinate = Math.floor(from); coordinate <= Math.ceil(to); coordinate += 1) {
      crossSections.push(longestPerpendicularRun(mask, width, height, wall.axis, coordinate, line, radius));
    }
    const ranked = [...crossSections].sort((a, b) => a - b);
    const baseline = ranked[Math.floor((ranked.length - 1) * 0.88)] ?? 0;
    if (baseline < 4) return wall;

    const minimumCrossSection = Math.max(3, Math.ceil(baseline * 0.78));
    const gapTolerance = Math.max(1, Math.round(wall.thickness * 0.35));
    const runs: Array<{ from: number; to: number }> = [];
    let runStart = -1;
    let lastSupported = -1;
    let gap = 0;
    const flush = () => {
      // Ignore the short perpendicular blob where an annotation tail meets an
      // exterior wall; it is an intersection, not sustained wall thickness.
      if (runStart < 0 || lastSupported - runStart + 1 < Math.max(8, minimumRun, wall.thickness * 1.6)) return;
      runs.push({ from: runStart, to: lastSupported });
    };

    crossSections.forEach((crossSection, index) => {
      if (crossSection >= minimumCrossSection) {
        if (runStart < 0) runStart = index;
        lastSupported = index;
        gap = 0;
      } else if (runStart >= 0) {
        gap += 1;
        if (gap > gapTolerance) {
          flush();
          runStart = -1;
          lastSupported = -1;
          gap = 0;
        }
      }
    });
    flush();
    if (runs.length !== 1) return wall;

    const supported = runs[0];
    const supportedFrom = from + supported.from;
    const supportedTo = from + supported.to;
    const edgeTolerance = Math.max(4, wall.thickness * 1.4);
    const touchesStart = supportedFrom <= from + edgeTolerance;
    const touchesEnd = supportedTo >= to - edgeTolerance;
    const trimmedLength = length - (supportedTo - supportedFrom + 1);
    if (touchesStart === touchesEnd || trimmedLength < Math.max(minimumRun * 2, length * 0.25)) return wall;

    return {
      ...wall,
      start: wall.axis === "horizontal" ? [supportedFrom, line] : [line, supportedFrom],
      end: wall.axis === "horizontal" ? [supportedTo, line] : [line, supportedTo],
    };
  });
}

function recoverEmbeddedOpenings(
  walls: DetectedWall[],
  strongMask: Uint8Array,
  mediumMask: Uint8Array,
  windowMask: Uint8Array,
  width: number,
  height: number,
  footprint: Bounds,
) {
  return walls.map((wall) => {
    const from = wall.axis === "horizontal" ? wall.start[0] : wall.start[1];
    const to = wall.axis === "horizontal" ? wall.end[0] : wall.end[1];
    const line = wall.axis === "horizontal" ? wall.start[1] : wall.start[0];
    const outerTolerance = Math.max(4, wall.thickness * 2.2);
    const onOuterWall = wall.axis === "horizontal"
      ? Math.min(Math.abs(line - footprint.minY), Math.abs(line - footprint.maxY)) <= outerTolerance
      : Math.min(Math.abs(line - footprint.minX), Math.abs(line - footprint.maxX)) <= outerTolerance;
    const scanFrom = Math.max(from, wall.axis === "horizontal" ? footprint.minX : footprint.minY);
    const scanTo = Math.min(to, wall.axis === "horizontal" ? footprint.maxX : footprint.maxY);
    const radius = Math.max(2, Math.round(wall.thickness / 2));
    const span = scanTo - scanFrom;
    const openings = [...wall.openings];
    let gapStart = -1;
    let lastGap = -1;
    let solidRun = 0;

    const flush = () => {
      if (gapStart < 0) return;
      const gapWidth = lastGap - gapStart + 1;
      const minimumGap = Math.max(6, wall.thickness * 0.82);
      if (gapWidth < minimumGap || gapWidth > span * 0.34) return;
      const overlapsKnown = openings.some((opening) => {
        const knownFrom = from + opening.offset;
        const knownTo = knownFrom + opening.width;
        return Math.max(0, Math.min(lastGap, knownTo) - Math.max(gapStart, knownFrom)) >= Math.min(gapWidth, opening.width) * 0.45;
      });
      if (overlapsKnown) return;
      const evidence = gapEvidence(mediumMask, windowMask, width, height, wall.axis, line, gapStart, lastGap, wall.thickness, footprint);
      if (!evidence) return;
      if (onOuterWall && evidence.kind === "door" && evidence.confidence < 0.7) return;
      openings.push({
        kind: evidence.kind,
        offset: gapStart - from,
        width: gapWidth,
        confidence: Math.max(0.56, evidence.confidence - 0.03),
      });
    };

    for (let coordinate = Math.floor(scanFrom); coordinate <= Math.ceil(scanTo); coordinate += 1) {
      let dark = 0;
      let sampled = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const x = Math.round(wall.axis === "horizontal" ? coordinate : line + offset);
        const y = Math.round(wall.axis === "horizontal" ? line + offset : coordinate);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        if (strongMask[y * width + x]) dark += 1;
        sampled += 1;
      }
      const solid = dark / Math.max(1, sampled) >= 0.54;
      if (!solid) {
        if (gapStart < 0) gapStart = coordinate;
        lastGap = coordinate;
        solidRun = 0;
      } else if (gapStart >= 0) {
        solidRun += 1;
        if (solidRun > 1) {
          lastGap = coordinate - solidRun;
          flush();
          gapStart = -1;
          lastGap = -1;
          solidRun = 0;
        }
      }
    }
    return { ...wall, openings: openings.sort((a, b) => a.offset - b.offset) };
  });
}

function overlapRatio(from: number, to: number, targetFrom: number, targetTo: number) {
  return Math.max(0, Math.min(to, targetTo) - Math.max(from, targetFrom)) / Math.max(1, targetTo - targetFrom);
}

function detectOutdoorAreas(rawSegments: Segment[], footprint: Bounds, wallThickness: number) {
  const railsAndSupports = railCandidates(rawSegments);
  const footprintWidth = footprint.maxX - footprint.minX;
  const footprintHeight = footprint.maxY - footprint.minY;
  const result: DetectedOutdoorArea[] = [];

  const addHorizontalArea = (side: "top" | "bottom") => {
    const edge = side === "top" ? footprint.minY : footprint.maxY;
    const direction = side === "top" ? -1 : 1;
    const rails = railsAndSupports.filter((segment) => {
      if (segment.axis !== "horizontal") return false;
      const depth = (segment.line - edge) * direction;
      return depth >= footprintHeight * 0.1
        && depth <= footprintHeight * 0.62
        && overlapRatio(segment.from, segment.to, footprint.minX, footprint.maxX) >= 0.44;
    }).sort((a, b) => Math.abs(a.line - edge) - Math.abs(b.line - edge));

    for (const rail of rails) {
      const depth = Math.abs(rail.line - edge);
      const sideSupports = railsAndSupports.filter((segment) => (
        segment.axis === "vertical"
        && segment.to - segment.from >= depth * 0.55
        && (
          Math.min(Math.abs(segment.line - footprint.minX), Math.abs(segment.line - footprint.maxX)) <= wallThickness * 2.2
          || (segment.line >= rail.from - wallThickness * 3 && segment.line <= rail.to + wallThickness * 3)
        )
        && Math.min(Math.abs(segment.from - Math.min(edge, rail.line)), Math.abs(segment.to - Math.max(edge, rail.line))) <= wallThickness * 4
      ));
      if (sideSupports.length < 2) continue;
      const supportXs = sideSupports.map((support) => support.line).sort((a, b) => a - b);
      const minX = supportXs[0];
      const maxX = supportXs.at(-1) ?? rail.to;
      if (maxX - minX < footprintWidth * 0.4) continue;
      result.push({
        id: `outdoor-${side}-${result.length + 1}`,
        side,
        x: minX,
        y: Math.min(edge, rail.line),
        width: maxX - minX,
        height: depth,
        confidence: clamp(0.64 + Math.min(0.16, sideSupports.length * 0.04) + overlapRatio(rail.from, rail.to, footprint.minX, footprint.maxX) * 0.13, 0.65, 0.92),
      });
      break;
    }
  };

  const addVerticalArea = (side: "left" | "right") => {
    const edge = side === "left" ? footprint.minX : footprint.maxX;
    const direction = side === "left" ? -1 : 1;
    const rails = railsAndSupports.filter((segment) => {
      if (segment.axis !== "vertical") return false;
      const depth = (segment.line - edge) * direction;
      return depth >= footprintWidth * 0.1
        && depth <= footprintWidth * 0.62
        && overlapRatio(segment.from, segment.to, footprint.minY, footprint.maxY) >= 0.44;
    }).sort((a, b) => Math.abs(a.line - edge) - Math.abs(b.line - edge));

    for (const rail of rails) {
      const depth = Math.abs(rail.line - edge);
      const sideSupports = railsAndSupports.filter((segment) => (
        segment.axis === "horizontal"
        && segment.to - segment.from >= depth * 0.55
        && (
          Math.min(Math.abs(segment.line - footprint.minY), Math.abs(segment.line - footprint.maxY)) <= wallThickness * 2.2
          || (segment.line >= rail.from - wallThickness * 3 && segment.line <= rail.to + wallThickness * 3)
        )
      ));
      if (sideSupports.length < 2) continue;
      const supportYs = sideSupports.map((support) => support.line).sort((a, b) => a - b);
      const minY = supportYs[0];
      const maxY = supportYs.at(-1) ?? rail.to;
      if (maxY - minY < footprintHeight * 0.4) continue;
      result.push({
        id: `outdoor-${side}-${result.length + 1}`,
        side,
        x: Math.min(edge, rail.line),
        y: minY,
        width: depth,
        height: maxY - minY,
        confidence: clamp(0.64 + Math.min(0.16, sideSupports.length * 0.04) + overlapRatio(rail.from, rail.to, footprint.minY, footprint.maxY) * 0.13, 0.65, 0.92),
      });
      break;
    }
  };

  addHorizontalArea("top");
  addHorizontalArea("bottom");
  addVerticalArea("left");
  addVerticalArea("right");
  return result.sort((a, b) => b.confidence - a.confidence).slice(0, 2);
}

type StairBox = Bounds & { runAxis: Axis; railCount: number };

function consolidateStairRails(rawSegments: Segment[], minimumDimension: number, wallThickness: number) {
  // Compressed screenshots often preserve only short fragments of one stair
  // stringer; the paired-rail and cross-stroke checks below provide the guard
  // against admitting arbitrary short lines.
  const minimumLength = minimumDimension * 0.052;
  const maximumLength = minimumDimension * 0.52;
  const maximumThickness = Math.max(4, wallThickness * 0.82);
  const maximumGap = minimumDimension * 0.16;
  const rails = rawSegments
    .filter((segment) => (
      segment.thickness <= maximumThickness
      && segment.to - segment.from >= minimumLength
      && segment.to - segment.from <= maximumLength
    ))
    .sort((a, b) => a.axis.localeCompare(b.axis) || a.line - b.line || a.from - b.from);
  const result: Segment[] = [];

  rails.forEach((rail) => {
    const existing = result.find((candidate) => (
      candidate.axis === rail.axis
      && Math.abs(candidate.line - rail.line) <= Math.max(2, wallThickness * 0.58)
      && rail.from <= candidate.to + maximumGap
      && rail.to >= candidate.from - maximumGap
    ));
    if (!existing) {
      result.push({ ...rail });
      return;
    }
    const existingLength = existing.to - existing.from;
    const railLength = rail.to - rail.from;
    existing.line = (existing.line * existingLength + rail.line * railLength) / Math.max(1, existingLength + railLength);
    existing.from = Math.min(existing.from, rail.from);
    existing.to = Math.max(existing.to, rail.to);
    existing.thickness = Math.min(existing.thickness, rail.thickness);
    existing.density = Math.max(existing.density, rail.density);
  });
  return result;
}

function mergeStairBoxes(boxes: StairBox[], padding: number) {
  const merged: StairBox[] = [];
  boxes.forEach((box) => {
    const target = merged.find((candidate) => {
      if (candidate.runAxis !== box.runAxis) return false;
      const crossAdjacent = box.runAxis === "vertical"
        ? Math.min(Math.abs(candidate.maxX - box.minX), Math.abs(box.maxX - candidate.minX)) <= padding
        : Math.min(Math.abs(candidate.maxY - box.minY), Math.abs(box.maxY - candidate.minY)) <= padding;
      const runOverlap = box.runAxis === "vertical"
        ? Math.min(candidate.maxY, box.maxY) - Math.max(candidate.minY, box.minY)
        : Math.min(candidate.maxX, box.maxX) - Math.max(candidate.minX, box.minX);
      return crossAdjacent && runOverlap > 0;
    });
    if (!target) {
      merged.push({ ...box });
      return;
    }
    target.minX = Math.min(target.minX, box.minX);
    target.minY = Math.min(target.minY, box.minY);
    target.maxX = Math.max(target.maxX, box.maxX);
    target.maxY = Math.max(target.maxY, box.maxY);
    target.railCount += box.railCount;
  });
  return merged;
}

function stairCrossStrokeCenters(
  mask: Uint8Array,
  width: number,
  height: number,
  box: StairBox,
  wallThickness: number,
) {
  const horizontalRun = box.runAxis === "horizontal";
  const majorStart = Math.max(0, Math.ceil(horizontalRun ? box.minX : box.minY));
  const majorEnd = Math.min(horizontalRun ? width - 1 : height - 1, Math.floor(horizontalRun ? box.maxX : box.maxY));
  const minorStart = Math.max(0, Math.ceil(horizontalRun ? box.minY : box.minX) + 2);
  const minorEnd = Math.min(horizontalRun ? height - 1 : width - 1, Math.floor(horizontalRun ? box.maxY : box.maxX) - 2);
  const span = Math.max(1, minorEnd - minorStart + 1);
  const active: boolean[] = [];

  for (let major = majorStart; major <= majorEnd; major += 1) {
    let dark = 0;
    let longest = 0;
    let run = 0;
    let onePixelGap = 0;
    for (let minor = minorStart; minor <= minorEnd; minor += 1) {
      const x = horizontalRun ? major : minor;
      const y = horizontalRun ? minor : major;
      if (mask[y * width + x]) {
        dark += 1;
        run += 1 + onePixelGap;
        onePixelGap = 0;
        longest = Math.max(longest, run);
      } else if (run > 0 && onePixelGap === 0) {
        onePixelGap = 1;
      } else {
        run = 0;
        onePixelGap = 0;
      }
    }
    active.push(dark / span >= 0.2 && longest / span >= 0.28);
  }

  const centers: number[] = [];
  let start = -1;
  active.forEach((value, index) => {
    if (value && start < 0) start = index;
    if ((!value || index === active.length - 1) && start >= 0) {
      const end = value && index === active.length - 1 ? index : index - 1;
      const thickness = end - start + 1;
      if (thickness <= Math.max(5, wallThickness * 0.9)) centers.push(majorStart + (start + end) / 2);
      start = -1;
    }
  });
  return centers;
}

export function expandDetectedStairReturn(
  stair: DetectedStair,
  mask: Uint8Array,
  width: number,
  height: number,
  footprint: { x: number; y: number; width: number; height: number },
  wallThickness: number,
) {
  const vertical = stair.runAxis === "vertical";
  const crossLength = vertical ? stair.width : stair.height;
  const runLength = vertical ? stair.height : stair.width;
  const stairCrossCenter = vertical ? stair.x + stair.width / 2 : stair.y + stair.height / 2;
  const footprintCrossCenter = vertical ? footprint.x + footprint.width / 2 : footprint.y + footprint.height / 2;
  // A complete half-turn shaft is normally centered even when the parallel
  // flight detected from its regular treads is not. Avoid altering already
  // centered shaft detections.
  if (Math.abs(stairCrossCenter - footprintCrossCenter) <= crossLength * 0.12) return stair;

  const direction = stairCrossCenter > footprintCrossCenter ? -1 : 1;
  const footprintCrossLength = vertical ? footprint.width : footprint.height;
  const maximumDistance = Math.floor(Math.min(crossLength * 0.9, runLength * 0.58, footprintCrossLength * 0.2));
  const runStart = Math.round((vertical ? stair.y : stair.x) + runLength * 0.09);
  const runEnd = Math.round((vertical ? stair.y + stair.height : stair.x + stair.width) - runLength * 0.09);
  const boundary = direction < 0
    ? Math.floor(vertical ? stair.x : stair.y) - 1
    : Math.ceil(vertical ? stair.x + stair.width : stair.y + stair.height) + 1;
  const gapAllowance = Math.max(2, Math.ceil(wallThickness * 0.48));
  const span = Math.max(1, runEnd - runStart + 1);
  let gaps = 0;
  let farthestEvidence = 0;

  for (let distance = 1; distance <= maximumDistance; distance += 1) {
    const cross = boundary + direction * (distance - 1);
    let hits = 0;
    for (let run = runStart; run <= runEnd; run += 1) {
      const x = vertical ? cross : run;
      const y = vertical ? run : cross;
      if (x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x]) hits += 1;
    }
    // Return flights and winders contribute short connected strokes. Solid
    // wall columns/rows are deliberately rejected here.
    const active = hits >= 2 && hits <= span * 0.52;
    if (active) {
      farthestEvidence = distance;
      gaps = 0;
    } else {
      gaps += 1;
      if (gaps > gapAllowance) break;
    }
  }

  const minimumExpansion = Math.max(3, crossLength * 0.16);
  const maximumShaftCross = footprintCrossLength * 0.36;
  const expansion = Math.min(farthestEvidence, Math.max(0, maximumShaftCross - crossLength));
  if (expansion < minimumExpansion) return stair;
  if (vertical) {
    return {
      ...stair,
      x: direction < 0 ? stair.x - expansion : stair.x,
      width: stair.width + expansion,
      confidence: Math.min(0.92, stair.confidence + 0.04),
    };
  }
  return {
    ...stair,
    y: direction < 0 ? stair.y - expansion : stair.y,
    height: stair.height + expansion,
    confidence: Math.min(0.92, stair.confidence + 0.04),
  };
}

function detectStairs(
  rawSegments: Segment[],
  mediumMask: Uint8Array,
  width: number,
  height: number,
  footprint: Bounds,
  minimumDimension: number,
  wallThickness: number,
) {
  const rails = consolidateStairRails(rawSegments, minimumDimension, wallThickness);
  const minimumSeparation = minimumDimension * 0.065;
  const maximumSeparation = minimumDimension * 0.31;
  const minimumOverlap = minimumDimension * 0.045;
  const boxes: StairBox[] = [];

  rails.forEach((first, firstIndex) => {
    rails.slice(firstIndex + 1).forEach((second) => {
      if (first.axis !== second.axis) return;
      const separation = Math.abs(second.line - first.line);
      const overlap = Math.max(0, Math.min(first.to, second.to) - Math.max(first.from, second.from));
      if (separation < minimumSeparation || separation > maximumSeparation || overlap < minimumOverlap) return;
      const runFrom = Math.min(first.from, second.from);
      const runTo = Math.max(first.to, second.to);
      const runLength = runTo - runFrom;
      if (runLength < separation * 0.52 || runLength > separation * 4.8) return;

      const box: StairBox = first.axis === "vertical"
        ? { minX: Math.min(first.line, second.line), maxX: Math.max(first.line, second.line), minY: runFrom, maxY: runTo, runAxis: "vertical", railCount: 2 }
        : { minX: runFrom, maxX: runTo, minY: Math.min(first.line, second.line), maxY: Math.max(first.line, second.line), runAxis: "horizontal", railCount: 2 };
      const centerX = (box.minX + box.maxX) / 2;
      const centerY = (box.minY + box.maxY) / 2;
      if (centerX < footprint.minX - wallThickness * 2 || centerX > footprint.maxX + wallThickness * 2) return;
      if (centerY < footprint.minY - wallThickness * 2 || centerY > footprint.maxY + wallThickness * 2) return;
      boxes.push(box);
    });
  });

  const footprintMinimum = Math.min(footprint.maxX - footprint.minX, footprint.maxY - footprint.minY);
  const validatedBoxes = boxes.filter((box) => {
    const boxWidth = box.maxX - box.minX;
    const boxHeight = box.maxY - box.minY;
    const crossLength = box.runAxis === "vertical" ? boxWidth : boxHeight;
    if (crossLength > footprintMinimum * 0.32) return false;
    return stairCrossStrokeCenters(mediumMask, width, height, box, wallThickness).length >= 2;
  });

  const detected = mergeStairBoxes(validatedBoxes, Math.max(3, wallThickness * 0.75))
    .flatMap((box, index): DetectedStair[] => {
      const centers = stairCrossStrokeCenters(mediumMask, width, height, box, wallThickness);
      if (centers.length < 2) return [];
      const runLength = box.runAxis === "vertical" ? box.maxY - box.minY : box.maxX - box.minX;
      const gaps = centers.slice(1).map((center, gapIndex) => center - centers[gapIndex]).filter((gap) => gap >= 2);
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? runLength / 7;
      const stepCount = clamp(Math.round(runLength / Math.max(3, medianGap)), Math.max(5, centers.length), 16);
      if (stepCount < 6) return [];
      const boxWidth = box.maxX - box.minX;
      const boxHeight = box.maxY - box.minY;
      const crossLength = box.runAxis === "vertical" ? boxWidth : boxHeight;
      if (crossLength > footprintMinimum * 0.32) return [];
      if (boxWidth > (footprint.maxX - footprint.minX) * 0.42 || boxHeight > (footprint.maxY - footprint.minY) * 0.54) return [];
      return [{
        id: `stair-${index + 1}`,
        runAxis: box.runAxis,
        x: box.minX,
        y: box.minY,
        width: boxWidth,
        height: boxHeight,
        stepCount,
        confidence: clamp(0.58 + Math.min(0.2, centers.length * 0.035) + Math.min(0.08, (box.railCount - 2) * 0.02), 0.62, 0.9),
      }];
    })
    .sort((a, b) => b.confidence - a.confidence);
  const expanded = detected.map((stair) => expandDetectedStairReturn(stair, mediumMask, width, height, {
    x: footprint.minX,
    y: footprint.minY,
    width: footprint.maxX - footprint.minX,
    height: footprint.maxY - footprint.minY,
  }, wallThickness));
  const unique: DetectedStair[] = [];
  expanded.forEach((stair) => {
    const duplicate = unique.some((candidate) => {
      if (candidate.runAxis !== stair.runAxis) return false;
      const intersectionWidth = Math.max(0, Math.min(candidate.x + candidate.width, stair.x + stair.width) - Math.max(candidate.x, stair.x));
      const intersectionHeight = Math.max(0, Math.min(candidate.y + candidate.height, stair.y + stair.height) - Math.max(candidate.y, stair.y));
      const intersection = intersectionWidth * intersectionHeight;
      return intersection / Math.max(1, Math.min(candidate.width * candidate.height, stair.width * stair.height)) >= 0.72;
    });
    if (!duplicate) unique.push(stair);
  });
  return unique.slice(0, 2).map((stair, index) => ({ ...stair, id: `stair-${index + 1}` }));
}

function estimateRoomCount(walls: DetectedWall[], footprint: Bounds) {
  if (walls.length < 4) return 0;
  const gridSize = 72;
  const grid = new Uint8Array(gridSize * gridSize);
  const spanX = Math.max(1, footprint.maxX - footprint.minX);
  const spanY = Math.max(1, footprint.maxY - footprint.minY);
  const point = (x: number, y: number) => [
    clamp(Math.round(((x - footprint.minX) / spanX) * (gridSize - 5)) + 2, 0, gridSize - 1),
    clamp(Math.round(((y - footprint.minY) / spanY) * (gridSize - 5)) + 2, 0, gridSize - 1),
  ] as const;
  const mark = (x: number, y: number, radius = 1) => {
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx >= 0 && nx < gridSize && ny >= 0 && ny < gridSize) grid[ny * gridSize + nx] = 1;
      }
    }
  };

  walls.forEach((wall) => {
    const [x1, y1] = point(...wall.start);
    const [x2, y2] = point(...wall.end);
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let step = 0; step <= steps; step += 1) {
      mark(Math.round(x1 + ((x2 - x1) * step) / steps), Math.round(y1 + ((y2 - y1) * step) / steps));
    }
  });
  for (let coordinate = 2; coordinate < gridSize - 2; coordinate += 1) {
    mark(coordinate, 2);
    mark(coordinate, gridSize - 3);
    mark(2, coordinate);
    mark(gridSize - 3, coordinate);
  }

  const visited = new Uint8Array(grid.length);
  let rooms = 0;
  for (let y = 3; y < gridSize - 3; y += 1) {
    for (let x = 3; x < gridSize - 3; x += 1) {
      const start = y * gridSize + x;
      if (grid[start] || visited[start]) continue;
      const queue: Array<[number, number]> = [[x, y]];
      visited[start] = 1;
      let cells = 0;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const [cx, cy] = queue[cursor];
        cells += 1;
        [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([ox, oy]) => {
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < 3 || nx >= gridSize - 3 || ny < 3 || ny >= gridSize - 3) return;
          const next = ny * gridSize + nx;
          if (grid[next] || visited[next]) return;
          visited[next] = 1;
          queue.push([nx, ny]);
        });
      }
      if (cells >= gridSize * gridSize * 0.012) rooms += 1;
    }
  }
  return clamp(rooms, 1, 20);
}

export function inspectStructureEvidence(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  region: SourceRegion,
) {
  const bounds = paperBounds(pixels, width, height, region);
  const threshold = otsuThreshold(pixels, width, bounds);
  const windowMask = createMask(pixels, width, height, bounds, Math.min(205, threshold + 26));
  const mediumMask = createMask(pixels, width, height, bounds, Math.min(210, threshold + 40));
  const strongMask = createMask(pixels, width, height, bounds, threshold);
  const minimumDimension = Math.max(1, Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
  // The oriented run must be longer than a normal wall is thick; otherwise
  // perpendicular walls join the mask into one building-sized component.
  const minimumRun = Math.max(12, Math.round(minimumDimension * 0.06));
  const horizontalComponents = maskComponents(
    markLongRuns(strongMask, width, height, bounds, "horizontal", minimumRun),
    width,
    height,
    bounds,
    "horizontal",
  );
  const verticalComponents = maskComponents(
    markLongRuns(strongMask, width, height, bounds, "vertical", minimumRun),
    width,
    height,
    bounds,
    "vertical",
  );
  const horizontal = splitByStrokeSupport(
    horizontalComponents,
    strongMask,
    width,
    height,
    minimumRun,
  );
  const vertical = splitByStrokeSupport(
    verticalComponents,
    strongMask,
    width,
    height,
    minimumRun,
  );
  const rawSegments = mergeOverlaps([...horizontal, ...vertical]).filter((segment) => (
    segment.to - segment.from >= minimumRun
    && segment.thickness <= minimumDimension * 0.095
  ));
  const wallThickness = clamp(weightedPercentile(rawSegments.filter((segment) => segment.to - segment.from >= minimumDimension * 0.1), 0.66), 2, minimumDimension * 0.07);
  // Outdoor rails and stair traces are legitimately thin and retain the raw
  // segments. Only wall candidates trim a lone thick run away from an attached
  // thin annotation such as a measurement line.
  const wallSegments = mergeOverlaps([
    ...splitByStrokeSupport(horizontalComponents, strongMask, width, height, minimumRun, true),
    ...splitByStrokeSupport(verticalComponents, strongMask, width, height, minimumRun, true),
  ]).filter((segment) => (
    segment.to - segment.from >= minimumRun
    && segment.thickness <= minimumDimension * 0.095
  ));
  const structural = structuralSegments(wallSegments, minimumDimension, wallThickness);
  return { bounds, threshold, strongMask, mediumMask, windowMask, rawSegments, wallThickness, structural, minimumDimension, minimumRun };
}

export function detectFloorStructure(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  region: SourceRegion,
): DetectedStructure {
  const { bounds, threshold, strongMask, mediumMask, windowMask, rawSegments, wallThickness, structural, minimumDimension, minimumRun } = inspectStructureEvidence(pixels, width, height, region);
  const thickCore = structural.filter((segment) => segment.thickness >= wallThickness * 0.62 || segment.to - segment.from >= minimumDimension * 0.3);
  const footprintBounds = segmentBounds(thickCore.length ? thickCore : structural, bounds);
  const anchoredStructural = recoverWallAnchors(structural, strongMask, width, height, footprintBounds, wallThickness);
  const walls = recoverEmbeddedOpenings(
    trimUnsupportedWallTails(
      buildWalls(anchoredStructural, mediumMask, windowMask, width, height, wallThickness, footprintBounds),
      strongMask,
      width,
      height,
      minimumRun,
    ),
    strongMask,
    mediumMask,
    windowMask,
    width,
    height,
    footprintBounds,
  );
  const outdoorAreas = detectOutdoorAreas(rawSegments, footprintBounds, wallThickness);
  const stairs = detectStairs(rawSegments, mediumMask, width, height, footprintBounds, minimumDimension, wallThickness);
  const openingCount = walls.reduce((sum, wall) => sum + wall.openings.length, 0);
  const topologyVotes = walls.filter((wall) => walls.some((other) => other !== wall && (
    Math.hypot(wall.start[0] - other.start[0], wall.start[1] - other.start[1]) <= wallThickness * 2.5
    || Math.hypot(wall.end[0] - other.end[0], wall.end[1] - other.end[1]) <= wallThickness * 2.5
    || (wall.axis !== other.axis && wall.start[0] <= other.end[0] + wallThickness && wall.end[0] >= other.start[0] - wallThickness)
  ))).length;
  const confidence = clamp(
    0.46
      + Math.min(0.24, walls.length * 0.018)
      + Math.min(0.1, topologyVotes * 0.012)
      + Math.min(0.08, openingCount * 0.012)
      + (outdoorAreas.length ? 0.03 : 0)
      + (stairs.length ? 0.025 : 0),
    walls.length >= 4 ? 0.58 : 0.38,
    0.94,
  );

  return {
    regionId: region.id,
    sourceWidth: width,
    sourceHeight: height,
    walls,
    outdoorAreas,
    stairs,
    footprint: {
      x: footprintBounds.minX,
      y: footprintBounds.minY,
      width: Math.max(1, footprintBounds.maxX - footprintBounds.minX),
      height: Math.max(1, footprintBounds.maxY - footprintBounds.minY),
    },
    roomCount: estimateRoomCount(walls, footprintBounds),
    confidence,
    diagnostics: {
      threshold,
      wallThickness,
      geometryVotes: walls.length,
      topologyVotes,
      openingVotes: openingCount,
      stairVotes: stairs.length,
    },
  };
}

export function detectFloorStructures(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  regions: SourceRegion[],
) {
  return Object.fromEntries(regions.map((region) => [region.id, detectFloorStructure(pixels, width, height, region)]));
}

function normalizedStairBox(stair: DetectedStair, footprint: DetectedStructure["footprint"]) {
  return {
    x: (stair.x - footprint.x) / Math.max(1, footprint.width),
    y: (stair.y - footprint.y) / Math.max(1, footprint.height),
    width: stair.width / Math.max(1, footprint.width),
    height: stair.height / Math.max(1, footprint.height),
    centerX: (stair.x + stair.width / 2 - footprint.x) / Math.max(1, footprint.width),
    centerY: (stair.y + stair.height / 2 - footprint.y) / Math.max(1, footprint.height),
  };
}

/**
 * Adjacent floorplans describe the same physical stair shaft with different
 * amounts of linework. Once the floor order is known, use the upper-floor
 * shaft (where the full opening is visible) as the shared normalized box for
 * the floor below. This keeps the analyser overlay and the 3D coordinate
 * conversion on one common vertical axis.
 */
export function alignAdjacentStairStructures(
  regions: SourceRegion[],
  structures: Record<string, DetectedStructure>,
) {
  const aligned = { ...structures };
  for (let index = regions.length - 2; index >= 0; index -= 1) {
    const lower = aligned[regions[index].id];
    const upper = aligned[regions[index + 1].id];
    if (!lower?.stairs.length || !upper?.stairs.length) continue;
    const upperStair = [...upper.stairs].sort((a, b) => b.confidence - a.confidence)[0];
    const upperBox = normalizedStairBox(upperStair, upper.footprint);
    const candidates = lower.stairs
      .map((stair) => {
        const box = normalizedStairBox(stair, lower.footprint);
        return {
          stair,
          box,
          distance: Math.hypot(box.centerX - upperBox.centerX, box.centerY - upperBox.centerY),
        };
      })
      .filter(({ stair }) => stair.runAxis === upperStair.runAxis)
      .sort((a, b) => a.distance - b.distance);
    const match = candidates[0];
    if (!match || match.distance > 0.22) continue;
    const projected: DetectedStair = {
      ...match.stair,
      runAxis: upperStair.runAxis,
      x: lower.footprint.x + upperBox.x * lower.footprint.width,
      y: lower.footprint.y + upperBox.y * lower.footprint.height,
      width: upperBox.width * lower.footprint.width,
      height: upperBox.height * lower.footprint.height,
      confidence: Math.max(match.stair.confidence, upperStair.confidence * 0.94),
    };
    aligned[regions[index].id] = {
      ...lower,
      stairs: lower.stairs.map((stair) => stair.id === match.stair.id ? projected : stair),
    };
  }
  return aligned;
}

export function structureToLevel(
  structure: DetectedStructure,
  region: SourceRegion,
  index: number,
): Level {
  const footprint = structure.footprint;
  const sceneWidth = 10;
  const pixelsToMetres = sceneWidth / Math.max(1, footprint.width);
  const sceneDepth = clamp(footprint.height * pixelsToMetres, 4.2, 15);
  const centerX = footprint.x + footprint.width / 2;
  const centerY = footprint.y + footprint.height / 2;
  const toScene = ([x, y]: [number, number]): [number, number] => [
    (x - centerX) * pixelsToMetres,
    (y - centerY) * pixelsToMetres,
  ];

  const walls: Wall[] = structure.walls.map((wall) => {
    const clippedStart: [number, number] = [
      clamp(wall.start[0], footprint.x, footprint.x + footprint.width),
      clamp(wall.start[1], footprint.y, footprint.y + footprint.height),
    ];
    const clippedEnd: [number, number] = [
      clamp(wall.end[0], footprint.x, footprint.x + footprint.width),
      clamp(wall.end[1], footprint.y, footprint.y + footprint.height),
    ];
    const trim = Math.hypot(clippedStart[0] - wall.start[0], clippedStart[1] - wall.start[1]);
    const clippedLength = Math.hypot(clippedEnd[0] - clippedStart[0], clippedEnd[1] - clippedStart[1]);
    const start = toScene(clippedStart);
    const end = toScene(clippedEnd);
    const openings: Opening[] = wall.openings.flatMap((opening) => {
      const from = clamp(opening.offset - trim, 0, clippedLength);
      const to = clamp(opening.offset + opening.width - trim, 0, clippedLength);
      if (to - from < 2) return [];
      return [{
        kind: opening.kind,
        offset: from * pixelsToMetres,
        width: (to - from) * pixelsToMetres,
        height: opening.kind === "door" ? 2.12 : 1.3,
        sill: opening.kind === "window" ? 0.9 : undefined,
        confidence: opening.confidence,
      }];
    });
    return {
      id: `${region.id}-${wall.id}`,
      start,
      end,
      thickness: clamp(wall.thickness * pixelsToMetres, 0.1, 0.42),
      openings,
      confidence: wall.confidence,
    };
  }).filter((wall) => Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) > 0.05);

  const detectedOutdoor = region.hasOutdoorArea === false ? [] : structure.outdoorAreas;
  const outdoorSource = detectedOutdoor.length || !region.hasOutdoorArea
    ? detectedOutdoor
    : [{
      id: `manual-outdoor-${region.id}`,
      side: "bottom" as const,
      x: footprint.x + footprint.width * 0.08,
      y: footprint.y + footprint.height,
      width: footprint.width * 0.84,
      height: footprint.height * 0.24,
      confidence: 0.55,
    }];
  const outdoorAreas: OutdoorArea[] = outdoorSource.map((area) => {
    const areaWidth = area.width * pixelsToMetres;
    const areaDepth = area.height * pixelsToMetres;
    let x = (area.x + area.width / 2 - centerX) * pixelsToMetres;
    let z = (area.y + area.height / 2 - centerY) * pixelsToMetres;
    // Attach the detected platform to the corresponding slab edge. Pixel
    // evidence determines its span and depth, while this constraint prevents
    // small crop/footprint disagreements from moving it under or away from the
    // building in 3D.
    if (area.side === "bottom") z = sceneDepth / 2 + areaDepth / 2;
    if (area.side === "top") z = -sceneDepth / 2 - areaDepth / 2;
    if (area.side === "right") x = sceneWidth / 2 + areaWidth / 2;
    if (area.side === "left") x = -sceneWidth / 2 - areaWidth / 2;
    if (area.side === "top" || area.side === "bottom") {
      x = clamp(x, -sceneWidth / 2 + areaWidth / 2, sceneWidth / 2 - areaWidth / 2);
    } else {
      z = clamp(z, -sceneDepth / 2 + areaDepth / 2, sceneDepth / 2 - areaDepth / 2);
    }
    return {
      id: area.id,
      x,
      z,
      width: areaWidth,
      depth: areaDepth,
      side: area.side,
      confidence: area.confidence,
    };
  });
  const stairs: Stair[] = structure.stairs.map((stair) => ({
    id: stair.id,
    x: (stair.x + stair.width / 2 - centerX) * pixelsToMetres,
    z: (stair.y + stair.height / 2 - centerY) * pixelsToMetres,
    width: stair.width * pixelsToMetres,
    depth: stair.height * pixelsToMetres,
    runAxis: stair.runAxis,
    stepCount: stair.stepCount,
    confidence: stair.confidence,
  }));

  return {
    id: region.id,
    name: region.name,
    shortName: index === 0 ? "BASE" : `${index}F`,
    elevation: index * 3.05,
    ceilingHeight: index === 0 ? 2.7 : 2.55,
    area: Number((sceneWidth * sceneDepth).toFixed(1)),
    roomCount: structure.roomCount,
    wallCount: walls.length,
    openingCount: walls.reduce((sum, wall) => sum + (wall.openings?.length ?? 0), 0),
    scaleStatus: "needed",
    slab: { width: sceneWidth, depth: sceneDepth, x: 0, z: 0 },
    walls,
    outdoorAreas,
    stairs,
    floorTextureUrl: structure.floorTextureUrl,
    detectionConfidence: structure.confidence,
    source: "detected",
  };
}
