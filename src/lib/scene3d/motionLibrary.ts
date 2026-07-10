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
