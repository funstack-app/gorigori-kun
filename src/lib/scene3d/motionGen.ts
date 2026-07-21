/**
 * AIモーション生成(Codex)
 *
 * テキスト(「手を振る」等)から、標準ライブラリと同じリグ(Rigify系 DEF- ボーン)向けの
 * キーフレーム仕様JSONを Codex に書かせ、three.js の AnimationClip に変換する。
 *
 * 設計判断:
 *   - 回転は「レストポーズからの差分」のオイラー角(度)。Codexは絶対姿勢を知らないため
 *   - 体全体の向き(ターン・スピン)は rootYaw(累積度)で自己申告し、腰ボーンに前置乗算で焼き込む
 *   - 指ボーンは使わせない(53本中20本の主要ボーンに制限。破綻の主因を減らす)
 *   - 仕様JSONを localStorage に保存し、起動時に再構築する(GLBは保存しない)
 */

import { AnimationClip, Euler, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from "three";
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
  /**
   * 前進を伴う動きの移動速度(m/s)。0=その場。AIが自己申告する
   * (スキップ=前進1.8、ダンス=0 のような判断はAI側が持っている)
   */
  moveSpeed?: number;
  keyframes: {
    /** 秒。昇順、先頭は0 */
    time: number;
    /** 腰の上下(m)。しゃがみ・ジャンプ用。省略=0 */
    hipsY?: number;
    /**
     * 体全体の向き(度)。開始向きからの累積角度(上から見て左回りが正)。
     * ターン・振り向き・スピン用。省略=0。一回転=360
     */
    rootYaw?: number;
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
    "- 振り向く・ターン・スピンは rootYaw(体全体の向き、度)を使う。開始向きからの累積角度で、上から見て左回りが正",
    "  例: 半回転ターン=最後のキーで rootYaw:180 / その場で一回転=最後のキーで rootYaw:360(中間キーにも90刻み程度で経過角度を書く)",
    "",
    "制約:",
    "- duration: 0.5〜10(秒) / keyframes: 3〜16個 / time は昇順で先頭は必ず 0",
    "- ボーンの角度は -150〜150 度 / rootYaw は -720〜720 度",
    "- loop:true(繰り返す動き)のときは最後のキーフレームを最初と同じ姿勢にする(rootYaw は 0 か ±360 で向きを元に戻す)",
    "- 動かさないボーンは書かない。動きの要所だけキーを打ち、中間は補間に任せる",
    '- moveSpeed: その動きが前進を伴うなら移動速度(m/s)を書く。その場の動きは 0。',
    "  目安: 歩く1.4 / スキップ1.8 / 走る2.6 / 全力疾走4.5。キャラは別途この速度で平行移動する",
    "",
    '出力形式: {"name":"短い日本語名","duration":2,"loop":true,"moveSpeed":0,"keyframes":[{"time":0,"hipsY":0,"rootYaw":0,"bones":{"DEF-upper_arm.R":[0,0,80]}},...]}',
  ].join("\n");
  return { systemPrompt, prompt: `依頼された動き: ${userText}` };
}

/**
 * 既存のAI生成モーションを会話で改訂するプロンプト。
 * 設計図(キーフレームJSON)を丸ごと渡し、指示箇所だけ変えた完全版を返させる
 */
export function buildMotionRevisePrompt(
  current: GeneratedMotionSpec,
  instruction: string,
): { systemPrompt: string; prompt: string } {
  const { systemPrompt } = buildMotionPrompt("");
  const prompt = [
    "以下は既存モーションの設計図。修正指示に沿って改訂した完全な設計図を、同じ形式のJSONだけで返す。",
    "指示に関係ない部分の姿勢・タイミング・雰囲気はできるだけ保つ(ゼロから作り直さない)。",
    "nameは内容が変わったことが分かる短い名前に更新してよい。",
    `現在の設計図: ${JSON.stringify(current)}`,
    `修正指示: ${instruction}`,
  ].join("\n");
  return { systemPrompt, prompt };
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
  const moveSpeed = r.moveSpeed != null ? clampNum(Number(r.moveSpeed) || 0, 0, 6) : undefined;
  if (!Array.isArray(r.keyframes) || r.keyframes.length < 2) {
    throw new Error("キーフレームが2つ未満です。言い方を変えてもう一度生成してください");
  }

  const allowed = new Set<string>(ALLOWED_BONES);
  let dropped = 0;
  let usedBones = 0;
  let usedYaw = false;
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
    const rootYaw = kf.rootYaw != null ? clampNum(Number(kf.rootYaw) || 0, -720, 720) : undefined;
    if (rootYaw != null && rootYaw !== 0) usedYaw = true;
    return {
      time: clampNum(Number(kf.time) || 0, 0, duration),
      hipsY: kf.hipsY != null ? clampNum(Number(kf.hipsY) || 0, -0.5, 0.5) : undefined,
      rootYaw,
      bones,
    };
  });
  // 体の回転(rootYaw)だけの動き(振り向き等)はボーンゼロでも成立する
  if (usedBones === 0 && !usedYaw) {
    throw new Error(
      dropped > 0
        ? "AIが使用禁止のボーンだけを動かそうとしました。もう一度生成してください"
        : "動かすボーンがありません。もう一度生成してください",
    );
  }
  keyframes.sort((a, b) => a.time - b.time);
  if (keyframes[0].time !== 0) keyframes[0] = { ...keyframes[0], time: 0 };

  return { name, duration, loop, moveSpeed, keyframes };
}

/**
 * 仕様JSON → AnimationClip。テンプレート(標準ライブラリのリグ)のレストポーズに
 * 差分回転を乗せてキーフレームトラックを組む。トラック名は既存GLBクリップと同形式
 */
/**
 * GLTFLoader は読み込み時にノード名から予約文字( [ ] . : / )を除去する
 * (PropertyBinding.sanitizeNodeName)。ALLOWED_BONES は GLB 生データの名前
 * (DEF-spine.001 等)なので、照合は両者を同じ規則で正規化して行う
 */
function sanitizeBoneName(name: string): string {
  return name.replace(/\s/g, "_").replace(/[[\].:/]/g, "");
}

/** 腰の親空間の上向き軸(hipsY の position トラックと同じ前提: 親空間Y=上) */
const UP_AXIS = new Vector3(0, 1, 0);

type YawKey = { time: number; yawDeg: number; deg: [number, number, number] };

/**
 * rootYaw 用のキー列を作る。隣接キー間の回転差が90度を超える区間は、
 * 90度以下になるまで中間キーを線形補間で挿入する(クォータニオンの最短経路対策。
 * これが無いと「0→360」は無回転、「0→270」は逆回り90度になる)
 */
function subdivideYawKeys(keyframes: GeneratedMotionSpec["keyframes"]): YawKey[] {
  const base: YawKey[] = keyframes.map((kf) => ({
    time: kf.time,
    yawDeg: kf.rootYaw ?? 0,
    deg: kf.bones["DEF-hips"] ?? [0, 0, 0],
  }));
  const out: YawKey[] = [];
  for (let i = 0; i < base.length; i++) {
    out.push(base[i]);
    const next = base[i + 1];
    if (!next) break;
    const span = next.yawDeg - base[i].yawDeg;
    const dt = next.time - base[i].time;
    if (Math.abs(span) <= 90 || dt <= 1e-4) continue;
    const n = Math.ceil(Math.abs(span) / 90);
    for (let s = 1; s < n; s++) {
      const t = s / n;
      out.push({
        time: base[i].time + dt * t,
        yawDeg: base[i].yawDeg + span * t,
        deg: [
          base[i].deg[0] + (next.deg[0] - base[i].deg[0]) * t,
          base[i].deg[1] + (next.deg[1] - base[i].deg[1]) * t,
          base[i].deg[2] + (next.deg[2] - base[i].deg[2]) * t,
        ],
      });
    }
  }
  return out;
}

export function buildGeneratedClip(
  template: Group,
  spec: GeneratedMotionSpec,
  id: string,
): AnimationClip {
  // レストポーズ収集: 仕様のボーン名(ドット付き)→ 実ノード(サニタイズ済み名)の対応表
  const wanted = new Map<string, string>(); // sanitize済み名 → 仕様上の名前
  for (const b of ALLOWED_BONES) wanted.set(sanitizeBoneName(b), b);
  const rest = new Map<
    string,
    { quat: Quaternion; pos: [number, number, number]; nodeName: string }
  >();
  let hipsNode: Object3D | null = null;
  template.traverse((node: Object3D) => {
    const specName = wanted.get(sanitizeBoneName(node.name));
    if (specName && !rest.has(specName)) {
      if (specName === "DEF-hips") hipsNode = node;
      rest.set(specName, {
        quat: node.quaternion.clone(),
        pos: [node.position.x, node.position.y, node.position.z],
        nodeName: node.name,
      });
    }
  });
  // rootYaw の回転軸: 腰の親空間での「世界の上」を実測する(リグの軸規約に依存しない)。
  // 固定 UP_AXIS(0,1,0) はこのリグの腰親空間では前後軸にあたり、ターンが「前転」として
  // 焼き込まれていた(2026-07-21 合成rootYawテストで実証: _work/capturetest)
  let yawAxis = UP_AXIS;
  // TSはtraverseクロージャ内の代入を追跡できずnever化するため明示キャスト
  const hn = hipsNode as Object3D | null;
  if (hn && hn.parent) {
    hn.parent.updateWorldMatrix(true, false);
    const inv = hn.parent.getWorldQuaternion(new Quaternion()).invert();
    yawAxis = new Vector3(0, 1, 0).applyQuaternion(inv).normalize();
  }
  if (rest.size === 0) {
    throw new Error("リグのボーンが見つかりません(標準ライブラリ未読み込み)");
  }

  // 使われている全ボーンについて、全キーフレーム時刻の値を作る(未指定はレスト=差分0)
  const usedBones = new Set<string>();
  for (const kf of spec.keyframes) {
    for (const b of Object.keys(kf.bones)) if (rest.has(b)) usedBones.add(b);
  }
  // 体全体の回転(rootYaw)は腰(=リグのルート)の回転として焼き込む。
  // hipsY の position トラックが親空間Yで上下する実績があるため、親空間Y=上と扱える
  const yawUsed = spec.keyframes.some((k) => (k.rootYaw ?? 0) !== 0);
  if (yawUsed && rest.has("DEF-hips")) usedBones.add("DEF-hips");
  const times = spec.keyframes.map((k) => k.time);

  const tracks: (QuaternionKeyframeTrack | VectorKeyframeTrack)[] = [];
  const euler = new Euler();
  const delta = new Quaternion();
  const boneQuat = (restQ: Quaternion, deg: [number, number, number], yawDeg: number): Quaternion => {
    euler.set(
      (deg[0] * Math.PI) / 180,
      (deg[1] * Math.PI) / 180,
      (deg[2] * Math.PI) / 180,
      "XYZ",
    );
    delta.setFromEuler(euler);
    const q = restQ.clone().multiply(delta);
    if (yawDeg !== 0) {
      // 親空間へ写した「世界の上」まわりに前置乗算 = 体ごと水平に回す
      const yawQ = new Quaternion().setFromAxisAngle(yawAxis, (yawDeg * Math.PI) / 180);
      q.premultiply(yawQ);
    }
    return q;
  };
  for (const bone of usedBones) {
    const restQuat = rest.get(bone);
    if (!restQuat) continue;

    if (bone === "DEF-hips" && yawUsed) {
      // クォータニオン補間は最短経路を通るため、キー間の回転が90度を超えると
      // 逆回り・回転抜けになる。90度以下の区間になるまで中間キーを自動挿入する
      const keys = subdivideYawKeys(spec.keyframes);
      const t: number[] = [];
      const values: number[] = [];
      for (const k of keys) {
        const q = boneQuat(restQuat.quat, k.deg, k.yawDeg);
        t.push(k.time);
        values.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new QuaternionKeyframeTrack(`${restQuat.nodeName}.quaternion`, t, values));
      continue;
    }

    const values: number[] = [];
    for (const kf of spec.keyframes) {
      const q = boneQuat(restQuat.quat, kf.bones[bone] ?? [0, 0, 0], 0);
      values.push(q.x, q.y, q.z, q.w);
    }
    // トラック名は実ノード名で組む(サニタイズ済み名でないとバインドされない)
    tracks.push(new QuaternionKeyframeTrack(`${restQuat.nodeName}.quaternion`, times, values));
  }

  // 腰の上下(hipsY)が指定されていれば position トラックを足す
  const hips = rest.get("DEF-hips");
  if (hips && spec.keyframes.some((k) => (k.hipsY ?? 0) !== 0)) {
    const values: number[] = [];
    for (const kf of spec.keyframes) {
      values.push(hips.pos[0], hips.pos[1] + (kf.hipsY ?? 0), hips.pos[2]);
    }
    tracks.push(new VectorKeyframeTrack(`${hips.nodeName}.position`, times, values));
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
