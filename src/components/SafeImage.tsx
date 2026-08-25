import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type ImgHTMLAttributes,
  type MouseEvent,
  type VideoHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import { images } from "../lib/ipc";

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
const THUMBNAIL_MAX_EDGE = 512;

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
  /** 一覧用。true のとき512pxのディスクキャッシュを表示する。 */
  thumbnail?: boolean;
  /**
   * サムネ表示中、pointerenter / pointerdown をきっかけに原画像を先読みする。
   * 読み込み完了まではサムネを保ち、完了後だけ原画像へ差し替える。
   */
  fullResOnInteraction?: boolean;
};

type SafeImageDisplayPathOptions = {
  path?: string;
  thumbnailPath?: string;
  thumbnail: boolean;
  fullResOnInteraction: boolean;
  interactionStarted: boolean;
  fullResLoaded: boolean;
};

/** 操作前と原画像の先読み中はサムネを保ち、準備完了後だけ原画像を返す。 */
export function resolveSafeImageDisplayPath({
  path,
  thumbnailPath,
  thumbnail,
  fullResOnInteraction,
  interactionStarted,
  fullResLoaded,
}: SafeImageDisplayPathOptions): string | undefined {
  if (!thumbnail) return path;
  if (fullResOnInteraction && interactionStarted && fullResLoaded) return path;
  return thumbnailPath;
}

/** 動画サムネは原動画へ差し替えず、静止画像タイルだけ原寸へ昇格する。 */
export function galleryMediaSupportsFullResOnInteraction(
  mediaType: "image" | "video",
): boolean {
  return mediaType === "image";
}

export function SafeImage({
  path,
  fallbackLabel = "画像が見つかりません",
  retryOnError = false,
  thumbnail = false,
  fullResOnInteraction = false,
  className,
  alt,
  loading = "lazy",
  decoding = "async",
  ...rest
}: SafeImageProps) {
  const [errored, setErrored] = useState(false);
  // リトライ用の再フェッチキー。値が変わると <img> が作り直されて再取得が走る。
  const [retryKey, setRetryKey] = useState(0);
  const retried = useRef(false);
  const [thumbnailResult, setThumbnailResult] = useState<{
    sourcePath: string;
    displayPath: string;
  } | null>(null);
  const [fullResRequestPath, setFullResRequestPath] = useState<string | null>(null);
  const [fullResLoadedPath, setFullResLoadedPath] = useState<string | null>(null);

  // F-#2 追補 (2026-06-16): path が変わったら errored をリセットする。
  // これが無いと、旧パスで一度 onError が発火して errored=true になった後、
  // path prop が新パスに更新されても黒画像 (フォールバック) のまま固着する。
  // ライブラリ自動命名後に制作タブ/プロジェクトで画像が黒くなる症状の主因。
  // 併せてリトライ済みフラグも戻す。これが無いと、前の画像で使い切った
  // リトライ枠のせいで別画像に切り替えた直後の 1 回目の失敗が救えない。
  useEffect(() => {
    let cancelled = false;
    setErrored(false);
    retried.current = false;
    setThumbnailResult(null);
    setFullResRequestPath(null);
    setFullResLoadedPath(null);

    if (thumbnail && path) {
      void images
        .thumbnail(path, THUMBNAIL_MAX_EDGE)
        .then((displayPath) => {
          if (!cancelled) setThumbnailResult({ sourcePath: path, displayPath });
        })
        .catch(() => {
          // サムネ生成に失敗しても、従来の元画像表示へ戻して画面を壊さない。
          if (!cancelled) setThumbnailResult({ sourcePath: path, displayPath: path });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [path, thumbnail, fullResOnInteraction]);

  useEffect(() => {
    if (
      !thumbnail ||
      !fullResOnInteraction ||
      !fullResRequestPath ||
      fullResRequestPath !== path
    ) {
      return;
    }

    let cancelled = false;
    const requestedPath = fullResRequestPath;
    const preload = new Image();
    preload.onload = () => {
      if (!cancelled) setFullResLoadedPath(requestedPath);
    };
    preload.onerror = () => {
      // 原画像を読めない場合は現在のサムネを保ち、次の操作で再試行できるようにする。
      if (!cancelled) {
        setFullResRequestPath((current) =>
          current === requestedPath ? null : current,
        );
      }
    };
    preload.src = convertFileSrc(requestedPath);

    return () => {
      cancelled = true;
      preload.onload = null;
      preload.onerror = null;
    };
  }, [path, thumbnail, fullResOnInteraction, fullResRequestPath]);

  const thumbnailPath = thumbnail
    ? thumbnailResult && thumbnailResult.sourcePath === path
      ? thumbnailResult.displayPath
      : undefined
    : path;
  const displayPath = resolveSafeImageDisplayPath({
    path,
    thumbnailPath,
    thumbnail,
    fullResOnInteraction,
    interactionStarted: fullResRequestPath === path,
    fullResLoaded: fullResLoadedPath === path,
  });
  const requestFullResolution = () => {
    if (
      thumbnail &&
      fullResOnInteraction &&
      path &&
      fullResRequestPath !== path
    ) {
      setFullResRequestPath(path);
    }
  };

  if (!path || !displayPath || errored) {
    return (
      <div
        className={[
          "flex h-full w-full flex-col items-center justify-center gap-1 bg-neutral-900 px-2 text-center text-[10px] text-neutral-500",
          className ?? "",
        ].join(" ")}
        title={path}
        onPointerEnter={requestFullResolution}
        onPointerDown={requestFullResolution}
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
      src={convertFileSrc(displayPath)}
      alt={alt ?? ""}
      className={className}
      loading={loading}
      decoding={decoding}
      onPointerEnter={(e) => {
        requestFullResolution();
        rest.onPointerEnter?.(e);
      }}
      onPointerDown={(e) => {
        requestFullResolution();
        rest.onPointerDown?.(e);
      }}
      onError={(e) => {
        // キャッシュ掃除との競合などでサムネ自体を読めない場合も元画像へ戻す。
        if (thumbnail && displayPath !== path) {
          setThumbnailResult({ sourcePath: path, displayPath: path });
          retried.current = false;
          return;
        }
        // 先読み済み原画像への差し替えだけが失敗した場合は、フォールバックではなく
        // 元のサムネへ戻す。次の pointerdown で再試行できる。
        if (
          thumbnail &&
          fullResOnInteraction &&
          fullResLoadedPath === path &&
          thumbnailPath &&
          thumbnailPath !== path
        ) {
          setFullResLoadedPath(null);
          setFullResRequestPath(null);
          return;
        }
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
  /** 一覧用。画面内に入った時だけ読み込み、先頭フレームを静止画として見せる。 */
  thumbnailPreview?: boolean;
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
  thumbnailPreview = false,
  loop,
  onClick,
  onDoubleClick,
}: SafeVideoProps) {
  const [errored, setErrored] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(!thumbnailPreview);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // F-#2 追補 (2026-06-16): SafeImage と同じく path 変化で errored をリセット。
  useEffect(() => {
    setErrored(false);
    setShouldLoad(!thumbnailPreview);
  }, [path, thumbnailPreview]);

  useEffect(() => {
    if (!thumbnailPreview || errored) return;
    const element = videoRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setShouldLoad(entry?.isIntersecting ?? false),
      { threshold: 0.01 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [path, thumbnailPreview, errored]);

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
      ref={videoRef}
      src={shouldLoad ? convertFileSrc(path) : undefined}
      className={className}
      controls={controls}
      muted={!controls}
      autoPlay={autoPlay}
      loop={loop ?? hoverPlay}
      playsInline
      preload={shouldLoad ? "metadata" : "none"}
      onLoadedMetadata={(event) => {
        if (!thumbnailPreview) return;
        const element = event.currentTarget;
        // WebKit は時刻0のままだと黒地を保つことがある。先頭にほぼ等しい位置を
        // 一度だけ指定し、実フレームの復号を促す。
        const previewTime = Number.isFinite(element.duration)
          ? Math.min(0.001, element.duration / 2)
          : 0.001;
        if (previewTime > 0) {
          try {
            element.currentTime = previewTime;
          } catch {
            // シーク不能な形式は黒地の既存フォールバックを維持する。
          }
        }
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onError={() => setErrored(true)}
    />
  );
}
