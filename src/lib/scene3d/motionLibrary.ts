/**
 * インポート済みモーションライブラリ(Mixamo等のFBX/GLB)
 *
 * Three.jsのオブジェクトはZustandに入れない(シリアライズ不能・巨大)ため、
 * 実体はこのモジュールが持つ。UI向けの一覧(id/name)だけをストアに登録する。
 *
 * 対応形式: Mixamoの FBX Binary(With Skin 推奨) / GLB。
 * ファイルはユーザーが自分のAdobeアカウントでダウンロードして持ち込む(BYO)。
 * アプリには同梱しない(Mixamo規約: 生ファイルの再配布NG / 制作物への利用はOK)
 */

import type { AnimationClip, Group } from "three";
import { Box3, Vector3 } from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import {
  convertClipInPlace,
  estimateScaleCorrection,
  findRootPositionTrack,
  isHeightOutOfRange,
  isNonInPlace,
  isUnmeasurableHeight,
  measureRootMotion,
} from "./importGuards";

export type ImportedMotion = {
  id: string;
  name: string;
  /** スキン付きキャラのテンプレート(SkeletonUtils.cloneで複製して使う) */
  template: Group;
  clip: AnimationClip;
  /** cm系(FBX)なら0.01。GLBは1 */
  scale: number;
  /** 足の接地スパン(動画取り込みクリップのみ)。再生側の足IKが消費 */
  plants?: import("./motionGen").PlantSpan[];
};

const library = new Map<string, ImportedMotion>();
let seq = 1;
let builtinLoaded = false;
/** 標準ライブラリのリグ本体。AI生成モーション(gen-*)はこの骨格に後付けする */
let builtinTemplate: Group | null = null;
/** Mixamo規格の取り込みマネキン(Y Bot)。rig:"mixamo" のクリップはこの骨格で再生する */
let captureTemplate: Group | null = null;

/** 標準ライブラリ(同梱CC0)の日本語名。無いものは英語名のまま */
const BUILTIN_JP: Record<string, string> = {
  Idle_Loop: "待機",
  Idle_Torch_Loop: "たいまつ待機",
  Idle_Talking_Loop: "会話(立ち)",
  Walk_Loop: "歩く",
  Walk_Formal_Loop: "歩く(フォーマル)",
  Jog_Fwd_Loop: "ジョグ",
  Sprint_Loop: "全力疾走",
  Crouch_Idle_Loop: "しゃがみ待機",
  Crouch_Fwd_Loop: "しゃがみ歩き",
  Sitting_Enter: "座る(動作)",
  Sitting_Idle_Loop: "座り待機",
  Sitting_Talking_Loop: "座って会話",
  Sitting_Exit: "立ち上がる",
  Dance_Loop: "ダンス",
  Jump_Start: "ジャンプ(踏切)",
  Jump_Loop: "ジャンプ(滞空)",
  Jump_Land: "着地",
  Push_Loop: "押す",
  PickUp_Table: "物を取る(机)",
  Interact: "操作する",
  Fixing_Kneeling: "しゃがんで作業",
  Driving_Loop: "運転",
  Swim_Idle_Loop: "立ち泳ぎ",
  Swim_Fwd_Loop: "泳ぐ",
  Punch_Jab: "パンチ(ジャブ)",
  Punch_Cross: "パンチ(クロス)",
  Hit_Chest: "被弾(胸)",
  Hit_Head: "被弾(頭)",
  Roll: "前転",
  Death01: "倒れる",
};

/** 同梱の標準モーションライブラリ(CC0)を読み込む。初回のみ実体を構築 */
export async function loadBuiltinMotions(): Promise<{ id: string; name: string }[]> {
  if (builtinLoaded) {
    return [...library.values()]
      .filter((m) => m.id.startsWith("builtin-"))
      .map((m) => ({ id: m.id, name: m.name }));
  }
  const res = await fetch("/motions/AnimationLibrary_Godot_Standard.glb");
  if (!res.ok) throw new Error(`標準ライブラリの読み込みに失敗 (${res.status})`);
  const buf = await res.arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(buf, "");
  const template = gltf.scene;
  builtinTemplate = template;
  const out: { id: string; name: string }[] = [];
  for (const clip of gltf.animations ?? []) {
    if (clip.name === "A_TPose") continue; // ポーズ基準は除外
    const id = `builtin-${clip.name}`;
    const name = BUILTIN_JP[clip.name] ?? clip.name.replace(/_/g, " ");
    library.set(id, { id, name, template, clip, scale: 1 });
    out.push({ id, name });
  }
  builtinLoaded = true;
  return out;
}

export function getImportedMotion(id: string): ImportedMotion | undefined {
  return library.get(id);
}

/** 標準ライブラリのリグ(loadBuiltinMotions 後に有効)。AI生成モーションの土台 */
export function getBuiltinTemplate(): Group | null {
  return builtinTemplate;
}

/** Mixamo規格の取り込みマネキン(Y Bot)を読み込む。初回のみfetch */
export async function loadCaptureRig(): Promise<Group> {
  if (captureTemplate) return captureTemplate;
  const res = await fetch("/models/ybot.glb");
  if (!res.ok) throw new Error(`取り込みマネキンの読み込みに失敗 (${res.status})`);
  const gltf = await new GLTFLoader().parseAsync(await res.arrayBuffer(), "");
  captureTemplate = gltf.scene;
  return captureTemplate;
}

/** Y Botテンプレート(loadCaptureRig 後に有効) */
export function getCaptureTemplate(): Group | null {
  return captureTemplate;
}

/** AI生成クリップを規格に合ったリグの上に登録する。テンプレート未読み込みなら null */
export function registerGeneratedClip(
  id: string,
  name: string,
  clip: AnimationClip,
  plants?: import("./motionGen").PlantSpan[],
  rig?: import("./motionGen").RigId,
): { id: string; name: string } | null {
  const template = rig === "mixamo" ? captureTemplate : builtinTemplate;
  if (!template) return null;
  library.set(id, { id, name, template, clip, scale: 1, plants });
  return { id, name };
}

/** モーションをライブラリから外す(AI生成の削除用) */
export function unregisterMotion(id: string): void {
  library.delete(id);
}

function baseName(fileName: string): string {
  return fileName.replace(/\.(fbx|glb|gltf)$/i, "");
}

/**
 * File(複数可)を読み込んでライブラリに登録。UI登録用の {id,name}[] を返す。
 *
 * 取り込み時に2つの地雷を検出して自動補正する(importGuards.ts):
 *   - 移動成分入りクリップ → その場再生に変換(パス移動との二重移動を防ぐ)
 *   - 単位系違いのモデル → 10の冪でスケール補正(巨人/豆粒を防ぐ)
 * 補正した内容は warnings で平易な日本語として返し、呼び出し側が表示する。
 */
export async function importMotionFiles(
  files: File[],
): Promise<{ ok: { id: string; name: string }[]; errors: string[]; warnings: string[] }> {
  const ok: { id: string; name: string }[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const fbxLoader = new FBXLoader();
  const gltfLoader = new GLTFLoader();

  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      let template: Group;
      let clips: AnimationClip[];
      let scale = 1;

      if (lower.endsWith(".fbx")) {
        const obj = fbxLoader.parse(buf, "");
        template = obj;
        clips = obj.animations ?? [];
        scale = 0.01; // Mixamo FBX は cm 系
      } else if (lower.endsWith(".glb") || lower.endsWith(".gltf")) {
        const gltf = await gltfLoader.parseAsync(buf, "");
        template = gltf.scene;
        clips = gltf.animations ?? [];
      } else {
        errors.push(`${file.name}: 未対応の形式(FBX/GLBのみ)`);
        continue;
      }

      if (clips.length === 0) {
        errors.push(`${file.name}: アニメーションが入っていません`);
        continue;
      }

      // サイズ検証: 単位系違い(cm系GLB等)を10の冪で補正する。
      // 骨のみのファイルは高さが測れないので検証ごとスキップ(警告も出さない)
      const size = new Box3().setFromObject(template).getSize(new Vector3());
      const heightMeters = size.y * scale;
      if (!isUnmeasurableHeight(heightMeters)) {
        const correction = estimateScaleCorrection(heightMeters);
        if (correction) {
          scale *= correction.factor;
          warnings.push(
            `${file.name}: サイズが規格外だったため自動調整しました(${correction.label})`,
          );
        } else if (isHeightOutOfRange(heightMeters)) {
          warnings.push(
            `${file.name}: サイズが規格外(推定${heightMeters.toFixed(1)}m)のため正しく表示されない可能性があります`,
          );
        }
      }

      // 1ファイルに複数クリップがあれば全部登録
      for (const clip of clips) {
        const id = `motion-${Date.now()}-${seq++}`;
        const name =
          clips.length > 1 ? `${baseName(file.name)} / ${clip.name}` : baseName(file.name);

        // ルートモーション検証: 移動しながらのクリップはその場再生に変換する。
        // エンジンは移動をパス側で与えるため、変換しないと二重移動でワープする
        let registered = clip;
        const trackIndex = findRootPositionTrack(clip);
        if (trackIndex !== null && isNonInPlace(measureRootMotion(clip, trackIndex, scale))) {
          registered = convertClipInPlace(clip, trackIndex);
          warnings.push(
            `${name}: 移動しながらのアニメーションだったため、その場再生に変換して取り込みました(移動はパスで付けられます)`,
          );
        }

        library.set(id, { id, name, template, clip: registered, scale });
        ok.push({ id, name });
      }
    } catch (e) {
      errors.push(`${file.name}: 読み込み失敗 (${String(e).slice(0, 120)})`);
    }
  }
  return { ok, errors, warnings };
}
