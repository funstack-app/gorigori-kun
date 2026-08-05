import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type ImgHTMLAttributes,
  type MouseEvent,
  type VideoHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * リトライまでの待ち時間 (ms)。
 *
 * Codex は image_gen が返った瞬間に item/completed を投げるが、WebView が
 * 取りに行く時点で PNG の書き込みフラッシュが間に合わず 404 になることがある。
 * 250ms はディスクフラッシュが落ち着くには十分で、かつユーザーが
 * 「壊れた画像」のちらつきを感じない程度に短い長さ。
 * (MessageList.tsx にあった生 <img> のリトライ機構から移設: 2026-08-05)
 */
const RETRY_DELAY_MS = 250;

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
  /**
   * 読み込み失敗時に一度だけ再フェッチしてからフォールバックへ落とす。
   * 生成直後 (image_gen 直後) の PNG 書き込みフラッシュ待ちが必要なタイルで使う。
   * 省略時 (false) は従来どおり 1 回目の onError で即フォールバック。
   */
  retryOnError?: boolean;
};

export function SafeImage({
  path,
  fallbackLabel = "画像が見つかりません",
  retryOnError = false,
  className,
  alt,
  ...rest
}: SafeImageProps) {
  const [errored, setErrored] = useState(false);
  // リトライ用の再フェッチキー。値が変わると <img> が作り直されて再取得が走る。
  const [retryKey, setRetryKey] = useState(0);
  const retried = useRef(false);

  // F-#2 追補 (2026-06-16): path が変わったら errored をリセットする。
  // これが無いと、旧パスで一度 onError が発火して errored=true になった後、
  // path prop が新パスに更新されても黒画像 (フォールバック) のまま固着する。
  // ライブラリ自動命名後に制作タブ/プロジェクトで画像が黒くなる症状の主因。
  // 併せてリトライ済みフラグも戻す。これが無いと、前の画像で使い切った
  // リトライ枠のせいで別画像に切り替えた直後の 1 回目の失敗が救えない。
  useEffect(() => {
    setErrored(false);
    retried.current = false;
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
      // retryOnError=false のときは key を渡さない (従来と同じ 1 要素のまま)。
      key={retryOnError ? retryKey : undefined}
      src={convertFileSrc(path)}
      alt={alt ?? ""}
      className={className}
      onError={(e) => {
        rest.onError?.(e);
        if (retryOnError && !retried.current) {
          retried.current = true;
          setTimeout(() => setRetryKey((k) => k + 1), RETRY_DELAY_MS);
          return;
        }
        setErrored(true);
      }}
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
  /** 表示と同時に再生する (プレビューモーダル等)。省略時は自動再生しない。 */
  autoPlay?: boolean;
  /**
   * ループ再生。**省略時は従来どおり `hoverPlay` 由来**で、
   * 明示指定したときだけそちらを優先する。
   */
  loop?: boolean;
  onClick?: VideoHTMLAttributes<HTMLVideoElement>["onClick"];
  onDoubleClick?: VideoHTMLAttributes<HTMLVideoElement>["onDoubleClick"];
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
  autoPlay,
  loop,
  onClick,
  onDoubleClick,
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
      autoPlay={autoPlay}
      loop={loop ?? hoverPlay}
      playsInline
      preload="metadata"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onError={() => setErrored(true)}
    />
  );
}
