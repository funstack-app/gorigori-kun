import { convertFileSrc } from "@tauri-apps/api/core";
import { type ImgHTMLAttributes, useState } from "react";

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
