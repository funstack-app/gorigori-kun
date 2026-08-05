import { storyboard } from "./ipc";
import { useProjects } from "./store/projects";
import {
  clearLastRunPointer,
  readLastRunPointer,
} from "./store/storyboardLastRun";
import { useToasts } from "./store/toasts";

/**
 * 未回収の採用カットをプロジェクトへ復元する (rr2 / 2026-08-03)。
 *
 * 何を直すか: 採用 (adoptTake) はディスクの adoptions.json に書かれるが、
 * プロジェクトへの追加は run の completed イベントでしか行われない。生成中に
 * アプリが落ちる / 強制終了されると、ユーザーの採用判断はディスクに残るのに
 * UI 上は失われていた (readAdoptions は定義だけあって呼び出しゼロだった)。
 *
 * やらないこと: run 画面 (cuts / テイク / チャット / スケッチ) の復元。
 * backend の orchestrator は既に死んでおりイベントは二度と来ないため、
 * 画面を戻しても操作できる状態にはならない。守るのは「ユーザーの判断と成果物」
 * = 採用記録と画像であり、それはプロジェクトへの復元で達成できる。
 *
 * 冪等性: `useProjects.addItem` は同じ imagePath が既にあれば addedAt を
 * 更新するだけで新規追加しない (projects.ts の重複排除)。二重に走っても
 * item が増えない。
 *
 * @param pathMap 直前の relink で得た旧→新パスマップ。保存先変更等で画像が
 *                動いていた場合、採用時に焼いたパスを現在の場所へ張り替える。
 * @returns 復元した (= addItem が成功した) 件数。
 */
export async function restoreUnrecoveredAdoptions(
  pathMap?: Record<string, string>,
): Promise<number> {
  const pointer = await readLastRunPointer();
  if (!pointer) return 0;

  try {
    // projectId が無い run (箱を選ばずに生成した) は復元先が無い。
    // ポインタだけ消して静かに終わる。
    if (!pointer.projectId) {
      await clearLastRunPointer();
      return 0;
    }

    const adoptions = await storyboard.readAdoptions(pointer.runId);
    const entries = Object.entries(adoptions ?? {});
    let restored = 0;
    for (const [cutId, entry] of entries) {
      const raw = entry?.imagePath;
      // v1 形式で書かれた古い採用には imagePath が無い。画像を特定できないので
      // 復元しない (ディスクの adoptions.json は残るので手動復旧の余地はある)。
      if (!raw) continue;
      const imagePath = pathMap?.[raw] ?? raw;
      const item = useProjects.getState().addItem(pointer.projectId, {
        imagePath,
        note: `storyboard ${cutId} (復元)`,
      });
      if (item) restored += 1;
    }

    if (restored > 0) {
      useToasts.getState().push({
        kind: "success",
        text: `前回採用したカット ${restored} 件をプロジェクトへ復元しました`,
        ttlMs: 4000,
      });
    }
    return restored;
  } catch (err) {
    console.warn("[restoreAdoptions] 復元に失敗:", err);
    return 0;
  } finally {
    // 成否によらずポインタは消す。残すと毎回起動のたびに同じ復元を試みる
    // 無限リトライになる。adoptions.json 自体はディスクに残るので、
    // 手動復旧の余地は消えない。
    await clearLastRunPointer();
  }
}
