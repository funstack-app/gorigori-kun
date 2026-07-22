/**
 * 演出チャット(日本語演出→シーン自動構築)。
 *
 * ユーザーの演出指示(「人物1が歩いてきて、カメラは頭上から回り込みながら寄る」)を
 * Codex にカット割りJSONへ変換させ、シーンへ適用する。
 * motionGen.ts (AIモーション生成)と同じ「prompt生成 → codexTextQuery → 厳格validate → 適用」の型。
 */

import { codexTextQuery } from "../agents/codexQuery";
import { getSelectedShot, useScene3d } from "../store/scene3d";
import { surfaceHeightAt } from "./evaluateScene";
import { registerClipSpeed } from "./clipSpeed";
import {
  buildGeneratedClip,
  buildMotionPrompt,
  buildMotionRevisePrompt,
  loadGeneratedSpecs,
  saveGeneratedSpec,
  validateGeneratedSpec,
} from "./motionGen";
import { getBuiltinTemplate, loadCaptureRig, registerGeneratedClip } from "./motionLibrary";
import { CAMERA_PRESET_LABELS } from "./types";
import type { CameraPresetId, SceneProject, Vec3 } from "./types";

/* ---------------------------------- 型 ---------------------------------- */

export type DirectorCut = {
  preset: CameraPresetId;
  /** 追う相手のエンティティ名。null なら固定注視 */
  target: string | null;
  seconds: number;
  lensMm?: number;
  orbitDegrees?: number;
  startPos?: Vec3;
  endPos?: Vec3;
  /** preset "path" 用の通過点 */
  pathPoints?: Vec3[];
};

export type DirectorMotion = {
  entity: string;
  /** 標準ライブラリのモーション名(完全一致優先・部分一致許容) */
  clip?: string;
  /** clip が無い時の簡易モーション */
  type?: "walk" | "run";
  /** ライブラリに合う動きが無い時、AIモーション生成に渡す動きの説明(日本語) */
  generate?: string;
  /** 到着後につなげる動きの列(モーション連結。つなぎ目は自動クロスフェード) */
  then?: string[];
  /** 行き先[x,z]。高さは地形が決める(建物の上なら屋上に乗り、必要なら放物線で跳ぶ) */
  to?: [number, number];
  /** clipで指名したAI生成モーションへの修正指示(「もっと高く跳ぶ」等) */
  revise?: string;
  /** 視線: 頭が追う相手("カメラ" またはエンティティ名) */
  lookAt?: string;
  /** 並列レイヤー: 上半身(腕・手・首・頭)だけ重ねるクリップ名(「手を振る」等) */
  overlay?: string;
};

export type DirectorPlacement = {
  /** 置く種類(mannequin/building/box/wall/table/car/tree等) */
  kind: string;
  /** 置く場所[x,z]。高さは地形が決める(人物はビルの上なら屋上に立つ) */
  at: [number, number];
  /** building専用: 階数(1階=3m) */
  floors?: number;
};

export type DirectorMove = {
  entity: string;
  /** 立たせる場所[x,z]。高さは地形が決める */
  at: [number, number];
};

export type DirectorPlan = {
  /** シーンの下ごしらえ(足りない物を置く・人物を配置し直す) */
  place: DirectorPlacement[];
  move: DirectorMove[];
  cuts: DirectorCut[];
  motions: DirectorMotion[];
  note: string;
};

/* ---------------------------------- prompt ---------------------------------- */

const PRESET_MEANINGS: Record<CameraPresetId, string> = {
  fixed: "固定(動かない)",
  pushIn: "被写体へ寄る",
  pullOut: "被写体から引く",
  track: "横に並走",
  pan: "位置固定で視線を流す",
  orbit: "被写体の周りを回り込む(orbitDegrees必須)",
  crane: "上昇しながら見下ろす",
  handheld: "手持ち風の揺れ",
  spiralIn: "回り込みながら寄る",
  dollyZoom: "被写体サイズ固定で背景が伸びる(めまい)",
  flyover: "頭上を飛び越えて背後へ",
  riseReveal: "足元から上昇して全景",
  follow: "移動する被写体を追走(被写体が歩く/走る時)",
  whipPan: "一瞬で振る場面転換",
  shake: "衝撃の揺れ",
  snapZoom: "位置固定で急ズーム",
  path: "自由な軌道(pathPoints必須。複雑なカメラワーク用)",
};

export function buildDirectorPrompt(
  userText: string,
  project: SceneProject,
  clipNames: string[],
): { systemPrompt: string; prompt: string } {
  const presets = (Object.keys(PRESET_MEANINGS) as CameraPresetId[])
    .map((k) => `${k}=${PRESET_MEANINGS[k]}(${CAMERA_PRESET_LABELS[k]})`)
    .join(" / ");
  const systemPrompt = [
    "あなたは映像監督。ユーザーの日本語の演出指示を、3Dシーンのカット割りJSONに変換する。",
    "出力はJSONのみ。説明文・コードブロック記号は出さない。",
    "スキーマ:",
    `{"place":[{"kind":string,"at":[x,z],"floors"?:number}],"move":[{"entity":string,"at":[x,z]}],"cuts":[{"preset":string,"target":string|null,"seconds":number,"lensMm"?:number,"orbitDegrees"?:number,"startPos"?:[x,y,z],"endPos"?:[x,y,z],"pathPoints"?:[[x,y,z],...]}],"motions":[{"entity":string,"clip"?:string,"type"?:"walk"|"run","generate"?:string,"then"?:string[],"to"?:[x,z],"revise"?:string,"lookAt"?:string,"overlay"?:string}],"note":string}`,
    "placeで足りない物を置ける。kind語彙: mannequin=人物 / building=ビル(floorsで階数、1階=3m) / box=箱 / wall=壁 / table=机 / chair=椅子 / car=車 / tree=木 / streetlight=街灯 / pedestal=台座。名前は自動で「ビル1」「人物2」等になる。既にシーンにある物は置き直さず再利用する。",
    "moveで既存の人物・物を立たせ直せる。atは[x,z]のみ。高さは地形が決める(ビルの座標なら屋上に立つ)。",
    `preset語彙: ${presets}`,
    "座標は[x, 高さ, z]メートル。人物の身長は約1.7m、目線は約1.5m。",
    "targetは追う相手のエンティティ名。動く人物を撮るなら基本入れる。",
    "startPos/endPosは指定した方が演出意図が正確に出る(省略時は自動配置)。",
    "preset=pathの時だけpathPointsを2〜4点入れる(startPos/endPosも必須)。",
    "motionsのclipは提供リストの名前から選ぶ。歩く/走るだけならtype(walk/run)でもよい。",
    "リストにもtypeにも合わない動き(踊る・座る・手を振る等)は、generateに動きの説明(日本語・20字以内)を書く(新規生成される)。clip/type/generateはどれか1つ。",
    "移動する人物には then で「到着後につなげる動き」を順番の配列で書ける(例: [\"ジャンプ\",\"ガッツポーズ\"])。リストの名前を優先し、無ければ短い説明を書く(新規生成される)。つなぎ目は自動で滑らかに混ざる。",
    "移動する人物には to で行き先[x,z]を指定できる。高さは書かない(建物の上なら自動で屋上に乗り、放物線で跳ぶ)。",
    "既にあるAI生成モーションを直す指示(「さっきのジャンプをもっと高く」等)は、clipにその名前・reviseに修正内容を書く(改訂版が作られて割り当て直される)。",
    "lookAtで人物の頭が追い続ける相手を指定できる(\"カメラ\" またはエンティティ名)。カメラ目線・見つめ合いの演出用。",
    "overlayで上半身(腕・手・首・頭)だけ別の動きを重ねられる(リストの名前から。例: 走りながら手を振る=clip:走る+overlay:手を振る)。",
    "secondsは1〜20。cutsは1〜6個。noteは組んだ内容の一言(日本語・30字以内)。",
  ].join("\n");

  const entities = project.entities
    .map((e) => {
      const pos = `位置[${e.position.map((v) => v.toFixed(1)).join(",")}]`;
      // 上に乗れる物は天面の高さも教える(「屋上へ飛び移る」の空間推論に必要)
      const top = surfaceHeightAt(project, e.position[0], e.position[2]);
      const topInfo = top > 0.3 ? `, 天面高さ${top.toFixed(1)}m` : "";
      return `${e.label}(${e.kind}, ${pos}${topInfo})`;
    })
    .join(", ");
  const prompt = [
    `シーン内のエンティティ: ${entities || "(なし)"}`,
    `利用可能モーションクリップ: ${clipNames.join(", ") || "(なし)"}`,
    `演出指示: ${userText}`,
  ].join("\n");

  return { systemPrompt, prompt };
}

/* ---------------------------------- validate ---------------------------------- */

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

const clampVec = (v: Vec3): Vec3 => [
  Math.max(-50, Math.min(50, v[0])),
  Math.max(0, Math.min(30, v[1])),
  Math.max(-50, Math.min(50, v[2])),
];

const PLACEABLE_KINDS = new Set([
  "mannequin",
  "sphere",
  "box",
  "wall",
  "column",
  "stairs",
  "building",
  "table",
  "chair",
  "sofa",
  "bed",
  "shelf",
  "pedestal",
  "car",
  "tree",
  "streetlight",
]);

function asXZ(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const arr = v as number[];
  if (!arr.slice(0, 2).every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const x = arr[0];
  const z = arr.length >= 3 ? arr[2] : arr[1];
  return [Math.max(-50, Math.min(50, x)), Math.max(-50, Math.min(50, z))];
}

export function validateDirectorPlan(raw: unknown): DirectorPlan {
  if (raw == null || typeof raw !== "object") throw new Error("AIの出力がJSONになっていません");
  const o = raw as Record<string, unknown>;

  const place: DirectorPlacement[] = (Array.isArray(o.place) ? o.place : [])
    .slice(0, 8)
    .flatMap((x) => {
      const pl = x as Record<string, unknown>;
      const kind = String(pl.kind ?? "");
      const at = asXZ(pl.at);
      if (!PLACEABLE_KINDS.has(kind) || !at) return [];
      const out: DirectorPlacement = { kind, at };
      const fl = Number(pl.floors);
      if (Number.isFinite(fl)) out.floors = Math.max(1, Math.min(20, Math.round(fl)));
      return [out];
    });

  const move: DirectorMove[] = (Array.isArray(o.move) ? o.move : [])
    .slice(0, 8)
    .flatMap((x) => {
      const mv = x as Record<string, unknown>;
      const entity = typeof mv.entity === "string" ? mv.entity : "";
      const at = asXZ(mv.at);
      if (!entity || !at) return [];
      return [{ entity, at }];
    });
  const rawCuts = Array.isArray(o.cuts) ? o.cuts : [];
  if (rawCuts.length === 0) throw new Error("カットが1つも生成されませんでした");

  const cuts: DirectorCut[] = rawCuts.slice(0, 6).map((c, i) => {
    const cut = c as Record<string, unknown>;
    const preset = String(cut.preset ?? "");
    if (!(preset in PRESET_MEANINGS)) {
      throw new Error(`カット${i + 1}: 不明なカメラの動き "${preset}"`);
    }
    const seconds = Number(cut.seconds);
    const out: DirectorCut = {
      preset: preset as CameraPresetId,
      target: typeof cut.target === "string" && cut.target.length > 0 ? cut.target : null,
      seconds: Number.isFinite(seconds) ? Math.max(1, Math.min(20, seconds)) : 4,
    };
    const lens = Number(cut.lensMm);
    if (Number.isFinite(lens)) out.lensMm = Math.max(14, Math.min(200, lens));
    const deg = Number(cut.orbitDegrees);
    if (Number.isFinite(deg)) out.orbitDegrees = Math.max(-360, Math.min(360, deg));
    if (isVec3(cut.startPos)) out.startPos = clampVec(cut.startPos);
    if (isVec3(cut.endPos)) out.endPos = clampVec(cut.endPos);
    if (Array.isArray(cut.pathPoints)) {
      const pts = cut.pathPoints.filter(isVec3).map(clampVec).slice(0, 6);
      if (pts.length > 0) out.pathPoints = pts;
    }
    if (out.preset === "path" && (!out.pathPoints || !out.startPos || !out.endPos)) {
      throw new Error(`カット${i + 1}: 自由な道にはpathPoints/startPos/endPosが必要です`);
    }
    return out;
  });

  const motions: DirectorMotion[] = (Array.isArray(o.motions) ? o.motions : [])
    .slice(0, 8)
    .flatMap((m) => {
      const mo = m as Record<string, unknown>;
      const entity = typeof mo.entity === "string" ? mo.entity : "";
      if (!entity) return [];
      const out: DirectorMotion = { entity };
      if (typeof mo.clip === "string" && mo.clip.length > 0) out.clip = mo.clip;
      if (mo.type === "walk" || mo.type === "run") out.type = mo.type;
      if (typeof mo.generate === "string" && mo.generate.length > 0) {
        out.generate = mo.generate.slice(0, 60);
      }
      if (Array.isArray(mo.then)) {
        const steps = mo.then.filter((x): x is string => typeof x === "string" && x.length > 0);
        if (steps.length > 0) out.then = steps.slice(0, 4).map((x) => x.slice(0, 60));
      }
      if (typeof mo.revise === "string" && mo.revise.length > 0) {
        out.revise = mo.revise.slice(0, 100);
      }
      if (typeof mo.lookAt === "string" && mo.lookAt.length > 0) {
        out.lookAt = mo.lookAt.slice(0, 40);
      }
      if (typeof mo.overlay === "string" && mo.overlay.length > 0) {
        out.overlay = mo.overlay.slice(0, 60);
      }
      if (
        Array.isArray(mo.to) &&
        mo.to.length >= 2 &&
        mo.to.slice(0, 2).every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        // [x,z] または [x,y,z] を受け、水平位置だけ使う(高さは地形が決める)
        const arr = mo.to as number[];
        const tx = arr[0];
        const tz = arr.length >= 3 ? arr[2] : arr[1];
        out.to = [Math.max(-50, Math.min(50, tx)), Math.max(-50, Math.min(50, tz))];
      }
      return [out];
    });

  const note = typeof o.note === "string" ? o.note.slice(0, 60) : "";
  return { place, move, cuts, motions, note };
}

/**
 * AI生成モーションを会話で改訂する(元は残し、改訂版を新IDで登録して返す)。
 * ライブラリポップアップの「AIで直す」と、AI監督の revise の共通経路
 */
export async function reviseGeneratedMotion(
  clipId: string,
  instruction: string,
): Promise<{ id: string; name: string }> {
  const stored = loadGeneratedSpecs().find((sp) => sp.id === clipId);
  if (!stored) throw new Error("このモーションはAI生成ではないため、設計図を持っていません");
  // 元specの骨格規格を引き継ぐ(AIの応答がrigを落としても勝手に旧規格へ戻さない)
  const rig = stored.spec.rig ?? "rigify";
  const template = rig === "mixamo" ? await loadCaptureRig() : getBuiltinTemplate();
  if (!template) throw new Error("モーションライブラリの読み込み待ちです。少し待ってからもう一度");
  const { systemPrompt, prompt } = buildMotionRevisePrompt(stored.spec, instruction);
  const res = await codexTextQuery({ prompt, systemPrompt, expectJson: true, timeoutSecs: 180 });
  const parsed = res.parsedJson;
  const spec = validateGeneratedSpec(
    parsed && typeof parsed === "object" ? { ...(parsed as object), rig } : parsed,
  );
  const id = `gen-${Date.now()}`;
  const clip = buildGeneratedClip(template, spec, id);
  // plantsは引き継がない: AI改訂でタイミングが変わると古い接地スパンがIK破綻の原因になる
  const entry = registerGeneratedClip(id, spec.name, clip, undefined, rig);
  if (!entry) throw new Error("改訂モーションの登録に失敗しました");
  if (spec.moveSpeed != null) registerClipSpeed(id, spec.moveSpeed);
  saveGeneratedSpec(id, spec);
  useScene3d.getState().registerImportedMotions([entry]);
  return entry;
}

/* ---------------------------------- 適用 ---------------------------------- */

/** ラベルからエンティティを探す(完全一致 → 部分一致) */
function findEntityId(project: SceneProject, label: string): string | null {
  const exact = project.entities.find((e) => e.label === label);
  if (exact) return exact.id;
  const partial = project.entities.find(
    (e) => e.label.includes(label) || label.includes(e.label),
  );
  return partial?.id ?? null;
}

/**
 * 生成されたカット割りをシーンに適用する。
 * カット1は選択中カット(とそのカメラ)を書き換え、カット2以降はカメラ+カットを追加する(マルチカム)。
 * generate指定のモーションは AIモーション生成(キーフレーム設計)を追加で呼ぶため async。
 */
export async function applyDirectorPlan(
  plan: DirectorPlan,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const st = () => useScene3d.getState();
  const fps = st().project.fps;

  // シーンの下ごしらえ: 置く → 立たせ直す(高さは地形=磁石が決める)
  for (const pl of plan.place) {
    st().addEntity(pl.kind as Parameters<ReturnType<typeof useScene3d.getState>["addEntity"]>[0]);
    const id = st().selectedEntityId;
    if (!id) continue;
    if (pl.floors != null) st().setEntityParam(id, "floors", pl.floors);
    const y =
      pl.kind === "mannequin" ? surfaceHeightAt(st().project, pl.at[0], pl.at[1], id) : 0;
    st().moveEntity(id, [pl.at[0], y, pl.at[1]]);
  }
  for (const mv of plan.move) {
    const id = findEntityId(st().project, mv.entity);
    if (!id) continue;
    const y = surfaceHeightAt(st().project, mv.at[0], mv.at[1], id);
    st().moveEntity(id, [mv.at[0], y, mv.at[1]]);
  }

  // カメラ・カットを適用
  plan.cuts.forEach((cut, i) => {
    // カット2以降: 新しいカメラ+カットを作る(addCameraは新カットも足して選択する)
    if (i > 0) st().addCamera();
    const shot = getSelectedShot(st());
    st().setShotDurationFrames(shot.id, Math.round(cut.seconds * fps));
    st().setCameraPreset(cut.preset);
    st().setCameraTarget(cut.target ? findEntityId(st().project, cut.target) : null);
    if (cut.lensMm != null) st().setLens(cut.lensMm);
    if (cut.orbitDegrees != null && cut.preset === "orbit") st().setOrbitDegrees(cut.orbitDegrees);
    if (cut.preset === "path" && cut.startPos && cut.endPos && cut.pathPoints) {
      st().convertCameraToFreePath(cut.startPos, cut.endPos, cut.pathPoints);
    } else {
      if (cut.startPos) st().moveCameraEndpoint("start", cut.startPos);
      if (cut.endPos) st().moveCameraEndpoint("end", cut.endPos);
    }
  });

  // モーション割り当て
  const toGenerate: { entityId: string; desc: string; append?: boolean }[] = [];
  const toRevise: { entityId: string; clipId: string; instruction: string }[] = [];
  const findClip = (name: string) => {
    const clips = st().importedMotions;
    return (
      clips.find((c) => c.name === name) ??
      clips.find((c) => c.name.includes(name) || name.includes(c.name))
    );
  };
  for (const m of plan.motions) {
    const id = findEntityId(st().project, m.entity);
    if (!id) continue;
    let assigned = false;
    if (m.clip) {
      const hit = findClip(m.clip);
      // AI生成モーションへの修正指示: 改訂して割り当て直す(後段の生成フェーズで実行)
      if (hit && m.revise && hit.id.startsWith("gen-")) {
        toRevise.push({ entityId: id, clipId: hit.id, instruction: m.revise });
        assigned = true;
      } else if (hit) {
        st().setEntityMotionClip(id, hit.id);
        assigned = true;
      }
    }
    if (!assigned && m.type) {
      st().setEntityMotion(id, m.type);
      assigned = true;
    }
    if (!assigned && m.generate) {
      toGenerate.push({ entityId: id, desc: m.generate });
      assigned = true;
    }
    // 並列レイヤー: 上半身に重ねるクリップ(名前一致のみ。無ければ黙って捨てず生成対象にしない)
    if (m.overlay) {
      const hit = findClip(m.overlay);
      if (hit) st().setEntityOverlayClip(id, hit.id);
    }
    // 視線: 頭が追う相手("カメラ"はアクティブカメラ)
    if (m.lookAt) {
      const isCamera = /カメラ|camera/i.test(m.lookAt);
      const targetId = isCamera ? "__camera" : findEntityId(st().project, m.lookAt);
      if (targetId) st().setEntityLookAt(id, targetId);
    }
    // 行き先: 高さは地形(磁石)が決める。建物の上なら屋上に乗り、放物線で跳ぶ
    if (m.to) {
      const [tx, tz] = m.to;
      const y = surfaceHeightAt(st().project, tx, tz, id);
      st().moveMotionTarget(id, [tx, y, tz]);
    }
    // 到着後につなげる列(モーション連結)。名前で見つかれば即つなぐ、無ければ生成キューへ
    for (const name of m.then ?? []) {
      const hit = findClip(name);
      if (hit) st().appendEntityArrivalStep(id, hit.id);
      else toGenerate.push({ entityId: id, desc: name, append: true });
    }
  }

  // 既存AI生成モーションの改訂(会話でリグ調整。1件ずつ・遅い)
  for (let i = 0; i < toRevise.length; i++) {
    const r = toRevise[i];
    onProgress?.(`モーション改訂中 (${i + 1}/${toRevise.length})…`);
    const entry = await reviseGeneratedMotion(r.clipId, r.instruction);
    st().setEntityMotionClip(r.entityId, entry.id);
  }

  // 新規モーション生成(AIアニメーターへ委譲。1件ずつ・遅い)
  for (let i = 0; i < toGenerate.length; i++) {
    const g = toGenerate[i];
    onProgress?.(`モーション生成中: 「${g.desc}」(${i + 1}/${toGenerate.length})…`);
    // AI監督の新規生成もMixamo規格(Y Bot)に統一(2026-07-22移行)
    const template = await loadCaptureRig();
    const { systemPrompt, prompt } = buildMotionPrompt(g.desc, "mixamo");
    const res = await codexTextQuery({ prompt, systemPrompt, expectJson: true, timeoutSecs: 180 });
    const parsed = res.parsedJson;
    const spec = validateGeneratedSpec(
      parsed && typeof parsed === "object" ? { ...(parsed as object), rig: "mixamo" } : parsed,
    );
    const id = `gen-${Date.now()}-${i}`;
    const clip = buildGeneratedClip(template, spec, id);
    const entry = registerGeneratedClip(id, spec.name, clip, undefined, spec.rig);
    if (!entry) throw new Error(`モーション「${g.desc}」の登録に失敗しました`);
    if (spec.moveSpeed != null) registerClipSpeed(id, spec.moveSpeed);
    saveGeneratedSpec(id, spec);
    st().registerImportedMotions([entry]);
    if (g.append) st().appendEntityArrivalStep(g.entityId, id);
    else st().setEntityMotionClip(g.entityId, id);
  }
}
