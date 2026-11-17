// 動きの再生。上に、動画・3D・再生の操作をひとまとまりにして置く（スクロールしても画面の上に留まるので、
// 下の数値を開いても、動画を見ながら止めたり進めたりできる）。その下に、開いたり閉じたりする項目
// （今の値・グラフ・筋肉の負荷・書き出しなど）を並べる。全部を 1 つの時計で動かす
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  GripHorizontal,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from "lucide-react";
import {
  MUSCLE_LABELS,
  PROFILES,
  eventOf,
  type MotionCycle,
  type MotionRecord,
  type MuscleKey,
  type PreparedMotion,
} from "../domain/motion";
import { MUSCLE_JOINT, PHASE_LABELS } from "../domain/motionLoad";
import {
  DEMAND_SOURCES,
  bikeDemand,
  ergDemand,
  type DemandSeries,
} from "../domain/motionDemand";
import { pxToNorm } from "../domain/motionConstraints";
import { sidePoints } from "../domain/landmarks";
import type { Pose3D } from "../domain/fusion3d";
import { motionEquipment, poseMapping } from "../domain/motionPose";
import type { UserProfile } from "../domain/types";
import { fmtNum } from "../domain/format";
import type { MotionVideoData } from "../state/motionMedia";
import { loadBodySkin, saveBodySkin, type BodySkin } from "../three/common";
import {
  ARM_LABELS,
  ARM_STYLES,
  detectArms,
  isArmStyle,
  type ArmStyle,
} from "../domain/motionArms";
import { indexAt, useClockValue, type Clock } from "./motionClock";
import { FrameVideo } from "./FrameVideo";
import { AngleChart } from "./AngleChart";
import { MotionVideoExport } from "./MotionVideoExport";
import type { OverlayInput } from "./FrameVideo";
import { Details, Fold, cx } from "./ui";

// 3D（three.js）は重いので、開いたときに読み込む
const MotionBody3D = lazy(() => import("../three/MotionBody3D"));
const OverlayCompare = lazy(() => import("../three/OverlayCompare"));

/** 下のタブ（中央の丸いボタンが上にはみ出す分を含む）の高さ。上に留めるまとまりが、これより下へ伸びないようにする */

const CHECK = "size-5 accent-[var(--color-ink)]";

export function MotionPlayer({
  rec,
  prep,
  cycles,
  poses,
  video,
  sex,
  clock,
  videoOverlay,
  autoplay = true,
  exportName,
  exportExtra,
  children,
  tail,
  lead,
  onArms,
}: {
  rec: MotionRecord;
  prep: PreparedMotion;
  cycles: MotionCycle[];
  poses: { t: number; pose: Pose3D }[];
  video: MotionVideoData | null;
  sex?: UserProfile["sex"];
  clock: Clock;
  /** 動画の上に重ねるもの（点の補正）。あるときは、動画だけを大きく出す */
  videoOverlay?: ReactNode;
  /** 開いたときに再生を始めるか（点を直している間は、計算し直すたびに動き出さないように止めておく） */
  autoplay?: boolean;
  /** あれば、この名前で動画に書き出せるようにする */
  exportName?: string;
  /** 「書き出す」の中に並べるボタン（CSV など） */
  exportExtra?: ReactNode;
  /** 再生の項目（今の値・グラフ・筋肉の負荷）のあとに並べる項目 */
  children?: ReactNode;
  /** 「書き出す」のあとに並べる項目 */
  tail?: ReactNode;
  /** 再生の操作のすぐ下に並べるもの（要点の帯・平均など。グラフや今の値より前） */
  lead?: ReactNode;
  /** 腕の構えを手で選んだとき（undefined は「自動」に戻す）。ないときは選べない */
  onArms?: (arms: ArmStyle | undefined) => void;
}) {
  const profile = PROFILES[rec.kind];
  const ts = useMemo(() => prep.frames.map((f) => f.t), [prep]);
  const [series, setSeries] = useState<string>(profile.defaultSeries);
  const [overlayOn, setOverlayOn] = useState(true);
  // 動画と 3D の並べ方: 重ねて境目をスライドする / 並べる
  const [layout, setLayout] = useState<"overlay" | "split">("overlay");
  const [muscles, setMuscles] = useState(false);
  const [skin, setSkin] = useState<BodySkin>(loadBodySkin);
  const mapping = useMemo(() => poseMapping(prep), [prep]);
  const overlay = useMemo(
    () => prep.frames.map((f) => ({ t: f.t, lm: f.lm })),
    [prep],
  );
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const def = profile.series.find((d) => d.key === series) ?? profile.series[0];
  const equipment = useMemo(
    () => motionEquipment(rec.kind, poses, prep.nearSide),
    [rec.kind, poses, prep.nearSide],
  );
  const sideOk = rec.analysis.sideView !== false;
  // スクワットの腕の構え（3D の手の形）。点から見分け、手で選んだらそれを使う
  const squat = rec.kind === "squat" || rec.kind === "squat_front";
  const autoArms = useMemo(
    () =>
      squat
        ? detectArms(poses, {
            frontal: rec.kind === "squat_front",
            loadKg: rec.body?.loadKg,
          })
        : undefined,
    [squat, poses, rec.kind, rec.body?.loadKg],
  );
  const arms = squat ? (rec.arms ?? autoArms) : undefined;
  // 重心の線（スクワット。画像に対する比）
  const com = useMemo(() => {
    // 真横から撮っていなければ、重心は出さない（横から見た位置として求めているため）
    if (!prep.load || !sideOk) return undefined;
    const size = {
      width: rec.video.width,
      height: rec.video.height,
      rollDeg: rec.video.rollDeg,
    };
    const sp = sidePoints(prep.nearSide);
    return prep.frames.map((fr, k) => ({
      c: pxToNorm(prep.load!.com[k], size),
      heel: fr.lm[sp.heel],
      toe: fr.lm[sp.foot],
    }));
  }, [prep, rec.video, sideOk]);
  // バーの軌道（スクワットで持つ重さを入れたとき。手首の点。その回の始めから今のコマまで）
  const bar = useMemo(() => {
    if (!prep.bar) return undefined;
    const sp = sidePoints(prep.nearSide);
    const from = prep.frames.map(
      (_, k) =>
        cycles.find((c) => k >= c.startIndex && k <= c.endIndex)?.startIndex ??
        -1,
    );
    return { points: prep.frames.map((fr) => fr.lm[sp.wrist]), from };
  }, [prep, cycles]);
  // 動画の書き出しで、コマ k に重ねるもの（画面の重ね表示と同じ）
  const three = useRef<HTMLCanvasElement | null>(null);
  // 上に留まる舞台の高さを --sticky-top に入れて、フォーカスした部品が舞台の下に隠れないようにする
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty("--sticky-top", `${Math.round(el.getBoundingClientRect().height) + 8}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--sticky-top");
    };
  }, []);
  const overlayAt = (k: number): OverlayInput | null =>
    overlayOn && !videoOverlay && prep.frames[k]
      ? {
          lm: prep.frames[k].lm,
          nearSide: prep.nearSide,
          com: com?.[k],
          trail:
            bar && bar.from[k] >= 0
              ? bar.points.slice(bar.from[k], k + 1)
              : undefined,
          bothSides: !!profile.frontal,
        }
      : null;
  // エルゴと自転車の筋肉の負荷（力の型と筋電図の型からの推定。真横から撮った記録だけ）
  const demand = useMemo<DemandSeries | null>(() => {
    if (!sideOk) return null;
    if (prep.kind === "erg")
      return ergDemand(prep.frames, prep.nearSide, prep.f, cycles);
    if (prep.kind === "bike")
      return bikeDemand(prep.frames, prep.nearSide, prep.crank);
    return null;
  }, [prep, cycles, sideOk]);
  // 3D の体の色の濃さ（「筋肉の色」を入れたとき）
  const levels = useMemo(() => {
    if (!muscles) return undefined;
    if (demand) return { ts, values: demand.values, far: demand.far };
    if (!prep.load || !sideOk) return undefined;
    const values: Partial<Record<MuscleKey, number[]>> = {};
    for (const [m, j] of Object.entries(MUSCLE_JOINT) as [
      MuscleKey,
      keyof typeof prep.load.demand,
    ][])
      values[m] = prep.load.demand[j];
    return { ts, values };
  }, [muscles, prep, ts, sideOk, demand]);
  // 1 回ごとの出来事（キャッチ・底・下死点）の時刻。再生の位置の目印と、前後へ移るボタンに使う
  const marks = useMemo(
    () =>
      cycles
        .map((c) => eventOf(c, profile.mainEvent)?.t)
        .filter((t): t is number => t !== undefined),
    [cycles, profile.mainEvent],
  );
  const markLabel =
    (cycles[0] && eventOf(cycles[0], profile.mainEvent)?.label) ?? "区切り";

  // 最初だけ、1 回目の出来事（底・キャッチなど）から、ゆっくり再生する
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const first = cycles[0] && eventOf(cycles[0], profile.mainEvent);
    if (first) clock.set(first.t);
    if (!reduced && autoplay) {
      clock.setSpeed(0.5);
      clock.play();
    }
  }, [clock, cycles, profile.mainEvent, reduced, autoplay]);

  // 並べたときの 3D の高さ（仕切りを上下に動かして変える）。3D は全画面にもできる
  const [stageH, setStageH] = useState(170);
  const [full, setFull] = useState(false);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const clampH = (h: number) => Math.min(720, Math.max(120, Math.round(h)));
  // 全画面の間は、後ろのページを動かさない。Esc で戻る
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);

  const canSwitch = !!video && !!mapping && !videoOverlay;
  const showOverlay = canSwitch && layout === "overlay";
  const portrait = !!video && video.height > video.width;
  const ratio = video ? `${video.width} / ${video.height}` : undefined;
  /** 動画の幅。高さが画面の高さの maxDvh % を超えないようにする（縦長の動画で、下の数値が見えなくならないように） */
  const fit = (maxDvh: number, share = "100%") =>
    video
      ? `min(${share}, calc(${maxDvh}dvh * ${video.width} / ${video.height}))`
      : share;
  const transport = (
    <Transport
      clock={clock}
      ts={ts}
      marks={marks}
      markLabel={markLabel}
      cycles={cycles}
      unit={profile.unitLabel}
    />
  );
  const frameVideo = video && (
    <FrameVideo
      images={video.images}
      width={video.width}
      height={video.height}
      clock={clock}
      overlay={overlayOn && !videoOverlay ? overlay : undefined}
      nearSide={prep.nearSide}
      com={com}
      bar={bar}
      bothSides={!!profile.frontal}
    />
  );
  // 3D。全画面のときは画面いっぱいに出し、その中にも再生の操作を置く
  const stage3d = (
    <div
      className={cx(
        "flex flex-col bg-ink",
        full
          ? "fixed inset-0 z-50 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
          : "absolute inset-0",
      )}
    >
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <Suspense fallback={<div className="size-full bg-ink" />}>
            <MotionBody3D
              poses={poses}
              clock={clock}
              sex={sex}
              facing={rec.analysis.facing}
              kind={rec.kind}
              muscles={muscles}
              levels={levels}
              equipment={equipment}
              nearSide={prep.nearSide}
              className="h-full"
              flat
              skin={skin}
              arms={arms}
              onCanvas={(c) => (three.current = c)}
              camera={
                profile.frontal
                  ? prep.view?.view === "front"
                    ? "front"
                    : "rear"
                  : undefined
              }
            />
          </Suspense>
        </div>
        <button
          type="button"
          aria-label={full ? "全画面をやめる" : "3D を全画面にする"}
          aria-pressed={full}
          onClick={() => setFull(!full)}
          className="absolute right-1.5 top-1.5 flex size-11 items-center justify-center rounded-full bg-black/35 text-paper hover:bg-black/50 focus-visible:outline-level"
        >
          {full ? (
            <Minimize2 aria-hidden className="size-5" />
          ) : (
            <Maximize2 aria-hidden className="size-5" />
          )}
        </button>
      </div>
      {full && transport}
    </div>
  );

  return (
    <div>
      {/* 動画・3D・再生の操作。スクロールしても画面の上に留まる。高さは、下のタブに隠れないところまで */}
      <div
        ref={stageRef}
        className={cx(
          "sticky top-[env(safe-area-inset-top)] -mx-4 flex flex-col bg-ink text-paper",
          "before:absolute before:inset-x-0 before:bottom-full before:h-[env(safe-area-inset-top)] before:bg-ink",
          full ? "z-50" : "z-10",
        )}
        style={{
          // 下の数値が見えるように、画面の 6 割ほどまで
          maxHeight: `min(60dvh, calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)))`,
        }}
      >
        {videoOverlay && video ? (
          // 点を直している間: 動画だけを大きく出す
          <div className="flex min-h-0 justify-center">
            <div
              className="relative"
              style={{ aspectRatio: ratio, width: fit(56) }}
            >
              {frameVideo}
              {videoOverlay}
            </div>
          </div>
        ) : showOverlay && video && mapping ? (
          <div className="flex min-h-0 justify-center">
            <div style={{ width: fit(38) }}>
              <Suspense
                fallback={
                  <div className="bg-ink" style={{ aspectRatio: ratio }} />
                }
              >
                <OverlayCompare
                  video={video}
                  poses={poses}
                  mapping={mapping}
                  clock={clock}
                  sex={sex}
                  kind={rec.kind}
                  muscles={muscles}
                  levels={levels}
                  nearSide={prep.nearSide}
                  rollDeg={rec.video.rollDeg}
                  onCanvas={(c) => (three.current = c)}
                  flat
                  arms={arms}
                />
              </Suspense>
            </div>
          </div>
        ) : video && portrait ? (
          // 縦長の動画は、動画と 3D を左右に並べる
          <div className="flex min-h-0">
            <div
              className="relative shrink-0"
              style={{ aspectRatio: ratio, width: fit(40, "50%") }}
            >
              {frameVideo}
            </div>
            <div className="relative min-w-0 flex-1">{stage3d}</div>
          </div>
        ) : (
          <>
            {video && (
              <div className="flex shrink-0 justify-center">
                <div
                  className="relative"
                  style={{ aspectRatio: ratio, width: fit(26) }}
                >
                  {frameVideo}
                </div>
              </div>
            )}
            {video && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="3D の高さ。上下の矢印キーで変えられます"
                aria-valuemin={120}
                aria-valuemax={720}
                aria-valuenow={stageH}
                tabIndex={0}
                className="relative flex h-4 shrink-0 cursor-row-resize touch-none items-center justify-center text-paper/45 before:absolute before:inset-x-0 before:-top-3.5 before:-bottom-3.5 hover:text-paper focus-visible:outline-level"
                onPointerDown={(e) => {
                  drag.current = { y: e.clientY, h: stageH };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (drag.current)
                    setStageH(clampH(drag.current.h + e.clientY - drag.current.y));
                }}
                onPointerUp={() => (drag.current = null)}
                onPointerCancel={() => (drag.current = null)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") setStageH((h) => clampH(h - 24));
                  else if (e.key === "ArrowDown") setStageH((h) => clampH(h + 24));
                  else return;
                  e.preventDefault();
                }}
              >
                <GripHorizontal aria-hidden className="size-4" />
              </div>
            )}
            <div
              className="relative min-h-[120px]"
              style={{ flex: video ? `0 1 ${stageH}px` : "0 1 46dvh" }}
            >
              {stage3d}
            </div>
          </>
        )}
        {transport}
      </div>

      {/* 見え方の切り替え */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 py-2">
        {canSwitch && (
          <div
            role="group"
            aria-label="動画と 3D の並べ方"
            className="inline-flex rounded-[10px] border border-line p-0.5"
          >
            {(
              [
                ["overlay", "重ねる"],
                ["split", "並べる"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={layout === v}
                onClick={() => setLayout(v)}
                className={cx(
                  "min-h-11 rounded-[8px] px-4 text-[15px]",
                  layout === v ? "bg-ink font-bold text-paper" : "text-ink-2",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {video && !videoOverlay && !showOverlay && (
          <label className="flex min-h-11 items-center gap-2 text-[15px]">
            <input
              type="checkbox"
              className={CHECK}
              checked={overlayOn}
              onChange={(e) => setOverlayOn(e.target.checked)}
            />
            骨格の線
          </label>
        )}
        <label className="flex min-h-11 items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            className={CHECK}
            checked={muscles}
            onChange={(e) => setMuscles(e.target.checked)}
          />
          筋肉の色
        </label>
        {squat && autoArms && onArms && (
          <label className="flex min-h-11 items-center gap-2 text-[15px]">
            手
            <select
              value={rec.arms ?? "auto"}
              onChange={(e) =>
                onArms(isArmStyle(e.target.value) ? e.target.value : undefined)
              }
              className="h-11 rounded-[8px] border border-line-strong bg-surface px-2 text-[15px]"
            >
              <option value="auto">自動（{ARM_LABELS[autoArms]}）</option>
              {ARM_STYLES.map((s) => (
                <option key={s} value={s}>
                  {ARM_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="border-b border-line">
        {lead}
        <Fold title="グラフ">
          <div
            role="group"
            aria-label="グラフにする値"
            className="-mx-4 -mt-1 flex gap-x-1 overflow-x-auto px-4 whitespace-nowrap"
          >
            {profile.series.map((d) => (
              <button
                key={d.key}
                type="button"
                aria-pressed={def.key === d.key}
                onClick={() => setSeries(d.key)}
                className={cx(
                  "min-h-11 border-b-2 px-2.5 text-[15px]",
                  def.key === d.key
                    ? "border-ink font-bold text-ink"
                    : "border-transparent text-ink-3",
                )}
              >
                {d.short}
              </button>
            ))}
          </div>
          <div className="mt-3">
            <AngleChart
              ts={ts}
              values={prep.series[def.key]}
              unit={def.unit}
              digits={def.digits}
              cycles={cycles.map((c) => ({
                start: c.start,
                end: c.end,
                mark: eventOf(c, profile.mainEvent)?.t,
              }))}
              clock={clock}
              label={def.label}
              band={
                def.band
                  ? {
                      lo: prep.series[def.band[0]],
                      hi: prep.series[def.band[1]],
                    }
                  : undefined
              }
              reference={profile.chartRefs?.[def.key]}
              flat
            />
          </div>
          <p className="mt-1 text-sm text-ink-3">
            グラフに触ると、その時刻へ移ります。色の帯は 1 {profile.unitLabel}
            ごとの区間です。
          </p>
        </Fold>
        <Fold title="今の値">
          <NowTable clock={clock} ts={ts} prep={prep} />
        </Fold>
        <Fold title="筋肉の負担の目安" hint="推定">
          <MuscleLoad
            clock={clock}
            ts={ts}
            prep={prep}
            demand={demand}
            sideOk={sideOk}
          />
          <label className="mt-3 flex min-h-11 items-center gap-2 text-[15px]">
            <input
              type="checkbox"
              className={CHECK}
              checked={skin === "muscle"}
              onChange={(e) => {
                const next = e.target.checked ? "muscle" : "plain";
                setSkin(next);
                saveBodySkin(next);
              }}
            />
            3D の体を解剖図にする
          </label>
        </Fold>
        {children}
        {(exportName || exportExtra) && (
          <Fold title="書き出す" keepMounted>
            <p className="text-sm text-ink-3">
              ファイルはこの端末の中で作ります。どこにも送りません。
            </p>
            <div className="mt-3 grid gap-2">
              {exportName && (
                <MotionVideoExport
                  rec={rec}
                  prep={prep}
                  cycles={cycles}
                  video={video}
                  clock={clock}
                  three={three}
                  series={def}
                  overlayAt={overlayAt}
                  fileStem={exportName}
                  overlay={
                    showOverlay ? { rollDeg: rec.video.rollDeg } : undefined
                  }
                />
              )}
              {exportExtra}
            </div>
          </Fold>
        )}
        {tail}
      </div>
    </div>
  );
}

const DARK_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-[10px] text-paper/85 hover:bg-white/10 active:bg-white/15 disabled:opacity-35 focus-visible:outline-level";

/** 再生の操作。動画・3D のすぐ下に、同じ濃い色の帯で付ける */
function Transport({
  clock,
  ts,
  marks,
  markLabel,
  cycles,
  unit,
}: {
  clock: Clock;
  ts: number[];
  /** 1 回ごとの出来事の時刻（再生の位置の上に目印を出し、前後へ移るのに使う） */
  marks: number[];
  markLabel: string;
  cycles: MotionCycle[];
  unit: string;
}) {
  const playing = useClockValue(clock, (c) => c.isPlaying());
  const t = useClockValue(clock, (c) => c.get());
  const speed = useClockValue(clock, (c) => c.getSpeed());
  const step = (dir: 1 | -1) => {
    clock.pause();
    const k = indexAt(ts, clock.get());
    const next = ts[Math.min(ts.length - 1, Math.max(0, k + dir))];
    // 同じコマにいるときは次のコマへ
    clock.set(
      next === clock.get() && ts[k + dir] !== undefined ? ts[k + dir] : next,
    );
  };
  const jump = (dir: 1 | -1) => {
    clock.pause();
    const now = clock.get();
    const to =
      dir > 0
        ? marks.find((m) => m > now + 1)
        : [...marks].reverse().find((m) => m < now - 1);
    if (to !== undefined) clock.set(to);
  };
  const span = Math.max(1, clock.end - clock.start);
  const rep = cycles.findIndex((c) => t >= c.start && t <= c.end);
  return (
    <div className="shrink-0 px-2 pb-1.5 pt-0.5">
      <div className="flex items-center gap-2.5">
        <div className="relative min-w-0 flex-1">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-2 top-0.5 h-1.5"
          >
            {marks.map((m) => (
              <span
                key={m}
                className="absolute top-0 h-1.5 w-px bg-paper/60"
                style={{ left: `${((m - clock.start) / span) * 100}%` }}
              />
            ))}
          </div>
          <input
            type="range"
            min={clock.start}
            max={clock.end}
            step={1}
            value={t}
            aria-label="再生する位置"
            onChange={(e) => {
              clock.pause();
              clock.set(Number(e.target.value));
            }}
            className="block h-9 w-full accent-[var(--color-level)] focus-visible:outline-level"
          />
        </div>
        <p className="min-w-[4.25rem] shrink-0 text-right text-[13px] leading-[1.25] text-paper/80 num">
          <span className="block text-paper">
            {fmtNum((t - clock.start) / 1000, 2)} 秒
          </span>
          {rep >= 0 && (
            <span className="block">
              {rep + 1}/{cycles.length} {unit}
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`前の${markLabel}へ`}
          disabled={!marks.length}
          onClick={() => jump(-1)}
          className={DARK_BUTTON}
        >
          <SkipBack aria-hidden className="size-5" />
        </button>
        <button
          type="button"
          aria-label="1 コマ戻る"
          onClick={() => step(-1)}
          className={DARK_BUTTON}
        >
          <StepBack aria-hidden className="size-5" />
        </button>
        <button
          type="button"
          aria-label={playing ? "止める" : "再生"}
          onClick={() => (playing ? clock.pause() : clock.play())}
          className="flex h-11 w-16 shrink-0 items-center justify-center rounded-[10px] bg-level text-ink hover:brightness-95 active:brightness-90 focus-visible:outline-paper"
        >
          {playing ? (
            <Pause aria-hidden className="size-6" />
          ) : (
            <Play aria-hidden className="size-6" />
          )}
        </button>
        <button
          type="button"
          aria-label="1 コマ進む"
          onClick={() => step(1)}
          className={DARK_BUTTON}
        >
          <StepForward aria-hidden className="size-5" />
        </button>
        <button
          type="button"
          aria-label={`次の${markLabel}へ`}
          disabled={!marks.length}
          onClick={() => jump(1)}
          className={DARK_BUTTON}
        >
          <SkipForward aria-hidden className="size-5" />
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-[13px] text-paper/80">
          速さ
          <select
            value={speed}
            onChange={(e) => clock.setSpeed(Number(e.target.value))}
            className="h-11 rounded-[8px] border border-paper/30 bg-ink px-1.5 text-[15px] text-paper num focus-visible:outline-level"
          >
            {[2, 1, 0.5, 0.25, 0.1].map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

/** 今の時刻の値 */
function NowTable({
  clock,
  ts,
  prep,
}: {
  clock: Clock;
  ts: number[];
  prep: PreparedMotion;
}) {
  const t = useClockValue(clock, (c) => c.get());
  const k = indexAt(ts, t);
  const defs = PROFILES[prep.kind].series;
  const measured = defs.filter((d) => !d.estimate);
  const estimated = defs.filter((d) => d.estimate);
  const cell = (d: (typeof defs)[number]) => (
    <div key={d.key}>
      <dt className="text-sm text-ink-2">{d.short}</dt>
      <dd className="text-[20px] font-bold leading-tight whitespace-nowrap num">
        {fmtNum(prep.series[d.key][k], d.digits)}
        <span className="ml-0.5 text-sm font-normal text-ink-2">
          {d.unit}
        </span>
      </dd>
    </div>
  );
  return (
    <>
      <p className="mb-2 text-sm text-ink-2">見かけの角度・位置（横から見た点から）</p>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3">{measured.map(cell)}</dl>
      {estimated.length > 0 && (
        <>
          <p className="mt-4 mb-2 border-t border-line pt-3 text-sm text-ink-2">
            推定（体の重さの割合と、床からの力の仮定の上に立つ値）
          </p>
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3">{estimated.map(cell)}</dl>
          <p className="mt-2 text-sm text-ink-3">重心はかかと 0%・つま先 100%。負担比は股関節 ÷ 膝で、仮定によって大きく変わります（グラフの帯）。</p>
        </>
      )}
    </>
  );
}

/** スクワットの行の名前（関節の働き。筋肉の名前は補足） */
const SQUAT_ROW_NAMES: Partial<Record<MuscleKey, string>> = {
  quads: "膝を伸ばす（太ももの前）",
  glutes: "股関節を伸ばす（お尻・太ももの裏）",
  erectors: "上体を支える（背中）",
  calves: "足首（ふくらはぎ）",
};

/** 筋肉の名前の短い形（「太ももの前（大腿四頭筋）」→「太ももの前」） */
const shortMuscle = (m: MuscleKey) => MUSCLE_LABELS[m].split("（")[0];

/** 今の時刻の、筋肉ごとの負荷（推定）。棒と、0〜100 の数字 */
function MuscleLoad({
  clock,
  ts,
  prep,
  demand,
  sideOk,
}: {
  clock: Clock;
  ts: number[];
  prep: PreparedMotion;
  /** エルゴ・自転車の推定（なければ、スクワットの推定か、出せない） */
  demand: DemandSeries | null;
  sideOk: boolean;
}) {
  const t = useClockValue(clock, (c) => c.get());
  const k = indexAt(ts, t);
  const profile = PROFILES[prep.kind];
  const load = sideOk ? prep.load : undefined;
  const rows: { m: MuscleKey; name: string; v: number; phase?: string }[] = demand
    ? (Object.keys(demand.values) as MuscleKey[])
        .filter((m) => demand.values[m]?.some((v) => v > 0))
        .map((m) => ({ m, name: shortMuscle(m), v: demand.values[m]?.[k] ?? 0 }))
    : load
      ? (
          Object.entries(MUSCLE_JOINT) as [
            MuscleKey,
            keyof typeof load.demand,
          ][]
        )
          // 太ももの裏はお尻と同じ関節（股関節）から求めるので、1 行にまとめる
          .filter(([m]) => m !== "hamstrings")
          .map(([m, j]) => ({
            m,
            name: SQUAT_ROW_NAMES[m] ?? shortMuscle(m),
            v: load.demand[j][k] ?? 0,
            phase: PHASE_LABELS[load.phase[j][k] ?? "isometric"],
          }))
      : [];
  if (!rows.length)
    return (
      <p className="text-[15px] text-ink-2">
        {!sideOk
          ? "真横から撮れていないので、負荷は出せません。"
          : profile.frontal
            ? "正面や後ろからの動画では、負荷は出せません。"
            : "この記録では、負荷は出せません。"}
        「筋肉の色」を入れると、{profile.label}
        でよく使う筋肉の場所に色がつきます（
        {profile.muscles.map(shortMuscle).join("・")}）。
      </p>
    );
  return (
    <>
      <p className="mb-2 text-sm text-ink-2">
        数字は、それぞれの行の「この記録の中でいちばん高いとき」を 100 とした今の割合です。いつ高くなるかを見るためのもので、行どうしは比べられません。
      </p>
      <ul className="space-y-2.5">
        {rows.map(({ m, name, v, phase }) => (
          <li
            key={m}
            className="grid grid-cols-[minmax(0,9.5rem)_1fr_2.25rem] items-center gap-3 text-[15px]"
          >
            <span>
              {name}
              {phase && (
                <span className="block text-xs text-ink-3">{phase}</span>
              )}
            </span>
            <span className="h-1.5 bg-sunken" aria-hidden>
              <span
                className="block h-full bg-load"
                style={{ width: `${Math.round(v * 100)}%` }}
              />
            </span>
            <span className="text-right font-bold num">
              {Math.round(v * 100)}
            </span>
          </li>
        ))}
      </ul>
      {demand ? (
        <>
          <p className="mt-3 text-sm text-ink-3">
            色と棒は推定です。
            {prep.kind === "erg" ? "ハンドルを引く力" : "ペダルを踏む力"}
            は測れないので、論文にある標準的な力の出方を当てはめ、関節の位置から求めました。数字は、推定した負担がこの記録でいちばん大きかったところを
            100 とした割合で、漕ぐ強さは反映しません。筋肉どうし・ほかの記録とは比べられません。
            {prep.kind === "erg"
              ? "お尻・背中の上部・腕の前は、働く時期の筋電図の裏づけがなく、力の型だけから出しています。"
              : "お尻・ふくらはぎは、働く時期の筋電図の裏づけがなく、力の型だけから出しています。"}
            {demand.far && "棒はカメラ側の脚です。"}
          </p>
          <Details summary="もとにした論文">
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {DEMAND_SOURCES[prep.kind === "erg" ? "erg" : "bike"].map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </Details>
        </>
      ) : (
        <p className="mt-3 text-sm text-ink-3">
          色と棒は推定です。体の部分ごとの重さの割合（Winter
          2009）と床からの力の仮定から関節の負担を求め、曲がりの大きさと合わせた目安の式にしました（式の係数は目安で、文献の値ではありません）。数字は、この記録の中でいちばん高いところを
          100 とした割合で、重さを足しても同じ濃さになります。行どうし・ほかの記録とは比べられません。筋電図で測った値ではありません。
        </p>
      )}
    </>
  );
}
