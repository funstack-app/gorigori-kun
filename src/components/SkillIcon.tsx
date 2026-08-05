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
  // キャラクター登録: IDカード (人物 + 情報行)
  "gori-character-register": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M6 16c0-2 1.5-3 3-3s3 1 3 3M15 9h4M15 13h4" />
    </Box>
  ),
  // 3D演出→動画: 映画カメラ + 軌道の弧
  "gori-scene-3d": ({ className }) => (
    <Box className={className}>
      <rect x="4" y="9" width="10" height="8" rx="2" />
      <path d="M14 12l6-3v8l-6-3" />
      <path d="M3 5c4-2.5 12-2.5 16 0" />
    </Box>
  ),
  // 表情差分: 顔 + 表情ライン
  "gori-expression-set": ({ className }) => (
    <Box className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 10h.01M15 10h.01M8.5 15c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" />
    </Box>
  ),
  // シーン再現: 再生フレーム + 分析マーカー
  "gori-scene-recreate": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 9l5 3-5 3V9z" />
    </Box>
  ),
  // 漫画制作: コマ分割
  "gori-comic": ({ className }) => (
    <Box className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12h18M12 3v9" />
    </Box>
  ),
  // 赤入れ反映: ペン + 修正線
  "gori-redline": ({ className }) => (
    <Box className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
    </Box>
  ),
  // レギュレーション検査: チェックリスト
  "gori-regulation-check": ({ className }) => (
    <Box className={className}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8l1.5 1.5L12 7M8 15l1.5 1.5L12 14M15 8h2M15 15h2" />
    </Box>
  ),
  // EC納品セット: 商品箱 + ライト
  "gori-product-set": ({ className }) => (
    <Box className={className}>
      <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v9" />
    </Box>
  ),
  // LINEスタンプ: 角を折ったシール + 顔
  "gori-sticker": ({ className }) => (
    <Box className={className}>
      <path d="M4 4h11l5 5v11H4V4z" />
      <path d="M15 4v5h5" />
      <path d="M9 12h.01M13 12h.01M9.5 15.5a3 3 0 004 0" />
    </Box>
  ),
};

/**
 * 汎用フラットアイコン (絵文字置き換え用)。
 * プリセットのキャラバッジや空状態のプレースホルダで使う。
 * SkillIcon と同じ 24x24 / stroke 1.5 / currentColor 方針。
 */
export function CharacterIcon({ className }: IconProps) {
  return (
    <Box className={className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
    </Box>
  );
}

export function FaceIcon({ className }: IconProps) {
  return (
    <Box className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 10h.01M15 10h.01M8.5 15c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" />
    </Box>
  );
}

export function ProductShotIcon({ className }: IconProps) {
  return (
    <Box className={className}>
      <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v9" />
    </Box>
  );
}

export function FilmIcon({ className }: IconProps) {
  return (
    <Box className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </Box>
  );
}

export function ClapperIcon({ className }: IconProps) {
  return (
    <Box className={className}>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M3 8l3-4 3 4M9 8l3-4 3 4M15 8l3-4 3 4" />
    </Box>
  );
}

export function SaveIcon({ className }: IconProps) {
  return (
    <Box className={className}>
      <path d="M5 3h11l3 3v13a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
      <path d="M8 3v5h7V3M8 21v-6h8v6" />
    </Box>
  );
}

/**
 * プロジェクト（作品の箱）。2026-07-25: 旧「◱」の置換先。
 * 生成物の保存先を表す文脈で使う。
 */
export function ProjectIcon({ className }: IconProps) {
  return (
    <Box className={className}>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </Box>
  );
}

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
