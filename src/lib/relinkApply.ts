import type { RelinkResult } from "./ipc";
import { useImages } from "./store/images";
import { usePresets } from "./store/presets";
import { useProjects } from "./store/projects";
import { useReferenceRoles } from "./store/referenceRoles";
import { useScene3d } from "./store/scene3d";
import { useVideoStory } from "./store/videoStory";

/**
 * rr2: relink (画像パス修復) の結果をフロント側の全追従面へ適用する共有ヘルパー。
 *
 * relink の呼出は 3 経路ある (起動時 / 設定の「画像パスを修復する」/ 保存先変更後) が、
 * 従来は経路ごとに適用先がバラバラで、projects.json しか張り替わらなかった。
 * その結果 rename / saveToProject では追従していたプリセット・ロール・お気に入り・
 * 採否判定が、relink 経由だと旧パスを握ったままになる非対称があった。
 * ここに集約して、rename と同じ追従面 (projects / presets / favorites /
 * judgements / referenceRoles) を必ず全部通す。
 *
 * S3 (2026-08-05) で、揮発ストアのうち 2 面 (videoStory の動画キュー /
 * scene3d.storyboardOrigins の 3D 由来記録) も配り先に加えた。「プロジェクトへ移動」
 * すると参照側が旧パスを握ったままになる穴を閉じるため。
 *
 * 適用面ごとに try/catch で切る。1 面が失敗しても残りの面の張り替えは進める
 * (部分適用の方が「全部旧パスのまま」より実害が小さい)。
 *
 * prunedPaths (実体消失で削除されたパス) を適用するのは projects だけ。
 * favorites / judgements / referenceRoles はユーザーの判断記録であり、消すと
 * 復元できない。stale キーは path で引くだけの Map なので残っていても表示実害が無い。
 * 一方 projects の item は「画像が見つかりません」として**見える**壊れ方をするため
 * 従来どおり prune する。この非対称は意図的 (削除は安全側に倒す)。
 *
 * history.db は Rust 側 (images_relink_missing) が既に UPDATE / DELETE 済み。
 */
export function applyRelinkResult(result: RelinkResult): void {
  const pathMap = result.pathMap ?? {};
  const prunedPaths = result.prunedPaths ?? [];
  const remapCount = Object.keys(pathMap).length;

  if (remapCount > 0) {
    try {
      useProjects.getState().relinkItemPaths(pathMap);
    } catch (err) {
      console.warn("[relink] projects 追従に失敗:", err);
    }
    try {
      usePresets.getState().relinkImagePaths(pathMap);
    } catch (err) {
      console.warn("[relink] presets 追従に失敗:", err);
    }
    try {
      useImages.getState().relinkPaths(pathMap);
    } catch (err) {
      console.warn("[relink] favorites/judgements 追従に失敗:", err);
    }
    try {
      useReferenceRoles.getState().relinkPaths(pathMap);
    } catch (err) {
      console.warn("[relink] referenceRoles 追従に失敗:", err);
    }
    // S3: 揮発ストアのうち「引っ越しても持っていてほしい」2 つだけ追加する。
    // videoStory (動画キューの元画像) と scene3d.storyboardOrigins (3D の由来記録)。
    // storyboardRun / videoGen は足さない (前者は cuts Map が終端検知の条件に
    // 直結しており外から触ると走行中 run が終わらなくなる。後者は選び直す前提の揮発値)。
    try {
      useVideoStory.getState().relinkPaths(pathMap);
    } catch (err) {
      console.warn("[relink] videoStory 追従に失敗:", err);
    }
    try {
      useScene3d.getState().relinkStoryboardOrigins(pathMap);
    } catch (err) {
      console.warn("[relink] scene3d storyboardOrigins 追従に失敗:", err);
    }
  }

  // 実体が消えたパスは projects.json からも壊れた item を取り除く
  // (history.db からは Rust が削除済み)。「画像が見つかりません」を残さない。
  if (prunedPaths.length > 0) {
    try {
      useProjects.getState().pruneItemPaths(prunedPaths);
    } catch (err) {
      console.warn("[relink] projects prune に失敗:", err);
    }
  }

  if (result.dbUpdated > 0 || result.dbPruned > 0) {
    console.info(
      "[relink] history.db 再リンク",
      result.dbUpdated,
      "件 / 実体消失で削除",
      result.dbPruned,
      "件 (未解決",
      result.dbUnresolved,
      "件)",
    );
  }
}
