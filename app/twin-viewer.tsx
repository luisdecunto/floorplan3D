"use client";

/* eslint-disable react/no-unknown-property */

import { ContactShadows, Environment, OrbitControls } from "@react-three/drei";
import { Canvas, useLoader } from "@react-three/fiber";
import { ReactNode, useEffect, useMemo } from "react";
import { SRGBColorSpace, TextureLoader } from "three";
import { type Level, type OutdoorArea, type Stair, type Wall } from "./scene-data";

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
  return (
    <div className="twin-canvas">
      <Canvas shadows dpr={[1, 1.75]} camera={{ position: [12, 10, 14], fov: 36, near: 0.1, far: 100 }}>
        <color attach="background" args={["#ebe9e1"]} />
        <ambientLight intensity={1.25} />
        <directionalLight position={[7, 12, 6]} intensity={2.1} castShadow shadow-mapSize={[1024, 1024]} />
        <group position={[0, -1.25, 0]}>
          {levels.map((level, index) => visibleLevels.has(level.id) && (
            <LevelModel key={level.id} level={level} explodeOffset={exploded ? index * 2.35 : 0} wallOpacity={wallOpacity} />
          ))}
          <ContactShadows position={[0, -0.03, 0]} opacity={0.24} scale={24} blur={2.8} far={12} />
        </group>
        <OrbitControls makeDefault minDistance={7} maxDistance={28} minPolarAngle={0.35} maxPolarAngle={Math.PI / 2.05} target={[0, 2.2, 0]} />
        <Environment preset="city" environmentIntensity={0.35} />
      </Canvas>
      <div className="viewer-legend"><span><i className="legend-wall" /> Structure</span><span><i className="legend-window" /> Windows</span><span><i className="legend-stair" /> Stairs</span><span><i className="legend-outdoor" /> Balcony</span><span><i className="legend-detail" /> Plan details</span></div>
    </div>
  );
}

function LevelModel({ level, explodeOffset, wallOpacity }: { level: Level; explodeOffset: number; wallOpacity: number }) {
  const y = level.elevation + explodeOffset;
  return (
    <group>
      <mesh position={[level.slab.x, y - 0.09, level.slab.z]} receiveShadow castShadow>
        <boxGeometry args={[level.slab.width, 0.18, level.slab.depth]} />
        <meshStandardMaterial color="#d4c5a6" roughness={0.9} />
      </mesh>
      <mesh position={[level.slab.x, y + 0.015, level.slab.z]} receiveShadow>
        <boxGeometry args={[level.slab.width - 0.16, 0.05, level.slab.depth - 0.16]} />
        <meshStandardMaterial color="#eee8da" roughness={0.82} />
      </mesh>
      {level.floorTextureUrl && <PlanFloor level={level} elevation={y} />}
      {(level.outdoorAreas ?? []).map((area) => <OutdoorAreaModel key={area.id} area={area} elevation={y} />)}
      {(level.stairs ?? []).map((stair) => <StairModel key={stair.id} stair={stair} elevation={y} />)}
      {level.walls.map((wall) => <WallModel key={wall.id} wall={wall} elevation={y} levelHeight={level.ceilingHeight} wallOpacity={wallOpacity} />)}
    </group>
  );
}

function PlanFloor({ level, elevation }: { level: Level; elevation: number }) {
  const loadedTexture = useLoader(TextureLoader, level.floorTextureUrl ?? "");
  const texture = useMemo(() => {
    const copy = loadedTexture.clone();
    copy.colorSpace = SRGBColorSpace;
    copy.needsUpdate = true;
    return copy;
  }, [loadedTexture]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={[level.slab.x, elevation + 0.048, level.slab.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[level.slab.width - 0.2, level.slab.depth - 0.2]} />
      <meshStandardMaterial map={texture} roughness={0.95} metalness={0} />
    </mesh>
  );
}

function StairModel({ stair, elevation }: { stair: Stair; elevation: number }) {
  const count = clampInteger(stair.stepCount, 5, 16);
  const runLength = stair.runAxis === "vertical" ? stair.depth : stair.width;
  const crossLength = stair.runAxis === "vertical" ? stair.width : stair.depth;
  const tread = runLength / count;
  const totalRise = Math.min(1.5, Math.max(0.85, runLength * 0.45));
  return (
    <group>
      <mesh position={[stair.x, elevation + 0.035, stair.z]} receiveShadow>
        <boxGeometry args={[stair.width + 0.12, 0.07, stair.depth + 0.12]} />
        <meshStandardMaterial color="#473f51" roughness={0.86} />
      </mesh>
      {Array.from({ length: count }, (_, index) => {
        const height = ((index + 1) / count) * totalRise;
        const runPosition = -runLength / 2 + (index + 0.5) * tread;
        const position: [number, number, number] = stair.runAxis === "vertical"
          ? [stair.x, elevation + height / 2 + 0.07, stair.z + runPosition]
          : [stair.x + runPosition, elevation + height / 2 + 0.07, stair.z];
        const size: [number, number, number] = stair.runAxis === "vertical"
          ? [Math.max(0.28, crossLength - 0.08), height, tread * 1.04]
          : [tread * 1.04, height, Math.max(0.28, crossLength - 0.08)];
        return (
          <mesh key={index} position={position} castShadow receiveShadow>
            <boxGeometry args={size} />
            <meshStandardMaterial color={index % 2 ? "#c79a61" : "#d6ad78"} roughness={0.8} />
          </mesh>
        );
      })}
    </group>
  );
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.round(Math.max(minimum, Math.min(maximum, value)));
}

function OutdoorAreaModel({ area, elevation }: { area: OutdoorArea; elevation: number }) {
  const railHeight = 1.05;
  const railThickness = 0.06;
  const rails: Array<{ key: string; position: [number, number, number]; size: [number, number, number] }> = [];
  const posts: Array<{ key: string; position: [number, number, number] }> = [];
  const addHorizontal = (key: string, z: number) => {
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

  return (
    <group>
      <mesh position={[area.x, elevation - 0.035, area.z]} receiveShadow castShadow>
        <boxGeometry args={[area.width, 0.16, area.depth]} />
        <meshStandardMaterial color="#a96f36" roughness={0.9} />
      </mesh>
      {Array.from({ length: plankCount }, (_, index) => (
        <mesh key={`plank-${index}`} position={[area.x - area.width / 2 + area.width * (index + 0.5) / plankCount, elevation + 0.052, area.z]} receiveShadow>
          <boxGeometry args={[Math.max(0.08, area.width / plankCount - 0.025), 0.018, Math.max(0.12, area.depth - 0.08)]} />
          <meshStandardMaterial color={index % 2 ? "#c59056" : "#d0a168"} roughness={0.92} />
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
