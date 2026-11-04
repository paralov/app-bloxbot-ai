import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Group,
  LoadingManager,
  type Material,
  type Mesh,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const WIDTH = 148;
const HEIGHT = 124;
// White, so a model whose texture isn't in its file still shows its own color.
const BLANK_TEXTURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";

async function parseModel(
  data: Uint8Array,
  kind: "fbx" | "glb",
  onTexturesLoaded: () => void,
): Promise<Object3D> {
  // A model is only ever drawn from what's in its own file, so it can't make this page fetch anything.
  const manager = new LoadingManager();
  // An FBX's textures arrive after it's parsed, and nothing else redraws it with reduced motion.
  manager.onLoad = onTexturesLoaded;
  manager.setURLModifier((url) =>
    url.startsWith("blob:") || url.startsWith("data:") ? url : BLANK_TEXTURE,
  );
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  if (kind === "fbx") return new FBXLoader(manager).parse(buffer, "");
  const gltf = await new GLTFLoader(manager).parseAsync(buffer, "");
  return gltf.scene;
}

/** Draws the file that would really be uploaded, not a picture someone says is of it. */
export default function ModelPreview({
  data,
  kind,
  name,
  onFailed,
}: {
  data: Uint8Array;
  kind: "fbx" | "glb";
  name: string;
  onFailed: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const turnRef = useRef<(yaw: number, pitch: number) => void>(() => {});
  const draggingRef = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let frame = 0;
    let renderer: WebGLRenderer | null = null;
    let model: Object3D | null = null;
    let draw = () => {};
    (async () => {
      try {
        model = await parseModel(data, kind, () => draw());
        if (cancelled) return;
        renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(WIDTH, HEIGHT, false);

        const box = new Box3().setFromObject(model);
        const size = box.getSize(new Vector3()).length() || 1;
        model.position.sub(box.getCenter(new Vector3()));
        const pivot = new Group();
        pivot.add(model);
        pivot.rotation.set(0.45, 0.7, 0);

        const scene = new Scene();
        scene.add(pivot, new AmbientLight(0xffffff, 1.4));
        const sun = new DirectionalLight(0xffffff, 2.2);
        sun.position.set(-1, 2, 2);
        scene.add(sun);
        const camera = new PerspectiveCamera(35, WIDTH / HEIGHT, size / 100, size * 10);
        camera.position.set(0, 0, size * 1.7);

        draw = () => renderer?.render(scene, camera);
        turnRef.current = (yaw, pitch) => {
          pivot.rotation.y += yaw;
          pivot.rotation.x = Math.max(-1.2, Math.min(1.2, pivot.rotation.x + pitch));
          draw();
        };
        draw();
        setReady(true);

        if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
          const spin = () => {
            if (!draggingRef.current && !document.hidden) turnRef.current(0.004, 0);
            frame = requestAnimationFrame(spin);
          };
          frame = requestAnimationFrame(spin);
        }
      } catch {
        if (!cancelled) onFailed();
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      model?.traverse((item) => {
        const mesh = item as Mesh;
        mesh.geometry?.dispose();
        const materials = [mesh.material].flat() as (Material | undefined)[];
        for (const material of materials) material?.dispose();
      });
      renderer?.dispose();
    };
  }, [data, kind, onFailed]);

  return (
    <canvas
      ref={canvasRef}
      tabIndex={ready ? 0 : -1}
      role="img"
      aria-label={`Preview of ${name}. Drag or use the arrow keys to turn it.`}
      width={WIDTH}
      height={HEIGHT}
      className="block h-[124px] w-[148px] cursor-grab touch-none rounded-md bg-muted active:cursor-grabbing"
      onPointerDown={(event) => {
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) turnRef.current(event.movementX * 0.012, event.movementY * 0.012);
      }}
      onKeyDown={(event) => {
        const turns: Record<string, [number, number]> = {
          ArrowLeft: [-0.2, 0],
          ArrowRight: [0.2, 0],
          ArrowUp: [0, -0.2],
          ArrowDown: [0, 0.2],
        };
        const turn = turns[event.key];
        if (!turn) return;
        event.preventDefault();
        turnRef.current(...turn);
      }}
    />
  );
}
