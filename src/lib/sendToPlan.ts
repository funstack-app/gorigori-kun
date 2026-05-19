import {
  history,
  sessions as sessionsApi,
  type PromptHistoryRow,
  type TurnWithImages,
} from "./ipc";
import { usePlanChat } from "./store/planChat";
import { useToasts } from "./store/toasts";
import { useWorkspace } from "./store/workspace";

/**
 * 画像を「企画タブで再検討」アクション。
 *
 * STΛCK 指示 (2026-05-19): NRC さん要望対応。
 * お気に入りの生成画像をベースに、企画タブ (GPT-5.5 対話) で再度
 * プロンプトを練り直したい、というユースケース。
 *
 * 動作:
 * 1. 画像から元の生成プロンプトを逆引き (history.recent → getTurn)
 * 2. planChat の pendingImages に画像を追加
 * 3. activeTab を "plan" に切り替え
 * 4. trigger event を発火して PlanWorkspace の入力欄に「この画像をベースに
 *    プロンプトを練り直したい。元のプロンプト: ...」というプリセット文を
 *    自動で入れる (PlanWorkspace 側で受け取り)
 * 5. 成功トースト表示
 *
 * 元プロンプトが見つからない場合でも画像だけは送る (空のプロンプトで OK)。
 */
export const PLAN_REDISCUSS_EVENT = "gori:plan-rediscuss";

export type PlanRediscussDetail = {
  imagePath: string;
  originalPrompt: string | null;
};

export async function sendImageToPlanForRediscuss(imagePath: string): Promise<void> {
  // 1. プロンプト逆引き (ImageMetaPanel と同じ手法)
  let originalPrompt: string | null = null;
  try {
    const rows = await history.recent(120);
    for (const row of rows) {
      try {
        const turn = await sessionsApi.getTurn(row.id);
        if (turn.images.some((img) => img.path === imagePath)) {
          originalPrompt = (row as PromptHistoryRow).prompt;
          // turn にもプロンプトはあるが row 側が表示用としては妥当
          void (turn as TurnWithImages);
          break;
        }
      } catch {
        // 単発の getTurn 失敗は無視
      }
    }
  } catch (err) {
    console.warn("[sendImageToPlanForRediscuss] history 取得失敗:", err);
  }

  // 2. planChat に画像追加
  usePlanChat.getState().addPendingImages([imagePath]);

  // 3. タブ切替
  useWorkspace.getState().setActiveTab("plan");

  // 4. PlanWorkspace に「初期 draft 文字列」を渡すイベント発火
  // (PlanWorkspace 側で listen して、draft が空なら自動入力する)
  window.dispatchEvent(
    new CustomEvent<PlanRediscussDetail>(PLAN_REDISCUSS_EVENT, {
      detail: { imagePath, originalPrompt },
    }),
  );

  // 5. トースト
  useToasts.getState().push({
    kind: "success",
    text: originalPrompt
      ? "企画タブに画像と元プロンプトを送りました。再検討を始めてください。"
      : "企画タブに画像を送りました。再検討を始めてください。",
    ttlMs: 3500,
  });
}
