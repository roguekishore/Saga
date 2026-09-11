import { Canvas, useFrame } from '@react-three/fiber';
import { useReducedMotion } from 'motion/react';
import { useMemo, useRef } from 'react';
import type * as THREE from 'three';
import { useThemeColors } from '../lib/use-theme-colors';

/**
 * Ambient depth for surfaces where no data lives (empty feeds, the 404).
 * Sparse points drifting like packets across a wire — pure atmosphere.
 * Frozen under prefers-reduced-motion; callers gate on WebGL availability
 * and render nothing without it.
 */

const COUNT = 420;
const SPREAD_X = 15;

function Drift({ reduced, color }: { reduced: boolean; color: string }) {
  const points = useRef<THREE.Points>(null);
  const { positions, speeds } = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const sp = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * SPREAD_X;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 7;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 3;
      sp[i] = 0.15 + Math.random() * 0.85;
    }
    return { positions: pos, speeds: sp };
  }, []);

  useFrame((_, delta) => {
    if (reduced || !points.current) return;
    const attr = points.current.geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      const x = i * 3;
      const next = (arr[x] ?? 0) + speeds[i]! * delta * 0.55;
      arr[x] = next > SPREAD_X / 2 ? -SPREAD_X / 2 : next;
    }
    attr.needsUpdate = true;
  });

  return (
    <points ref={points}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.045}
        color={color}
        transparent
        opacity={0.55}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

export default function AmbientField() {
  const reduced = useReducedMotion() ?? false;
  const [accent] = useThemeColors(['--saga-accent']);
  return (
    <Canvas
      dpr={[1, 1.5]}
      frameloop={reduced ? 'demand' : 'always'}
      camera={{ position: [0, 0, 6], fov: 50 }}
      gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
    >
      <Drift reduced={reduced} color={accent!} />
    </Canvas>
  );
}
