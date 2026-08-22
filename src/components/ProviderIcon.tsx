import { useState } from "react";

export type ProviderIconId =
  | "higgsfield"
  | "magnific"
  | "krea"
  | "runway"
  | "bfl"
  | "ideogram"
  | "openart"
  | "pika"
  | "kling"
  | "pollo"
  | "topview";

type ProviderIconProps = {
  id: ProviderIconId;
  className?: string;
};

function ConnectionFallbackIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden
    >
      <path d="M8 3v4M16 3v4M6 7h12v2a6 6 0 0 1-12 0V7zM12 15v6M9 21h6" />
    </svg>
  );
}

/** 公式画像が未配置・読込失敗の場合は、共通の接続マークを表示する。 */
export function ProviderIcon({ id, className = "" }: ProviderIconProps) {
  const [failedId, setFailedId] = useState<ProviderIconId | null>(null);
  const imageFailed = failedId === id;

  return (
    <span
      className={`grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-pink-400/20 bg-[#101010] text-pink-200 ${className}`}
      aria-hidden
    >
      {imageFailed ? (
        <ConnectionFallbackIcon />
      ) : (
        <img
          src={`/provider-icons/${id}.png`}
          alt=""
          className="h-full w-full object-contain p-1"
          onError={() => setFailedId(id)}
        />
      )}
    </span>
  );
}
