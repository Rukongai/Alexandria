import { Suspense, useMemo } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { OrbitControls, Bounds, Html } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { BufferGeometry } from 'three';

/**
 * The actual react-three-fiber scene. This is the ONLY module that imports
 * `three` / `@react-three/fiber` / `@react-three/drei`, and it is reached
 * solely via React.lazy from ModelViewer3DModal — so the (large) three.js
 * bundle is emitted as a separate async chunk, loaded on first viewer open.
 */

function StlMesh({ url }: { url: string }) {
  const loaded = useLoader(STLLoader, url) as BufferGeometry;

  // Center the geometry at the origin and ensure normals exist (STL files
  // frequently ship without them, which renders the mesh flat/black).
  const geometry = useMemo(() => {
    loaded.center();
    loaded.computeVertexNormals();
    return loaded;
  }, [loaded]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#b8bcc4" roughness={0.55} metalness={0.1} />
    </mesh>
  );
}

interface ModelViewer3DSceneProps {
  url: string;
}

export default function ModelViewer3DScene({ url }: ModelViewer3DSceneProps) {
  return (
    <Canvas camera={{ position: [0, 0, 100], fov: 45 }} dpr={[1, 2]}>
      <color attach="background" args={['#15181f']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[8, 12, 8]} intensity={1.3} />
      <directionalLight position={[-8, -4, -6]} intensity={0.4} />
      <Suspense
        fallback={
          <Html center>
            <span style={{ color: '#c8ccd4', fontSize: 13 }}>Loading model…</span>
          </Html>
        }
      >
        {/* `key` forces a fresh fit when the STL url changes. */}
        <Bounds key={url} fit clip observe margin={1.2}>
          <StlMesh url={url} />
        </Bounds>
      </Suspense>
      <OrbitControls makeDefault enablePan enableZoom enableRotate />
    </Canvas>
  );
}
