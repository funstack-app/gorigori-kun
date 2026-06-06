import { type ReactNode } from "react";
import { VideoSceneBuilder } from "./scene/VideoSceneBuilder";
import { VideoConstructedPromptPanel } from "./VideoConstructedPromptPanel";
import { useVideoGen } from "../lib/store/videoGen";
import { useImagePreview } from "../lib/store/imagePreview";

type VideoGenerationWorkspaceProps = {
  /** 右側は既存タイムラインを流用。動画サムネ再生は part2 で拡張する */
  timeline?: ReactNode;
};

/**
 * i2v 元画像インジケータ (B3/B5 連携)。
 *
 * ストーリーモードの確定カットから動画タブへ送られた画像 (sourceImagePath) を
 * 視覚的に確認できるようにする。元画像が未設定なら何も表示しない (t2v 扱い)。
 */
function I2vSourceBanner() {
  const sourceImagePath = useVideoGen((s) => s.sourceImagePath);
  const setSourceImage = useVideoGen((s) => s.setSourceImage);
  if (!sourceImagePath) return null;
  return (
    <div className="shrink-0 px-3 pt-3">
      <div className="flex items-center gap-3 rounded-md border border-pink-500/40 bg-pink-500/5 p-2">
        <img
          src={`asset://localhost/${encodeURI(sourceImagePath)}`}
          alt="i2v 元画像"
          className="h-12 w-16 shrink-0 cursor-zoom-in rounded object-cover"
          title="ダブルクリックで拡大"
          onDoubleClick={() =>
            useImagePreview.getState().open(sourceImagePath, [sourceImagePath])
          }
        />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-pink-100">i2v 元画像をセット中</p>
          <p className="truncate text-[10px] text-zinc-500">
            この画像を起点に動画を生成します。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSourceImage(null)}
          className="shrink-0 rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-400 hover:border-pink-500/40 hover:text-pink-200"
          title="i2v 元画像を外す (t2v で生成)"
        >
          外す
        </button>
      </div>
    </div>
  );
}

/**
 * 動画生成タブ。レイアウトは画像生成タブ (GenerateTab artwork) と統一する:
 *   左ペイン = シーン構築 (VideoSceneBuilder 6 カード)
 *           + 構築プロンプトパネル (VideoConstructedPromptPanel)
 *   右ペイン = 生成タイムライン (画像と共通)
 */
export function VideoGenerationWorkspace({ timeline }: VideoGenerationWorkspaceProps) {
  return (
    <div className="grid h-full min-h-0 gap-4 md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
      <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]">
        <div className="shrink-0 border-b border-[#242424] px-4 py-3">
          <h3 className="text-sm font-black text-white">動画生成</h3>
        </div>
        <I2vSourceBanner />
        <div className="shrink-0 p-3">
          <VideoSceneBuilder />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-[#242424] bg-[#181818]">
          <VideoConstructedPromptPanel />
        </div>
      </section>
      {timeline ?? (
        <section className="flex h-full min-h-0 items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#181818] text-sm text-neutral-500">
          生成タイムライン
        </section>
      )}
    </div>
  );
}
