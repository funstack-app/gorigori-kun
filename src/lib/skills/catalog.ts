export type GoriSkillId =
  | "gori-storyboard"
  | "gori-multi-angle"
  | "gori-scene-3d"
  | "gori-character-register"
  | "gori-expression-set"
  | "gori-scene-recreate"
  | "gori-comic"
  | "gori-redline"
  | "gori-regulation-check"
  | "gori-product-set";

export type GoriSkill = {
  id: GoriSkillId;
  name: string;
  shortName: string;
  icon: string;
  description: string;
  path: string;
  /** アプリ内から直接利用可能なスキル。false の場合はグレイアウト表示。 */
  availableInApp: boolean;
  /** 近日公開予定。グレイアウト + 「近日公開」ラベル表示。 */
  comingSoon?: boolean;
  launchHint: string;
  /** ユーザーがインポートしたカスタムスキル。export ボタンを表示する目印にも使う。 */
  imported?: boolean;
};

// スキル一覧 v2.1（2026-07-19 STΛCK確定）。
// 「近日公開」枠は今後の拡張をワクワクさせるための表示。順次解放していく。
export const GORI_SKILLS: GoriSkill[] = [
  {
    // 2026-05-20 開放: β版で 4-Phase 専用 Workspace (StoryboardWorkspace) を
    // 実装し、agentic UX (AI が深掘り対話 → 絵コンテ → 生成 → 確認) で
    // 旧 UI の課題 (タブ遷移の不安定さ、進捗不可視) を解消したため。
    // 旧 v0.6.11 のグレーアウトは β 専用 UI 待ち状態だったので解除。
    id: "gori-storyboard",
    name: "ストーリーカット生成",
    shortName: "Storyboard",
    icon: "🎬",
    description:
      "ストーリーから一貫したカット列を連続生成。キャラ/スタイルを固定して物語を進める。",
    path: "~/.codex/skills/gori-storyboard",
    availableInApp: true,
    launchHint: "AI と対話してカット列を量産",
  },
  {
    // 2026-06-06 開放: β版で専用 Workspace (MultiAngleWorkspace) を実装。
    // 1枚の被写体参照から、選んだ構図カット(最大30)を並列で一気に生成する。
    // 構図カタログは src/lib/multiangle/angles.ts、Rust は commands/multiangle.rs。
    id: "gori-multi-angle",
    name: "マルチアングル生成",
    shortName: "Multi-Angle",
    icon: "📐",
    description:
      "環境と被写体を固定し、ショット距離(クローズアップ/ミディアム/ロング)とアングル(俯瞰/煽り/正面)だけ変えて一気にカット量産。",
    path: "~/.codex/skills/gori-multi-angle",
    availableInApp: true,
    launchHint: "30 カット一気に量産",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #1): 1枚の参照画像から 3面図+表情+顔ディテールを
    // 並列生成し、キャラ型プリセットとして登録する IPアセット化パイプライン(スライスS4)。
    // 専用 Workspace は CharacterRegisterWorkspace (SkillWorkspaceRouter "characterRegister")。
    // カタログは src/lib/character/sheetCuts.ts、Rust は commands/character_sheet.rs。
    id: "gori-character-register",
    name: "キャラクター登録",
    shortName: "Character Register",
    icon: "🪪",
    description:
      "1枚の参照画像から3面図・表情・顔ディテールを一括生成し、同一キャラとしてプリセット登録。以降の生成で呼び出せる。",
    path: "~/.codex/skills/gori-character-register",
    availableInApp: true,
    launchHint: "1枚からキャラを資産化",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #2): 登録キャラに表情セットを一括生成し、
    // 同一人物に見えるかをAIが検品して崩れたカットだけ作り直す。
    id: "gori-expression-set",
    name: "表情差分",
    shortName: "Expression Set",
    icon: "😊",
    description:
      "登録キャラに喜怒哀楽〜細かい演技の表情セットを一括生成。同一人物に見えるかをAIが検品し、崩れたカットだけ自動で作り直す。",
    path: "~/.codex/skills/gori-expression-set",
    availableInApp: true,
    launchHint: "表情バリエーションを一括生成",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #8): 参考動画URLからショット割り・カメラワーク・
    // 映像文法を読み取り、自分のキャラ・商品で再現するプロンプト+3Dカメラプリセットを出力。
    id: "gori-scene-recreate",
    name: "シーン再現",
    shortName: "Scene Recreate",
    icon: "🔬",
    description:
      "参考動画のURLからショット割り・カメラワーク・映像文法まで読み取り演出意図を言語化。自分のキャラ・商品で同じ演出を再現するプロンプト+3Dカメラプリセットを出力。",
    path: "~/.codex/skills/gori-scene-recreate",
    availableInApp: true,
    launchHint: "参考動画の演出を再現",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #9): 話からネーム→登録キャラ固定でコマ生成→
    // 吹き出し・写植→ページ完成まで。漫画広告・SNS漫画のキャラ一貫性を管理。
    id: "gori-comic",
    name: "漫画制作",
    shortName: "Comic",
    icon: "📖",
    description:
      "話を渡すとネーム(コマ割り+セリフ案)を起こし、登録キャラを固定してコマ画像を生成。セリフ案付きで各コマを並べる。",
    path: "~/.codex/skills/gori-comic",
    availableInApp: true,
    launchHint: "話からページ完成まで",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #10): クライアントの赤入れPDF・注釈画像を読み取り、
    // 指している箇所をマスク化して部分修正。検品しワンタップで差し戻せる。
    id: "gori-redline",
    name: "赤入れ反映",
    shortName: "Redline",
    icon: "🖍",
    description:
      "注釈画像の赤入れを読み取り、何をどう直したいかを日本語で言語化。そのまま編集タブに渡して部分修正に反映できる。",
    path: "~/.codex/skills/gori-redline",
    availableInApp: true,
    launchHint: "赤入れを部分修正に反映",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #11): 入稿物一式を文字量比率・必須表記・ロゴ・
    // NG表現の観点で検査し、根拠付きの指摘一覧を返す。
    id: "gori-regulation-check",
    name: "レギュレーション検査",
    shortName: "Regulation Check",
    icon: "✅",
    description:
      "入稿物一式を文字量比率・必須表記・ロゴ・NG表現の観点で検査し、根拠付きの指摘一覧を返す。",
    path: "~/.codex/skills/gori-regulation-check",
    availableInApp: true,
    launchHint: "入稿物を観点別に検査",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #12): 商品写真1枚から白背景・シーンカット・
    // ディテール寄りの納品一式をセットで生成・整形。
    id: "gori-product-set",
    name: "EC納品セット",
    shortName: "Product Set",
    icon: "📸",
    description:
      "商品写真1枚から、白背景・シーンカット・ディテール寄りの納品一式をセットで生成・整形。",
    path: "~/.codex/skills/gori-product-set",
    availableInApp: true,
    launchHint: "撮影1枚から納品一式",
  },
  {
    // 2026-07-10 追加 (Phase 0 スパイク) → v2.1 で 3D演出→動画に統合。
    // 3D空間に人物・小物を置き、カメラの動きをプリセット+ドラッグで演出 →
    // 登録キャラを指定して動画生成まで一気通貫(動画統合は実装中)。
    // 専用 Workspace は Scene3dWorkspace (SkillWorkspaceRouter "scene3d")。
    id: "gori-scene-3d",
    // 2026-07-25 名称・説明を実態に合わせた。以前は「3D演出→動画」「動画生成まで
    // 一気通貫」と書いていたが、実際には動画生成APIを呼ばず、モーションガイド動画
    // (mp4)と開始フレームPNGを書き出すところまで。それを動画生成の参照として使う
    // 手渡しが残る。名前が約束していないことをやらない状態にする。
    name: "3Dカメラワーク",
    shortName: "Scene 3D",
    icon: "🎥",
    description:
      "3D空間に人物・小物を置き、カメラワークをドラッグで演出。モーションガイド動画と開始フレーム画像を書き出し、動画生成の「参照動画」「開始画像」として使う。",
    path: "~/.codex/skills/gori-scene-3d",
    availableInApp: true,
    launchHint: "Blender不要でカメラワークを作る",
  },
];

export function getGoriSkill(id: string | null | undefined): GoriSkill | undefined {
  return GORI_SKILLS.find((skill) => skill.id === id);
}
