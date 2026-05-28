import { type ReactNode } from "react";
import { VideoSceneBuilder } from "./scene/VideoSceneBuilder";
import { VideoConstructedPromptPanel } from "./VideoConstructedPromptPanel";

type VideoGenerationWorkspaceProps = {
  /** 右側は既存タイムラインを流用。動画サムネ再生は part2 で拡張する */
  timeline?: ReactNode;
};

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
