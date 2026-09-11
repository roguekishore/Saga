import { Html, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import type { ContextGrowth } from '@saga/contracts';
import { Card, CardHeader, fmtBytes, fmtInt, fmtTokens, PROVENANCE_META } from '@saga/ui';
import { useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useThemeColors } from '../lib/use-theme-colors';

/**
 * Context growth as terrain: turns along X, four measures as lanes in Z,
 * volume as height. The same numbers as the 2D charts — this view exists
 * because time × measure × volume is genuinely three-dimensional data, and
 * the ballooning of a session reads instantly as topography.
 *
 * Progressive enhancement rules: lazy chunk, WebGL-gated by the caller,
 * static under prefers-reduced-motion (no auto-rotate, no entrance sweep),
 * and every number it shows also exists in the 2D charts.
 */

type GrowthPoint = ContextGrowth['points'][number];

interface Lane {
  key: 'input' | 'output' | 'bytes' | 'messages';
  label: string;
  cssVar: string;
  value: (p: GrowthPoint) => number | null;
  format: (n: number) => string;
  source: (p: GrowthPoint) => string | null;
}

const LANES: Lane[] = [
  {
    key: 'input',
    label: 'input tokens',
    cssVar: '--saga-cat-6',
    value: (p) => p.inputTokens?.value ?? null,
    format: fmtTokens,
    source: (p) => (p.inputTokens ? PROVENANCE_META[p.inputTokens.source].label : null),
  },
  {
    key: 'output',
    label: 'output tokens',
    cssVar: '--saga-cat-1',
    value: (p) => p.outputTokens?.value ?? null,
    format: fmtTokens,
    source: (p) => (p.outputTokens ? PROVENANCE_META[p.outputTokens.source].label : null),
  },
  {
    key: 'bytes',
    label: 'payload bytes',
    cssVar: '--saga-cat-4',
    value: (p) => p.requestBytes,
    format: fmtBytes,
    source: () => 'measured wire bytes',
  },
  {
    key: 'messages',
    label: 'messages',
    cssVar: '--saga-cat-3',
    value: (p) => p.messageCount,
    format: fmtInt,
    source: () => 'counted in the payload',
  },
];

const WIDTH = 9;
const LANE_GAP = 1.15;
const MAX_H = 2.6;

interface Hover {
  lane: Lane;
  point: GrowthPoint;
  x: number;
  h: number;
  z: number;
}

function RidgeLane({
  lane,
  points,
  color,
  z,
  entrance,
  onHover,
}: {
  lane: Lane;
  points: GrowthPoint[];
  color: string;
  z: number;
  entrance: boolean;
  onHover: (h: Hover | null) => void;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const progress = useRef(entrance ? 0 : 1);
  const [hovered, setHovered] = useState<number | null>(null);

  const layout = useMemo(() => {
    const values = points.map((p) => lane.value(p));
    const max = Math.max(1, ...values.map((v) => v ?? 0));
    const step = WIDTH / Math.max(1, points.length);
    return points.map((p, i) => {
      const v = values[i];
      return {
        x: -WIDTH / 2 + step * (i + 0.5),
        h: v == null ? 0.015 : Math.max(0.03, (v / max) * MAX_H),
        w: step * 0.78,
        missing: v == null,
        point: p,
      };
    });
  }, [points, lane]);

  const applyMatrices = (t: number): void => {
    const m = mesh.current;
    if (!m) return;
    const mat = new THREE.Matrix4();
    layout.forEach((b, i) => {
      const h = b.h * t;
      mat.makeScale(b.w, h, 0.72);
      mat.setPosition(b.x, h / 2, z);
      m.setMatrixAt(i, mat);
    });
    m.instanceMatrix.needsUpdate = true;
  };

  // Entrance sweep: heights rise once, then the loop goes quiet.
  useFrame((_, delta) => {
    if (progress.current >= 1) return;
    progress.current = Math.min(1, progress.current + delta / 0.9);
    const eased = 1 - (1 - progress.current) ** 3;
    applyMatrices(eased);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: applyMatrices reads only stable refs and layout
  useEffect(() => {
    applyMatrices(progress.current >= 1 ? 1 : 0.0001);
  }, [layout, z]);

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, layout.length]}
      onPointerMove={(e) => {
        e.stopPropagation();
        const i = e.instanceId ?? null;
        setHovered(i);
        if (i != null) {
          const b = layout[i]!;
          onHover({ lane, point: b.point, x: b.x, h: b.h, z });
        }
      }}
      onPointerOut={() => {
        setHovered(null);
        onHover(null);
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={color}
        roughness={0.55}
        metalness={0.1}
        transparent
        opacity={hovered != null ? 1 : 0.92}
      />
    </instancedMesh>
  );
}

function Scene({ points }: { points: GrowthPoint[] }) {
  const reduced = useReducedMotion() ?? false;
  const colors = useThemeColors(LANES.map((l) => l.cssVar));
  const lineColor = useThemeColors(['--saga-line-strong'])[0];
  const [hover, setHover] = useState<Hover | null>(null);
  const [interacted, setInteracted] = useState(false);

  const tickEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <>
      <ambientLight intensity={1.1} />
      <directionalLight position={[6, 10, 4]} intensity={1.4} />
      {LANES.map((lane, li) => (
        <group key={lane.key}>
          <RidgeLane
            lane={lane}
            points={points}
            color={colors[li]!}
            z={(li - (LANES.length - 1) / 2) * LANE_GAP}
            entrance={!reduced}
            onHover={setHover}
          />
          <Html
            position={[-WIDTH / 2 - 0.4, 0.02, (li - (LANES.length - 1) / 2) * LANE_GAP]}
            center
            className="pointer-events-none select-none whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.08em] text-ink-faint"
          >
            {lane.label}
          </Html>
        </group>
      ))}

      {/* turn axis ticks */}
      {points.map((p, i) =>
        i % tickEvery === 0 ? (
          <Html
            key={p.turn}
            position={[-WIDTH / 2 + (WIDTH / points.length) * (i + 0.5), 0, LANE_GAP * 2.35]}
            center
            className="pointer-events-none select-none font-mono text-[9.5px] tabular-nums text-ink-faint"
          >
            {p.turn}
          </Html>
        ) : null,
      )}

      <gridHelper
        args={[WIDTH + 2, 12, lineColor, lineColor]}
        position={[0, -0.001, 0]}
        material-transparent
        material-opacity={0.35}
      />

      {hover ? (
        <Html
          position={[hover.x, hover.h + 0.35, hover.z]}
          center
          className="pointer-events-none z-10"
        >
          <div className="whitespace-nowrap rounded-lg border border-line bg-overlay px-2.5 py-1.5 text-[11px] shadow-float">
            <div className="font-medium text-ink">
              turn {hover.point.turn} · {hover.lane.label}
            </div>
            <div className="font-mono tabular-nums text-ink-dim">
              {(() => {
                const v = hover.lane.value(hover.point);
                return v == null ? 'n/a — nothing reported' : hover.lane.format(v);
              })()}
              {hover.lane.source(hover.point) ? (
                <span className="text-ink-faint"> · {hover.lane.source(hover.point)}</span>
              ) : null}
            </div>
          </div>
        </Html>
      ) : null}

      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        autoRotate={!reduced && !interacted}
        autoRotateSpeed={0.55}
        minDistance={5}
        maxDistance={22}
        maxPolarAngle={Math.PI / 2.05}
        onStart={() => setInteracted(true)}
      />
    </>
  );
}

export default function ContextTopography({ points }: { points: GrowthPoint[] }) {
  const reduced = useReducedMotion() ?? false;
  return (
    <Card>
      <CardHeader
        title="Context topography"
        hint="turns × measure × volume — drag to orbit, scroll to zoom"
      />
      <div className="h-[420px] px-2 pb-2">
        <Canvas
          dpr={[1, 1.75]}
          frameloop={reduced ? 'demand' : 'always'}
          camera={{ position: [7.5, 5.5, 9], fov: 38 }}
          gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        >
          <Scene points={points} />
        </Canvas>
      </div>
    </Card>
  );
}
