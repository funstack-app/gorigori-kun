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
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type ImportedMotion = {
  id: string;
  name: string;
  /** スキン付きキャラのテンプレート(SkeletonUtils.cloneで複製して使う) */
  template: Group;
  clip: AnimationClip;
  /** cm系(FBX)なら0.01。GLBは1 */
  scale: number;
};

const library = new Map<string, ImportedMotion>();
let seq = 1;
let builtinLoaded = false;

/** 標準ライブラリ(同梱CC0)の日本語名。無いものは英語名のまま */
const BUILTIN_JP: Record<string, string> = {
  Idle_Loop: "待機",
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

function baseName(fileName: string): string {
  return fileName.replace(/\.(fbx|glb|gltf)$/i, "");
}

/** File(複数可)を読み込んでライブラリに登録。UI登録用の {id,name}[] を返す */
export async function importMotionFiles(
  files: File[],
): Promise<{ ok: { id: string; name: string }[]; errors: string[] }> {
  const ok: { id: string; name: string }[] = [];
  const errors: string[] = [];
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

      // 1ファイルに複数クリップがあれば全部登録
      for (const clip of clips) {
        const id = `motion-${Date.now()}-${seq++}`;
        const name =
          clips.length > 1 ? `${baseName(file.name)} / ${clip.name}` : baseName(file.name);
        library.set(id, { id, name, template, clip, scale });
        ok.push({ id, name });
      }
    } catch (e) {
      errors.push(`${file.name}: 読み込み失敗 (${String(e).slice(0, 120)})`);
    }
  }
  return { ok, errors };
}
