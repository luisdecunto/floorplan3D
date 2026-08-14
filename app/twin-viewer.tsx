"use client";

/* eslint-disable react/no-unknown-property */

import { ContactShadows, Environment, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { ReactNode } from "react";
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
      <div className="viewer-legend"><span><i className="legend-wall" /> Structure</span><span><i className="legend-window" /> Windows</span><span><i className="legend-outdoor" /> Balcony</span></div>
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
      {(level.outdoorAreas ?? []).map((area) => <OutdoorAreaModel key={area.id} area={area} elevation={y} />)}
      {level.walls.map((wall) => <WallModel key={wall.id} wall={wall} elevation={y} levelHeight={level.ceilingHeight} wallOpacity={wallOpacity} />)}
    </group>
  );
}

function OutdoorAreaModel({ area, elevation }: { area: OutdoorArea; elevation: number }) {
  const railHeight = 1.05;
  const railThickness = 0.06;
  const rails: Array<{ key: string; position: [number, number, number]; size: [number, number, number] }> = [];
  const addHorizontal = (key: string, z: number) => rails.push({
    key,
    position: [area.x, elevation + railHeight / 2, z],
    size: [area.width, railHeight, railThickness],
  });
  const addVertical = (key: string, x: number) => rails.push({
    key,
    position: [x, elevation + railHeight / 2, area.z],
    size: [railThickness, railHeight, area.depth],
  });

  if (area.side !== "bottom") addHorizontal("rail-top", area.z - area.depth / 2);
  if (area.side !== "top") addHorizontal("rail-bottom", area.z + area.depth / 2);
  if (area.side !== "right") addVertical("rail-left", area.x - area.width / 2);
  if (area.side !== "left") addVertical("rail-right", area.x + area.width / 2);

  return (
    <group>
      <mesh position={[area.x, elevation - 0.055, area.z]} receiveShadow castShadow>
        <boxGeometry args={[area.width, 0.11, area.depth]} />
        <meshStandardMaterial color="#c9b88f" roughness={0.88} />
      </mesh>
      {rails.map((rail) => (
        <mesh key={rail.key} position={rail.position} castShadow>
          <boxGeometry args={rail.size} />
          <meshStandardMaterial color="#535b59" roughness={0.62} metalness={0.18} />
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
