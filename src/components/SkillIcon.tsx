/**
 * スキルアイコン (フラットラインスタイル SVG)。
 * STΛCK 指示 (2026-05-17): 絵文字・星・キラキラを廃止、スタイリッシュな
 * モノクロ細線アイコンに統一。pink-500 アクセントで生成系の統一感を出す。
 *
 * 設計方針:
 * - 24x24 viewBox、stroke 1.5px、ラウンドキャップ
 * - currentColor で配色 (親側で text-pink-500 等を指定する想定)
 * - 文字に依存しない (絵文字より小型でも判読可能)
 */
import type { GoriSkillId } from "../lib/skills/catalog";
import type { ReactElement, ReactNode } from "react";

const STROKE = 1.5;

type IconProps = { className?: string };

function Box({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

const ICONS: Record<GoriSkillId, (props: IconProps) => ReactElement> = {
  // ストーリーカット: 映画スレート + コマ枠
  "gori-storyboard": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10h18M9 6v4M15 6v4" />
    </Box>
  ),
  // マルチアングル: 三角形 (視点) + 同心円
  "gori-multi-angle": ({ className }) => (
    <Box className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M21 12h-3M12 21v-3M3 12h3M5 5l2 2M19 5l-2 2M19 19l-2-2M5 19l2-2" />
    </Box>
  ),
  // 3Dシーン演出: 映画カメラ + 軌道の弧
  "gori-scene-3d": ({ className }) => (
    <Box className={className}>
      <rect x="4" y="9" width="10" height="8" rx="2" />
      <path d="M14 12l6-3v8l-6-3" />
      <path d="M3 5c4-2.5 12-2.5 16 0" />
    </Box>
  ),
  // モバイル LP: 縦長矩形
  "gori-lp-builder": ({ className }) => (
    <Box className={className}>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </Box>
  ),
  // 切り抜き OCR: ハサミライン + テキストライン
  "gori-cutout-ocr": ({ className }) => (
    <Box className={className}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <path d="M8 8l12 12M8 16l12-12" />
    </Box>
  ),
  // 背景差し替え: 山 + 太陽
  "gori-bg-swap": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M3 17l5-5 4 4 4-4 5 5" />
    </Box>
  ),
  // ポーズ転写: 人型シルエット
  "gori-pose-transfer": ({ className }) => (
    <Box className={className}>
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v5M12 12l-3 4M12 12l3 4M12 12l-4 0M12 12l4 0" />
    </Box>
  ),
  // プロダクトショット: 商品箱 + ライト
  "gori-product-shot": ({ className }) => (
    <Box className={className}>
      <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v9" />
    </Box>
  ),
  // キャラクターシート: 4 グリッド
  "gori-character-sheet": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </Box>
  ),
  // サムネ量産: 重なった矩形
  "gori-thumbnail-batch": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <rect x="7" y="7" width="14" height="14" rx="2" />
    </Box>
  ),
  // スタイル転写: 矢印 + パレット
  "gori-style-transfer": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
      <path d="M11 7h6a4 4 0 014 4v0" />
    </Box>
  ),
  // カラーパレット: 円が並ぶ
  "gori-color-palette": ({ className }) => (
    <Box className={className}>
      <circle cx="6" cy="12" r="3" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="18" cy="12" r="3" />
    </Box>
  ),
  // マンガコマ割り: コマ分割線
  "gori-comic-panel": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12h18M12 3v9" />
    </Box>
  ),
};

export function SkillIcon({ id, className }: { id: string; className?: string }) {
  const Component = ICONS[id as GoriSkillId];
  if (!Component) {
    // 未知のスキル (imported 等) は汎用枠アイコン
    return (
      <Box className={className}>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M8 10h8M8 14h5" />
      </Box>
    );
  }
  return <Component className={className} />;
}
