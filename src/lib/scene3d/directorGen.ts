/**
 * 演出チャット(日本語演出→シーン自動構築)。
 *
 * ユーザーの演出指示(「人物1が歩いてきて、カメラは頭上から回り込みながら寄る」)を
 * Codex にカット割りJSONへ変換させ、シーンへ適用する。
 * motionGen.ts (AIモーション生成)と同じ「prompt生成 → codexTextQuery → 厳格validate → 適用」の型。
 */

import { codexTextQuery } from "../agents/codexQuery";
import { getSelectedShot, useScene3d } from "../store/scene3d";
import { registerClipSpeed } from "./clipSpeed";
import {
  buildGeneratedClip,
  buildMotionPrompt,
  saveGeneratedSpec,
  validateGeneratedSpec,
} from "./motionGen";
import { getBuiltinTemplate, registerGeneratedClip } from "./motionLibrary";
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
};

export type DirectorPlan = {
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
    `{"cuts":[{"preset":string,"target":string|null,"seconds":number,"lensMm"?:number,"orbitDegrees"?:number,"startPos"?:[x,y,z],"endPos"?:[x,y,z],"pathPoints"?:[[x,y,z],...]}],"motions":[{"entity":string,"clip"?:string,"type"?:"walk"|"run"}],"note":string}`,
    `preset語彙: ${presets}`,
    "座標は[x, 高さ, z]メートル。人物の身長は約1.7m、目線は約1.5m。",
    "targetは追う相手のエンティティ名。動く人物を撮るなら基本入れる。",
    "startPos/endPosは指定した方が演出意図が正確に出る(省略時は自動配置)。",
    "preset=pathの時だけpathPointsを2〜4点入れる(startPos/endPosも必須)。",
    "motionsのclipは提供リストの名前から選ぶ。歩く/走るだけならtype(walk/run)でもよい。",
    "リストにもtypeにも合わない動き(踊る・座る・手を振る等)は、generateに動きの説明(日本語・20字以内)を書く(新規生成される)。clip/type/generateはどれか1つ。",
    "secondsは1〜20。cutsは1〜6個。noteは組んだ内容の一言(日本語・30字以内)。",
  ].join("\n");

  const entities = project.entities
    .map((e) => `${e.label}(位置[${e.position.map((v) => v.toFixed(1)).join(",")}])`)
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

export function validateDirectorPlan(raw: unknown): DirectorPlan {
  if (raw == null || typeof raw !== "object") throw new Error("AIの出力がJSONになっていません");
  const o = raw as Record<string, unknown>;
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
      return [out];
    });

  const note = typeof o.note === "string" ? o.note.slice(0, 60) : "";
  return { cuts, motions, note };
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

  // カメラ・カットを先に適用(速い。ユーザーにすぐ結果が見える)
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
  const toGenerate: { entityId: string; desc: string }[] = [];
  for (const m of plan.motions) {
    const id = findEntityId(st().project, m.entity);
    if (!id) continue;
    if (m.clip) {
      const clips = st().importedMotions;
      const hit =
        clips.find((c) => c.name === m.clip) ??
        clips.find((c) => c.name.includes(m.clip ?? "") || (m.clip ?? "").includes(c.name));
      if (hit) {
        st().setEntityMotionClip(id, hit.id);
        continue;
      }
    }
    if (m.type) {
      st().setEntityMotion(id, m.type);
      continue;
    }
    if (m.generate) toGenerate.push({ entityId: id, desc: m.generate });
  }

  // 新規モーション生成(AIアニメーターへ委譲。1件ずつ・遅い)
  for (let i = 0; i < toGenerate.length; i++) {
    const g = toGenerate[i];
    onProgress?.(`モーション生成中: 「${g.desc}」(${i + 1}/${toGenerate.length})…`);
    const template = getBuiltinTemplate();
    if (!template) throw new Error("モーションライブラリの読み込み待ちです。少し待ってからもう一度");
    const { systemPrompt, prompt } = buildMotionPrompt(g.desc);
    const res = await codexTextQuery({ prompt, systemPrompt, expectJson: true, timeoutSecs: 180 });
    const spec = validateGeneratedSpec(res.parsedJson);
    const id = `gen-${Date.now()}-${i}`;
    const clip = buildGeneratedClip(template, spec, id);
    const entry = registerGeneratedClip(id, spec.name, clip);
    if (!entry) throw new Error(`モーション「${g.desc}」の登録に失敗しました`);
    if (spec.moveSpeed != null) registerClipSpeed(id, spec.moveSpeed);
    saveGeneratedSpec(id, spec);
    st().registerImportedMotions([entry]);
    st().setEntityMotionClip(g.entityId, id);
  }
}
