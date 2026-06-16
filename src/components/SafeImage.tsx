import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type ImgHTMLAttributes,
  type MouseEvent,
  useEffect,
  useState,
} from "react";

/**
 * 画像ファイルの絶対パスを受け取って `convertFileSrc` 経由で描画する。
 * 読み込み失敗時 (リネーム前の古いパスを掴んでいる、削除済み等) に
 * 黒画像ではなく「画像が見つかりません」のフォールバックを表示する。
 *
 * F-#2 修正 (2026-05-19): ライブラリリネーム後、history.db / projects.json
 * の path 更新が走らずに旧パスが残ったケースで黒画像になる症状の救済策。
 * 根治は images_rename + renameItemPath 側でやるが、こちらは念のための
 * 二重防止策として使う。
 */
export type SafeImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  /** 画像の絶対パス。空文字や undefined ならフォールバックのみ表示。 */
  path?: string;
  /** フォールバック内に出すテキスト。省略時は「画像なし」。 */
  fallbackLabel?: string;
};

export function SafeImage({
  path,
  fallbackLabel = "画像が見つかりません",
  className,
  alt,
  ...rest
}: SafeImageProps) {
  const [errored, setErrored] = useState(false);

  // F-#2 追補 (2026-06-16): path が変わったら errored をリセットする。
  // これが無いと、旧パスで一度 onError が発火して errored=true になった後、
  // path prop が新パスに更新されても黒画像 (フォールバック) のまま固着する。
  // ライブラリ自動命名後に制作タブ/プロジェクトで画像が黒くなる症状の主因。
  useEffect(() => {
    setErrored(false);
  }, [path]);

  if (!path || errored) {
    return (
      <div
        className={[
          "flex h-full w-full flex-col items-center justify-center gap-1 bg-neutral-900 px-2 text-center text-[10px] text-neutral-500",
          className ?? "",
        ].join(" ")}
        title={path}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5 opacity-50"
          aria-hidden
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
        <span className="line-clamp-2 leading-tight">{fallbackLabel}</span>
      </div>
    );
  }

  return (
    <img
      {...rest}
      src={convertFileSrc(path)}
      alt={alt ?? ""}
      className={className}
      onError={() => setErrored(true)}
    />
  );
}

export type SafeVideoProps = {
  /** 動画の絶対パス。空文字や undefined ならフォールバックのみ表示。 */
  path?: string;
  className?: string;
  fallbackLabel?: string;
  /** 再生バー・音量を出すか (タイムラインのタイルは true で音も鳴る)。 */
  controls?: boolean;
  /** ホバーで自動再生・離脱で停止 (controls=false のサムネ用)。 */
  hoverPlay?: boolean;
};

/**
 * 動画ファイルの絶対パスを `<video>` で描画する。
 * 生成結果 (mp4) を SafeImage (<img>) で表示すると再生も音も出ないため、
 * mediaType=video のタイルはこちらを使う。
 *
 * - controls=true: 再生バー + 音量。クリックで再生、音も出る (Seedance の音声トラック)。
 * - hoverPlay=true: ホバーで再生、離脱で先頭に戻す (軽いサムネプレビュー)。
 *   一覧での負荷を避けるため preload="metadata" + 自動再生はしない。
 */
export function SafeVideo({
  path,
  className,
  fallbackLabel = "動画が見つかりません",
  controls = false,
  hoverPlay = false,
}: SafeVideoProps) {
  const [errored, setErrored] = useState(false);

  // F-#2 追補 (2026-06-16): SafeImage と同じく path 変化で errored をリセット。
  useEffect(() => {
    setErrored(false);
  }, [path]);

  if (!path || errored) {
    return (
      <div
        className={[
          "flex h-full w-full flex-col items-center justify-center gap-1 bg-neutral-900 px-2 text-center text-[10px] text-neutral-500",
          className ?? "",
        ].join(" ")}
        title={path}
      >
        <span className="line-clamp-2 leading-tight">{fallbackLabel}</span>
      </div>
    );
  }

  const onEnter = (e: MouseEvent<HTMLVideoElement>) => {
    if (!hoverPlay) return;
    void e.currentTarget.play().catch(() => {});
  };
  const onLeave = (e: MouseEvent<HTMLVideoElement>) => {
    if (!hoverPlay) return;
    const el = e.currentTarget;
    el.pause();
    el.currentTime = 0;
  };

  return (
    <video
      src={convertFileSrc(path)}
      className={className}
      controls={controls}
      muted={!controls}
      loop={hoverPlay}
      playsInline
      preload="metadata"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onError={() => setErrored(true)}
    />
  );
}
