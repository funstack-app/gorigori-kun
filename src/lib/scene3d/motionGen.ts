/**
 * AIモーション生成(Codex)
 *
 * テキスト(「手を振る」等)から、標準ライブラリと同じリグ(Rigify系 DEF- ボーン)向けの
 * キーフレーム仕様JSONを Codex に書かせ、three.js の AnimationClip に変換する。
 *
 * 設計判断:
 *   - 回転は「レストポーズからの差分」のオイラー角(度)。Codexは絶対姿勢を知らないため
 *   - 指ボーンは使わせない(53本中20本の主要ボーンに制限。破綻の主因を減らす)
 *   - 仕様JSONを localStorage に保存し、起動時に再構築する(GLBは保存しない)
 */

import { AnimationClip, Euler, Quaternion, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import type { Group, Object3D } from "three";

/** Codexに使わせる主要ボーン(標準ライブラリGLBの実名) */
export const ALLOWED_BONES = [
  "DEF-hips",
  "DEF-spine.001",
  "DEF-spine.002",
  "DEF-spine.003",
  "DEF-neck",
  "DEF-head",
  "DEF-shoulder.L",
  "DEF-upper_arm.L",
  "DEF-forearm.L",
  "DEF-hand.L",
  "DEF-shoulder.R",
  "DEF-upper_arm.R",
  "DEF-forearm.R",
  "DEF-hand.R",
  "DEF-thigh.L",
  "DEF-shin.L",
  "DEF-foot.L",
  "DEF-thigh.R",
  "DEF-shin.R",
  "DEF-foot.R",
] as const;

export type GeneratedMotionSpec = {
  /** 表示名(日本語可) */
  name: string;
  /** 尺(秒) 0.5〜10 */
  duration: number;
  /** true=繰り返す動き / false=一回きり(最終姿勢で静止) */
  loop: boolean;
  keyframes: {
    /** 秒。昇順、先頭は0 */
    time: number;
    /** 腰の上下(m)。しゃがみ・ジャンプ用。省略=0 */
    hipsY?: number;
    /** ボーン名 → レストポーズからの差分オイラー角 [x,y,z] (度) */
    bones: Record<string, [number, number, number]>;
  }[];
};

/** Codexへ渡すプロンプトを組み立てる */
export function buildMotionPrompt(userText: string): { systemPrompt: string; prompt: string } {
  const systemPrompt = [
    "あなたは3Dヒューマノイドの手付けアニメーター。依頼された動きのキーフレームをJSONだけで返す。説明文・コードブロック記号は書かない。",
    "",
    `使えるボーン(これ以外は禁止): ${ALLOWED_BONES.join(", ")}`,
    "",
    "回転はレストポーズ(直立・腕は体側)からの差分。各ボーンのローカル軸のオイラー角 [x,y,z] を度で書く。",
    "目安:",
    "- 背骨(spine)・首・頭: X正=前に倒す、Z=左右に傾げる、Y=左右に捻る",
    "- 腕(upper_arm): Z負=左腕を体側から横へ上げる / 右腕はZ正。X正=腕を前へ振り上げる",
    "- 肘(forearm): X正=肘を曲げる",
    "- 脚(thigh): X負=腿を前へ上げる / 膝(shin): X正=膝を曲げる",
    "- しゃがむ・跳ぶは hipsY(腰の上下、メートル。-0.4〜0.3)も併用する",
    "",
    "制約:",
    "- duration: 0.5〜10(秒) / keyframes: 3〜16個 / time は昇順で先頭は必ず 0",
    "- 角度は -150〜150 度",
    "- loop:true(繰り返す動き)のときは最後のキーフレームを最初と同じ姿勢にする",
    "- 動かさないボーンは書かない。動きの要所だけキーを打ち、中間は補間に任せる",
    "",
    '出力形式: {"name":"短い日本語名","duration":2,"loop":true,"keyframes":[{"time":0,"hipsY":0,"bones":{"DEF-upper_arm.R":[0,0,80]}},...]}',
  ].join("\n");
  return { systemPrompt, prompt: `依頼された動き: ${userText}` };
}

const clampNum = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Codexの出力を検証して正規化する。壊れていれば日本語メッセージで throw。
 * 未知ボーンは黙って捨てず数を数え、有効ボーンが1つも無ければエラーにする
 */
export function validateGeneratedSpec(raw: unknown): GeneratedMotionSpec {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("AIの応答がモーションJSONの形をしていません");
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 24) : "AIモーション";
  const duration = clampNum(Number(r.duration) || 2, 0.5, 10);
  const loop = Boolean(r.loop);
  if (!Array.isArray(r.keyframes) || r.keyframes.length < 2) {
    throw new Error("キーフレームが2つ未満です。言い方を変えてもう一度生成してください");
  }

  const allowed = new Set<string>(ALLOWED_BONES);
  let dropped = 0;
  let usedBones = 0;
  const keyframes = (r.keyframes as unknown[]).slice(0, 16).map((k) => {
    const kf = (k ?? {}) as Record<string, unknown>;
    const bonesIn = (kf.bones ?? {}) as Record<string, unknown>;
    const bones: Record<string, [number, number, number]> = {};
    for (const [bone, val] of Object.entries(bonesIn)) {
      if (!allowed.has(bone)) {
        dropped++;
        continue;
      }
      if (!Array.isArray(val) || val.length !== 3) continue;
      bones[bone] = [
        clampNum(Number(val[0]) || 0, -150, 150),
        clampNum(Number(val[1]) || 0, -150, 150),
        clampNum(Number(val[2]) || 0, -150, 150),
      ];
      usedBones++;
    }
    return {
      time: clampNum(Number(kf.time) || 0, 0, duration),
      hipsY: kf.hipsY != null ? clampNum(Number(kf.hipsY) || 0, -0.5, 0.5) : undefined,
      bones,
    };
  });
  if (usedBones === 0) {
    throw new Error(
      dropped > 0
        ? "AIが使用禁止のボーンだけを動かそうとしました。もう一度生成してください"
        : "動かすボーンがありません。もう一度生成してください",
    );
  }
  keyframes.sort((a, b) => a.time - b.time);
  if (keyframes[0].time !== 0) keyframes[0] = { ...keyframes[0], time: 0 };

  return { name, duration, loop, keyframes };
}

/**
 * 仕様JSON → AnimationClip。テンプレート(標準ライブラリのリグ)のレストポーズに
 * 差分回転を乗せてキーフレームトラックを組む。トラック名は既存GLBクリップと同形式
 */
export function buildGeneratedClip(
  template: Group,
  spec: GeneratedMotionSpec,
  id: string,
): AnimationClip {
  // レストポーズ収集(テンプレートのボーン初期姿勢)
  const rest = new Map<string, { quat: Quaternion; pos: [number, number, number] }>();
  template.traverse((node: Object3D) => {
    if ((ALLOWED_BONES as readonly string[]).includes(node.name)) {
      rest.set(node.name, {
        quat: node.quaternion.clone(),
        pos: [node.position.x, node.position.y, node.position.z],
      });
    }
  });
  if (rest.size === 0) {
    throw new Error("リグのボーンが見つかりません(標準ライブラリ未読み込み)");
  }

  // 使われている全ボーンについて、全キーフレーム時刻の値を作る(未指定はレスト=差分0)
  const usedBones = new Set<string>();
  for (const kf of spec.keyframes) {
    for (const b of Object.keys(kf.bones)) if (rest.has(b)) usedBones.add(b);
  }
  const times = spec.keyframes.map((k) => k.time);

  const tracks: (QuaternionKeyframeTrack | VectorKeyframeTrack)[] = [];
  const euler = new Euler();
  const delta = new Quaternion();
  for (const bone of usedBones) {
    const restQuat = rest.get(bone);
    if (!restQuat) continue;
    const values: number[] = [];
    for (const kf of spec.keyframes) {
      const deg = kf.bones[bone] ?? [0, 0, 0];
      euler.set(
        (deg[0] * Math.PI) / 180,
        (deg[1] * Math.PI) / 180,
        (deg[2] * Math.PI) / 180,
        "XYZ",
      );
      delta.setFromEuler(euler);
      const q = restQuat.quat.clone().multiply(delta);
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  }

  // 腰の上下(hipsY)が指定されていれば position トラックを足す
  const hips = rest.get("DEF-hips");
  if (hips && spec.keyframes.some((k) => (k.hipsY ?? 0) !== 0)) {
    const values: number[] = [];
    for (const kf of spec.keyframes) {
      values.push(hips.pos[0], hips.pos[1] + (kf.hipsY ?? 0), hips.pos[2]);
    }
    tracks.push(new VectorKeyframeTrack("DEF-hips.position", times, values));
  }

  // _Loop 命名規約: 到着後アクションで使われたとき「繰り返す/最終姿勢で止まる」の判定に使う
  const clip = new AnimationClip(`Gen_${id}${spec.loop ? "_Loop" : ""}`, spec.duration, tracks);
  return clip;
}

/* ---------------- 保存(localStorage、仕様JSONのみ) ---------------- */

const GEN_KEY = "scene3d.generatedMotions.v1";

export type StoredGeneratedMotion = { id: string; spec: GeneratedMotionSpec };

export function loadGeneratedSpecs(): StoredGeneratedMotion[] {
  try {
    const raw = localStorage.getItem(GEN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is StoredGeneratedMotion =>
        x != null && typeof x === "object" && typeof (x as StoredGeneratedMotion).id === "string",
    );
  } catch {
    return [];
  }
}

export function saveGeneratedSpec(id: string, spec: GeneratedMotionSpec): void {
  const list = loadGeneratedSpecs().filter((x) => x.id !== id);
  list.push({ id, spec });
  localStorage.setItem(GEN_KEY, JSON.stringify(list));
}

export function removeGeneratedSpec(id: string): void {
  localStorage.setItem(GEN_KEY, JSON.stringify(loadGeneratedSpecs().filter((x) => x.id !== id)));
}
