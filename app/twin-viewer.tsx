"use client";

/* eslint-disable react/no-unknown-property */

import { ContactShadows, Environment, OrbitControls } from "@react-three/drei";
import { Canvas, useLoader } from "@react-three/fiber";
import { ReactNode, useEffect, useMemo } from "react";
import { SRGBColorSpace, TextureLoader } from "three";
import {
  buildStairConnections,
  sceneFootprint,
  slabPieceTextureUv,
  slabPieces,
  stairwellOpening,
  type SlabPiece,
  type StairConnection,
  type StairwellOpening,
} from "./scene-geometry";
import { type Level, type OutdoorArea, type Wall } from "./scene-data";

export default function TwinViewer({
  exploded,
  levels,
  visibleLevels,
  wallOpacity,
}: {
  exploded: boolean;
  levels: Level[];
  visibleLevels: Set<string>;
  wallOpacity: number;
}) {
  const explodeDistance = exploded ? 2.35 : 0;
  const stairConnections = buildStairConnections(levels, explodeDistance);
  const stairOpenings = new Map(stairConnections.map((connection) => [connection.upperLevelId, connection.opening]));
  const footprint = sceneFootprint(levels);
  return (
    <div className="twin-canvas">
      <Canvas shadows dpr={[1, 1.75]} camera={{ position: [footprint.centerX + 12, 10, footprint.centerZ + 14], fov: 36, near: 0.1, far: 100 }}>
        <color attach="background" args={["#ebe9e1"]} />
        <ambientLight intensity={1.25} />
        <directionalLight position={[7, 12, 6]} intensity={2.1} castShadow shadow-mapSize={[1024, 1024]} />
        <group position={[0, -1.25, 0]}>
          {levels.map((level, index) => visibleLevels.has(level.id) && (
            <LevelModel
              key={level.id}
              level={level}
              opening={index > 0 ? stairOpenings.get(level.id) ?? stairwellOpening(level) : null}
              explodeOffset={index * explodeDistance}
              wallOpacity={wallOpacity}
            />
          ))}
          {stairConnections.map((connection) => (
            visibleLevels.has(connection.lowerLevelId) && visibleLevels.has(connection.upperLevelId)
              ? <StairConnectionModel key={connection.id} connection={connection} />
              : null
          ))}
          <ContactShadows position={[0, -0.03, 0]} opacity={0.24} scale={24} blur={2.8} far={12} />
        </group>
        <OrbitControls makeDefault minDistance={7} maxDistance={30} minPolarAngle={0.35} maxPolarAngle={Math.PI / 2.05} target={[footprint.centerX, 2.2, footprint.centerZ]} />
        <Environment preset="city" environmentIntensity={0.35} />
      </Canvas>
      <div className="viewer-legend"><span><i className="legend-wall" /> Structure</span><span><i className="legend-window" /> Windows</span><span><i className="legend-stair" /> Stairs</span><span><i className="legend-outdoor" /> Balcony</span><span><i className="legend-detail" /> Plan details</span></div>
    </div>
  );
}

function LevelModel({
  level,
  opening,
  explodeOffset,
  wallOpacity,
}: {
  level: Level;
  opening: StairwellOpening | null;
  explodeOffset: number;
  wallOpacity: number;
}) {
  const y = level.elevation + explodeOffset;
  const pieces = slabPieces(level, opening);
  return (
    <group>
      {pieces.map((piece) => <SlabPieceModel key={piece.id} piece={piece} elevation={y} />)}
      {level.floorTextureUrl && <PlanFloor level={level} pieces={pieces} elevation={y} />}
      {opening && <StairwellTrim opening={opening} elevation={y} />}
      {(level.outdoorAreas ?? []).map((area) => <OutdoorAreaModel key={area.id} area={area} elevation={y} />)}
      {level.walls.map((wall) => <WallModel key={wall.id} wall={wall} elevation={y} levelHeight={level.ceilingHeight} wallOpacity={wallOpacity} />)}
    </group>
  );
}

function SlabPieceModel({ piece, elevation }: { piece: SlabPiece; elevation: number }) {
  return (
    <group>
      <mesh position={[piece.x, elevation - 0.09, piece.z]} receiveShadow castShadow>
        <boxGeometry args={[piece.width, 0.18, piece.depth]} />
        <meshStandardMaterial color="#d4c5a6" roughness={0.9} />
      </mesh>
      <mesh position={[piece.x, elevation + 0.015, piece.z]} receiveShadow>
        <boxGeometry args={[Math.max(0.02, piece.width - 0.08), 0.05, Math.max(0.02, piece.depth - 0.08)]} />
        <meshStandardMaterial color="#eee8da" roughness={0.82} />
      </mesh>
    </group>
  );
}

function PlanFloor({ level, pieces, elevation }: { level: Level; pieces: SlabPiece[]; elevation: number }) {
  return <>{pieces.map((piece) => <PlanFloorPiece key={piece.id} level={level} piece={piece} elevation={elevation} />)}</>;
}

function PlanFloorPiece({ level, piece, elevation }: { level: Level; piece: SlabPiece; elevation: number }) {
  const loadedTexture = useLoader(TextureLoader, level.floorTextureUrl ?? "");
  const uv = useMemo(() => new Float32Array(slabPieceTextureUv(level, piece)), [level, piece]);
  const texture = useMemo(() => {
    const copy = loadedTexture.clone();
    copy.colorSpace = SRGBColorSpace;
    copy.needsUpdate = true;
    return copy;
  }, [loadedTexture]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={[piece.x, elevation + 0.048, piece.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[piece.width, piece.depth]}>
        <bufferAttribute attach="attributes-uv" args={[uv, 2]} />
      </planeGeometry>
      <meshStandardMaterial map={texture} roughness={0.95} metalness={0} />
    </mesh>
  );
}

function StairwellTrim({ opening, elevation }: { opening: StairwellOpening; elevation: number }) {
  const thickness = 0.07;
  const height = 0.24;
  return (
    <group>
      {[
        { id: "back", position: [opening.x, elevation - height / 2, opening.z - opening.depth / 2] as [number, number, number], size: [opening.width, height, thickness] as [number, number, number] },
        { id: "front", position: [opening.x, elevation - height / 2, opening.z + opening.depth / 2] as [number, number, number], size: [opening.width, height, thickness] as [number, number, number] },
        { id: "left", position: [opening.x - opening.width / 2, elevation - height / 2, opening.z] as [number, number, number], size: [thickness, height, opening.depth] as [number, number, number] },
        { id: "right", position: [opening.x + opening.width / 2, elevation - height / 2, opening.z] as [number, number, number], size: [thickness, height, opening.depth] as [number, number, number] },
      ].map((trim) => (
        <mesh key={trim.id} position={trim.position} receiveShadow castShadow>
          <boxGeometry args={trim.size} />
          <meshStandardMaterial color="#453f48" roughness={0.82} />
        </mesh>
      ))}
    </group>
  );
}

function StairConnectionModel({ connection }: { connection: StairConnection }) {
  return (
    <group>
      <StairFlightModel flight={connection.lowerFlight} width={connection.width} colorOffset={0} />
      <mesh position={[connection.landing.x, connection.landing.elevation - 0.08, connection.landing.z]} castShadow receiveShadow>
        <boxGeometry args={[connection.landing.width, 0.16, connection.landing.depth]} />
        <meshStandardMaterial color="#bd8b52" roughness={0.82} />
      </mesh>
      <StairFlightModel flight={connection.upperFlight} width={connection.width} colorOffset={1} />
    </group>
  );
}

function StairFlightModel({
  flight,
  width,
  colorOffset,
}: {
  flight: StairConnection["lowerFlight"];
  width: number;
  colorOffset: number;
}) {
  const dx = flight.end[0] - flight.start[0];
  const dz = flight.end[1] - flight.start[1];
  const runLength = Math.max(0.5, Math.hypot(dx, dz));
  const angle = Math.atan2(dz, dx);
  const tread = runLength / flight.stepCount;
  const rise = flight.toElevation - flight.fromElevation;
  return (
    <group>
      {Array.from({ length: flight.stepCount }, (_, index) => {
        const progress = (index + 0.5) / flight.stepCount;
        const height = ((index + 1) / flight.stepCount) * rise;
        const position: [number, number, number] = [
          flight.start[0] + dx * progress,
          flight.fromElevation + height / 2,
          flight.start[1] + dz * progress,
        ];
        return (
          <mesh key={index} position={position} rotation={[0, -angle, 0]} castShadow receiveShadow>
            <boxGeometry args={[tread * 1.06, height, width]} />
            <meshStandardMaterial color={(index + colorOffset) % 2 ? "#c79a61" : "#d6ad78"} roughness={0.8} />
          </mesh>
        );
      })}
    </group>
  );
}

function OutdoorAreaModel({ area, elevation }: { area: OutdoorArea; elevation: number }) {
  const railHeight = 1.05;
  const railThickness = 0.06;
  const rails: Array<{ key: string; position: [number, number, number]; size: [number, number, number] }> = [];
  const guards: Array<{ key: string; position: [number, number, number]; size: [number, number, number] }> = [];
  const posts: Array<{ key: string; position: [number, number, number] }> = [];
  const addHorizontal = (key: string, z: number) => {
    guards.push({ key: `${key}-guard`, position: [area.x, elevation + 0.31, z], size: [Math.max(0.1, area.width - 0.1), 0.56, 0.035] });
    [railHeight * 0.55, railHeight].forEach((barHeight, index) => rails.push({
      key: `${key}-bar-${index}`,
      position: [area.x, elevation + barHeight, z],
      size: [area.width, railThickness, railThickness],
    }));
    const count = Math.max(2, Math.ceil(area.width / 1.25));
    for (let index = 0; index <= count; index += 1) posts.push({
      key: `${key}-post-${index}`,
      position: [area.x - area.width / 2 + area.width * index / count, elevation + railHeight / 2, z],
    });
  };
  const addVertical = (key: string, x: number) => {
    guards.push({ key: `${key}-guard`, position: [x, elevation + 0.31, area.z], size: [0.035, 0.56, Math.max(0.1, area.depth - 0.1)] });
    [railHeight * 0.55, railHeight].forEach((barHeight, index) => rails.push({
      key: `${key}-bar-${index}`,
      position: [x, elevation + barHeight, area.z],
      size: [railThickness, railThickness, area.depth],
    }));
    const count = Math.max(2, Math.ceil(area.depth / 1.25));
    for (let index = 0; index <= count; index += 1) posts.push({
      key: `${key}-post-${index}`,
      position: [x, elevation + railHeight / 2, area.z - area.depth / 2 + area.depth * index / count],
    });
  };
  /* The area side points away from the building, so the opposite edge is the
     attached edge and intentionally has no guard rail. */
  if (area.side !== "bottom") addHorizontal("rail-top", area.z - area.depth / 2);
  if (area.side !== "top") addHorizontal("rail-bottom", area.z + area.depth / 2);
  if (area.side !== "right") addVertical("rail-left", area.x - area.width / 2);
  if (area.side !== "left") addVertical("rail-right", area.x + area.width / 2);
  const plankCount = Math.max(4, Math.min(18, Math.ceil(area.width / 0.55)));
  const outerEdge = area.side === "bottom"
    ? { position: [area.x, elevation - 0.15, area.z + area.depth / 2] as [number, number, number], size: [area.width, 0.3, 0.12] as [number, number, number] }
    : area.side === "top"
      ? { position: [area.x, elevation - 0.15, area.z - area.depth / 2] as [number, number, number], size: [area.width, 0.3, 0.12] as [number, number, number] }
      : area.side === "right"
        ? { position: [area.x + area.width / 2, elevation - 0.15, area.z] as [number, number, number], size: [0.12, 0.3, area.depth] as [number, number, number] }
        : { position: [area.x - area.width / 2, elevation - 0.15, area.z] as [number, number, number], size: [0.12, 0.3, area.depth] as [number, number, number] };
  const supportHeight = Math.max(0, elevation - 0.12);
  const supportPoints: Array<[number, number]> = area.side === "top" || area.side === "bottom"
    ? [[area.x - area.width * 0.43, outerEdge.position[2]], [area.x + area.width * 0.43, outerEdge.position[2]]]
    : [[outerEdge.position[0], area.z - area.depth * 0.43], [outerEdge.position[0], area.z + area.depth * 0.43]];

  return (
    <group>
      <mesh position={[area.x, elevation - 0.035, area.z]} receiveShadow castShadow>
        <boxGeometry args={[area.width, 0.22, area.depth]} />
        <meshStandardMaterial color="#a96f36" emissive="#351702" emissiveIntensity={0.12} roughness={0.9} />
      </mesh>
      <mesh position={outerEdge.position} castShadow receiveShadow>
        <boxGeometry args={outerEdge.size} />
        <meshStandardMaterial color="#6b4528" roughness={0.86} />
      </mesh>
      {Array.from({ length: plankCount }, (_, index) => (
        <mesh key={`plank-${index}`} position={[area.x - area.width / 2 + area.width * (index + 0.5) / plankCount, elevation + 0.052, area.z]} receiveShadow>
          <boxGeometry args={[Math.max(0.08, area.width / plankCount - 0.025), 0.018, Math.max(0.12, area.depth - 0.08)]} />
          <meshStandardMaterial color={index % 2 ? "#c59056" : "#d0a168"} roughness={0.92} />
        </mesh>
      ))}
      {guards.map((guard) => (
        <mesh key={guard.key} position={guard.position} castShadow>
          <boxGeometry args={guard.size} />
          <meshStandardMaterial color="#85b8b6" roughness={0.28} metalness={0.08} transparent opacity={0.48} depthWrite={false} />
        </mesh>
      ))}
      {rails.map((rail) => (
        <mesh key={rail.key} position={rail.position} castShadow>
          <boxGeometry args={rail.size} />
          <meshStandardMaterial color="#36413f" roughness={0.56} metalness={0.28} />
        </mesh>
      ))}
      {posts.map((post) => (
        <mesh key={post.key} position={post.position} castShadow>
          <boxGeometry args={[railThickness, railHeight, railThickness]} />
          <meshStandardMaterial color="#36413f" roughness={0.56} metalness={0.28} />
        </mesh>
      ))}
      {supportHeight > 0.4 && supportPoints.map(([x, z], index) => (
        <mesh key={`balcony-support-${index}`} position={[x, supportHeight / 2, z]} castShadow receiveShadow>
          <boxGeometry args={[0.18, supportHeight, 0.18]} />
          <meshStandardMaterial color="#515856" roughness={0.7} metalness={0.12} />
        </mesh>
      ))}
    </group>
  );
}

function WallModel({ wall, elevation, levelHeight, wallOpacity }: { wall: Wall; elevation: number; levelHeight: number; wallOpacity: number }) {
  const dx = wall.end[0] - wall.start[0];
  const dz = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);
  const openings = [...(wall.openings ?? [])].sort((a, b) => a.offset - b.offset);
  const pieces: ReactNode[] = [];
  let cursor = 0;

  const clamp = (value: number) => Math.max(0, Math.min(length, value));
  const addBox = (key: string, from: number, to: number, height: number, base: number, color = "#f3f0e8", opacity = wallOpacity) => {
    if (to - from <= 0.02 || height <= 0.02) return;
    const distance = (from + to) / 2;
    const t = distance / length;
    const x = wall.start[0] + dx * t;
    const z = wall.start[1] + dz * t;
    pieces.push(
      <mesh key={key} position={[x, elevation + base + height / 2, z]} rotation={[0, -angle, 0]} castShadow={opacity > 0.72} receiveShadow>
        <boxGeometry args={[to - from, height, wall.thickness ?? 0.18]} />
        <meshStandardMaterial color={color} roughness={0.72} transparent={opacity < 1} opacity={opacity} depthWrite={opacity >= 0.99} />
      </mesh>,
    );
  };

  openings.forEach((opening, index) => {
    const from = clamp(opening.offset);
    const to = clamp(opening.offset + opening.width);
    addBox(`${wall.id}-body-${index}`, cursor, from, wall.height ?? levelHeight, 0);
    if (opening.kind === "window") {
      const sill = opening.sill ?? 0.9;
      addBox(`${wall.id}-sill-${index}`, from, to, sill, 0);
      addBox(`${wall.id}-header-${index}`, from, to, levelHeight - sill - opening.height, sill + opening.height);
      addBox(`${wall.id}-glass-${index}`, from + 0.04, to - 0.04, opening.height - 0.08, sill + 0.04, "#7fc6d1", 0.46);
    } else {
      addBox(`${wall.id}-header-${index}`, from, to, levelHeight - opening.height, opening.height);
    }
    cursor = to;
  });
  addBox(`${wall.id}-body-end`, cursor, length, wall.height ?? levelHeight, 0);
  return <>{pieces}</>;
}
