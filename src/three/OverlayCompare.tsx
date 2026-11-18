// 元の動画と、推定した 3D の体を、撮ったカメラと同じ向き・同じ大きさで重ね、境目をスライドして見比べる（遅延読み込み）。
// 3D の体は、腰・膝・足首・手首が推定した点に重なるように置く（標準の体なので、肩や頭の位置は少しずれる）
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";
import type * as THREE from "three";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Pose3D } from "../domain/fusion3d";
import type { UserProfile } from "../domain/types";
import type { MotionKind } from "../domain/motion";
import type { PoseMapping } from "../domain/motionPose";
import type { MotionVideoData } from "../state/motionMedia";
import { FrameVideo } from "../components/FrameVideo";
import { indexAt, type Clock } from "../components/motionClock";
import { mannequinKindOf } from "./mannequin";
import { BodyLights, LoadBoundary, hasWebGL } from "./common";
import { MovingBody, type MuscleLevels } from "./MotionBody3D";
import type { ArmStyle } from "../domain/motionArms";
import { cx } from "../components/ui";

/** 3D のカメラを、動画を撮ったカメラと同じ向き・同じ写る範囲にする（コマごとに、動かない点のずらしも戻す） */
function AlignedCamera({
  mapping,
  clock,
  width,
  height,
}: {
  mapping: PoseMapping;
  clock: Clock;
  width: number;
  height: number;
}) {
  const cam = useRef<THREE.OrthographicCamera>(null);
  useFrame(() => {
    const c = cam.current;
    if (!c) return;
    const k = Math.max(0, indexAt(mapping.ts, clock.get()));
    const sh = mapping.shifts[k] ?? { x: 0, y: 0 };
    const H = mapping.H;
    c.left = (0 - mapping.originX - sh.x) / H;
    c.right = (width - mapping.originX - sh.x) / H;
    c.top = (mapping.floorY + sh.y) / H;
    c.bottom = (mapping.floorY + sh.y - height) / H;
    // 顔が画面の右向き: 体の右側（-X）から見る（画面の右が +Z）。左向きは +X から。正面は +Z から、後ろは -Z から
    const D = 10;
    const f = mapping.free;
    if (f) {
      // 斜めなど: 動画を撮ったカメラと同じ向きから見る（3D の anchor が画面の (originX, floorY) に写る）
      c.position.set(f.anchor.x - f.forward.x * D, f.anchor.y - f.forward.y * D, f.anchor.z - f.forward.z * D);
      c.up.set(-f.down.x, -f.down.y, -f.down.z);
      c.lookAt(f.anchor.x, f.anchor.y, f.anchor.z);
      c.updateProjectionMatrix();
      return;
    }
    if (mapping.camera === "right") c.position.set(-D, 0, 0);
    else if (mapping.camera === "left") c.position.set(D, 0, 0);
    else if (mapping.camera === "front") c.position.set(0, 0, D);
    else c.position.set(0, 0, -D);
    c.up.set(0, 1, 0);
    c.lookAt(0, 0, 0);
    c.updateProjectionMatrix();
  });
  return (
    <OrthographicCamera ref={cam} makeDefault manual near={0.1} far={40} />
  );
}

export default function OverlayCompare({
  video,
  poses,
  mapping,
  clock,
  sex,
  kind,
  muscles,
  levels,
  nearSide,
  rollDeg,
  onCanvas,
  flat,
  arms,
}: {
  video: MotionVideoData;
  poses: { t: number; pose: Pose3D }[];
  mapping: PoseMapping;
  clock: Clock;
  sex?: UserProfile["sex"];
  kind: MotionKind;
  muscles: boolean;
  levels?: MuscleLevels;
  nearSide: "left" | "right";
  /** 端末の傾きを戻した角度（3D は傾きを戻した座標なので、動画に合わせて逆に回す） */
  rollDeg?: number;
  onCanvas?: (c: HTMLCanvasElement) => void;
  /** 角を丸めない（再生の操作にぴったり付けて置くとき） */
  flat?: boolean;
  /** スクワットの腕の構え（手の形） */
  arms?: ArmStyle;
}) {
  const box = useRef<HTMLDivElement>(null);
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 境目の位置（0〜1。左が元の動画）。最初は右から中央へ動かして、見比べられることを見せる
  const [split, setSplit] = useState(reduced ? 0.5 : 0.92);
  const [dragging, setDragging] = useState(false);
  const webgl = useMemo(hasWebGL, []);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / 900);
      const e = 1 - (1 - u) ** 3;
      setSplit(0.92 + (0.5 - 0.92) * e);
      if (u < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  const setFrom = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setSplit(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };
  const pct = `${(split * 100).toFixed(2)}%`;

  return (
    <div
      ref={box}
      className={cx(
        "relative select-none overflow-hidden bg-ink",
        !flat && "rounded-[var(--radius-panel)]",
      )}
      style={{
        aspectRatio: `${video.width} / ${video.height}`,
        touchAction: "pan-y",
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        setFrom(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging) setFrom(e.clientX);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
    >
      {/* 元の動画（全面） */}
      <FrameVideo
        images={video.images}
        width={video.width}
        height={video.height}
        clock={clock}
        nearSide={nearSide}
      />
      {/* 境目より右: 動画を少し暗くして、3D の体を重ねる */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ clipPath: `inset(0 0 0 ${pct})` }}
      >
        <div className="absolute inset-0 bg-[rgb(6_20_26/0.45)]" />
        {webgl && !failed && (
          <div
            className="absolute inset-0"
            style={{
              transform: rollDeg ? `rotate(${-rollDeg}deg)` : undefined,
            }}
          >
            <Canvas
              dpr={[1, 2]}
              gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true }}
              onCreated={({ gl }) => onCanvas?.(gl.domElement)}
              aria-hidden
            >
              <AlignedCamera
                mapping={mapping}
                clock={clock}
                width={video.width}
                height={video.height}
              />
              <BodyLights />
              {/* 後ろからの縁の光（動画の上で体の輪郭が見えるように） */}
              <directionalLight
                position={[
                  0,
                  2,
                  mapping.camera === "front"
                    ? -3
                    : mapping.camera === "rear"
                      ? 3
                      : 0,
                ]}
                intensity={0.9}
              />
              <LoadBoundary onError={() => setFailed(true)}>
                <Suspense fallback={null}>
                  <MovingBody
                    kind={mannequinKindOf(sex)}
                    sport={kind}
                    poses={poses}
                    clock={clock}
                    muscles={muscles}
                    levels={levels}
                    nearSide={nearSide}
                    arms={arms}
                    floorY={0}
                    bare
                  />
                </Suspense>
              </LoadBoundary>
            </Canvas>
          </div>
        )}
      </div>

      {/* 見出し */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between px-2.5 py-1.5 text-[13px] font-bold text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.7)]">
        <span className={cx("transition-opacity", split < 0.14 && "opacity-0")}>
          動画
        </span>
        <span className={cx("transition-opacity", split > 0.86 && "opacity-0")}>
          3D
        </span>
      </div>

      {/* 境目の線とつまみ */}
      <div
        className="pointer-events-none absolute inset-y-0"
        style={{ left: pct }}
      >
        <div className="absolute inset-y-0 -left-px w-0.5 bg-white" />
      </div>
      <button
        type="button"
        role="slider"
        aria-label="元の動画と推定した 3D の境目"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(split * 100)}
        aria-valuetext={`左から ${Math.round(split * 100)}% が元の動画`}
        className={cx(
          "absolute top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-ink shadow-[0_1px_4px_rgb(0_0_0/0.45)] transition-transform focus-visible:outline-2 focus-visible:outline-white",
          dragging ? "scale-110" : "scale-100",
        )}
        style={{ left: pct }}
        onKeyDown={(e) => {
          const d =
            e.key === "ArrowLeft" ? -0.05 : e.key === "ArrowRight" ? 0.05 : 0;
          if (e.key === "Home") setSplit(0);
          else if (e.key === "End") setSplit(1);
          else if (d) setSplit((v) => Math.min(1, Math.max(0, v + d)));
          else return;
          e.preventDefault();
        }}
      >
        <ChevronLeft aria-hidden className="-mr-1 size-4" strokeWidth={2.5} />
        <ChevronRight aria-hidden className="-ml-1 size-4" strokeWidth={2.5} />
      </button>
    </div>
  );
}
