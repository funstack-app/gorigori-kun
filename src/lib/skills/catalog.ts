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
  | "gori-product-set"
  | "gori-sticker";

/** 専用アイコン未登録の新設スキルも含む、カタログ上のID。 */
export type GoriCatalogSkillId = GoriSkillId | "film";

export type GoriSkill = {
  id: GoriCatalogSkillId;
  name: string;
  shortName: string;
  /**
   * 2026-07-25: 絵文字アイコンを全廃。描画は id ベースの SkillIcon
   * (src/components/SkillIcon.tsx) が担うため、このフィールドは非推奨。
   * 未使用の旧経路 (SkillSelector.tsx) の互換のため型だけ残す。
   */
  icon?: string;
  description: string;
  path: string;
  /** アプリ内から直接利用可能なスキル。false の場合はグレイアウト表示。 */
  availableInApp: boolean;
  /** 近日公開予定。グレイアウト + 「近日公開」ラベル表示。 */
  comingSoon?: boolean;
  launchHint: string;
};

// スキル一覧 v2.1（2026-07-19 STΛCK確定）。
// 「近日公開」枠は今後の拡張をワクワクさせるための表示。順次解放していく。
//
// ## 並び順 = 使う順番 (2026-07-26 STΛCK 指示)
//
// この配列の順序がそのまま画面の並びになる。カード同士は独立して見えるが、
// 実際には **前のスキルの成果物が次のスキルの入力になる** 依存がある:
//
//   ① キャラクター登録 … 1枚の絵からキャラを資産化する。ここで登録しないと
//                        ②③ で「同じ人物」を指定できず、カットごとに顔が変わる
//   ② ストーリーカット … 登録キャラを固定して物語のカット列を作る
//   ③ マルチアングル   … 決まった被写体のアングル違いを量産する
//
// つまり「登録 → 物語を作る → 角度を増やす」が正しい進み方。以前は
// ストーリーカットが先頭にあったため、登録せずに始めて顔が崩れる入り方を
// 誘導していた。順番自体をガイドにする。
export const GORI_SKILLS: GoriSkill[] = [
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #1): 1枚の参照画像から 3面図+表情+顔ディテールを
    // 並列生成し、キャラ型プリセットとして登録する IPアセット化パイプライン(スライスS4)。
    // 専用 Workspace は CharacterRegisterWorkspace (SkillWorkspaceRouter "characterRegister")。
    // カタログは src/lib/character/sheetCuts.ts、Rust は commands/character_sheet.rs。
    //
    // 2026-07-26: 先頭へ移動。これが起点であることを並びで示す (上のコメント参照)。
    id: "gori-character-register",
    name: "キャラクター登録",
    shortName: "Character Register",
    description:
      "キャラの絵を1枚渡すと、正面・横・後ろ姿や表情、顔アップをまとめて作って「このキャラ」として登録します。登録しておくと、以降どのスキルでも同じ顔のまま呼び出せます。",
    path: "~/.codex/skills/gori-character-register",
    availableInApp: true,
    launchHint: "まずはここから · 絵1枚 → 登録キャラ",
  },
  {
    // 2026-08-22 追加: run-ai-film の設計先行・承認ゲート駆動を移植した
    // 6工程の専用 Workspace。旧ストーリーカットとは S7 まで並存する。
    id: "film",
    name: "フィルム",
    shortName: "Film",
    description: "企画から完成動画まで、設計を固めてから作る映像制作",
    path: "~/.codex/skills/film",
    availableInApp: true,
    launchHint: "企画 → 設計 → 生成 → 完成",
  },
  {
    // 2026-05-20 開放: β版で 4-Phase 専用 Workspace (StoryboardWorkspace) を
    // 実装し、agentic UX (AI が深掘り対話 → 絵コンテ → 生成 → 確認) で
    // 旧 UI の課題 (タブ遷移の不安定さ、進捗不可視) を解消したため。
    // 旧 v0.6.11 のグレーアウトは β 専用 UI 待ち状態だったので解除。
    id: "gori-storyboard",
    name: "ストーリーカット生成",
    shortName: "Storyboard",
    description:
      "作りたい話を伝えると、AIが聞き返しながら絵コンテに起こし、そのままカットを連続生成します。登録キャラと画風を固定するので、話が進んでも同じ人物・同じ絵柄のまま並びます。",
    path: "~/.codex/skills/gori-storyboard",
    availableInApp: true,
    launchHint: "話す → 絵コンテ → カット一式",
  },
  {
    // 2026-06-06 開放: β版で専用 Workspace (MultiAngleWorkspace) を実装。
    // 1枚の被写体参照から、選んだ構図カット(最大30)を並列で一気に生成する。
    // 構図カタログは src/lib/multiangle/angles.ts、Rust は commands/multiangle.rs。
    id: "gori-multi-angle",
    name: "マルチアングル生成",
    shortName: "Multi-Angle",
    description:
      "被写体と場所はそのままに、寄り／引きとカメラの高さ（見上げ・見下ろし・正面）だけを変えたカットを、選んだ分だけ一度に作ります。同じシーンの画角違いが最大30枚そろいます。",
    path: "~/.codex/skills/gori-multi-angle",
    availableInApp: true,
    launchHint: "同じ場面を画角違いで最大30枚",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #2): 登録キャラに表情セットを一括生成する。
    //
    // 2026-07-26 説明文を実装に合わせて修正:
    // 以前は「同一人物に見えるかをAIが検品し、崩れたカットだけ自動で作り直す」と
    // 書いていたが、**同一性の自動検品は未実装**。ExpressionSetWorkspace.tsx:40 に
    // 「検品（同一性採点）は未実装のため『未検品』バッジのみ表示する」とあり、
    // identityCheck.ts の実体は NoopIdentityChecker (欠落を欠落のまま返す)。
    // 名前が約束していないことをやらない状態にする (scene-3d と同じ扱い)。
    id: "gori-expression-set",
    name: "表情差分",
    shortName: "Expression Set",
    description:
      "登録したキャラの表情違いを一度にまとめて作ります。喜怒哀楽から細かい演技まで、同じ顔のまま表情だけを差し替えたカットがそろいます。似ているかどうかの最終判断は人の目で行います。",
    path: "~/.codex/skills/gori-expression-set",
    availableInApp: true,
    launchHint: "登録キャラ → 表情ちがいを一式",
  },
  {
    // 2026-08-05 追加 (設計書 v3 §6.1 / S8)。表情差分の隣に置く。
    //
    // 並び順の意図: キャラ登録 → 表情差分 の直後。スタンプは「同じキャラの
    // 表情バリエーションを、LINE の画像規格に合わせて一式にする」作業なので、
    // 用途として最も近いものが隣にある状態にする。ただし**依存は作らない**
    // (登録キャラが無くても手持ち画像から始められる)。順路の強制ではない。
    //
    // 説明文で「審査に通る」と書かない (設計書 §0.4 / §6.5)。機械が保証できるのは
    // **画像規格** (サイズ・透過・余白・容量) までで、承認可否は LINE の裁量。
    id: "gori-sticker",
    name: "LINEスタンプ制作",
    shortName: "Sticker",
    description:
      "キャラや画像を1枚選ぶと、挨拶・返事などのスタンプをまとめて作ります。並べて見ながら使うものを選び、気になる1枚だけ塗って直せます。書き出す前に画像の規格（サイズ・透過・余白・容量）を機械で点検します。審査に通るかどうかはLINEの判断になります。",
    path: "~/.codex/skills/gori-sticker",
    availableInApp: true,
    launchHint: "キャラ1枚 → スタンプ一式",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #8)。
    //
    // 2026-07-26 説明文を実装に合わせて修正 (STΛCK 指摘):
    // 以前は「参考動画のURLから読み取り」「3Dカメラプリセットを出力」と書いていたが、
    // **どちらも実装されていない**。SceneRecreateWorkspace.tsx:100 に
    // 「codex は動画を直接見られないため時系列キーフレームを投入する方式で成立させる」
    // とあり、実際の入力は静止画 (IMAGE_EXTS) のみ。URL欄は「参考動画の補足(任意)」の
    // 自由記述メモで、そこから何かを取得する処理は無い。3Dカメラプリセットも
    // 「今後の Scene 3D 連携として表示のみ」。
    //
    // また STΛCK 指摘のとおり、静止画からは**時間的な動き**(カメラが寄る速さ、
    // カットのテンポ)は原理的に読めない。読めるのは構図・光・被写体配置まで。
    // 説明でも「動き」を約束しない。
    id: "gori-scene-recreate",
    name: "シーン再現",
    shortName: "Scene Recreate",
    description:
      "気になった映像のスクショを何枚か並べて渡すと、構図・光・被写体の置き方を読み解いて言葉にし、自分のキャラや商品で同じ画作りを再現するプロンプトを出します。動画URLからの取り込みには未対応です。",
    path: "~/.codex/skills/gori-scene-recreate",
    availableInApp: true,
    launchHint: "スクショ数枚 → 同じ画作りの指示文",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #9): 話からネーム→登録キャラ固定でコマ生成→
    // 吹き出し・写植→ページ完成まで。漫画広告・SNS漫画のキャラ一貫性を管理。
    // 2026-07-26 説明文を実装に合わせて修正: 吹き出し・写植の画像合成は未実装
    // (ComicWorkspace.tsx:32「写植・吹き出し合成は MVP 対象外」/ :656「現状はコマの下に
    // セリフをテキスト表示します」)。launchHint の「ページ完成まで」は過大な約束だった。
    id: "gori-comic",
    name: "漫画制作",
    shortName: "Comic",
    description:
      "話を渡すとコマ割りとセリフ案を起こし、登録キャラのままコマの絵を生成します。コマごとに構図もセリフも直せます。セリフはコマの下にテキストで付き、吹き出しの焼き込みは今後対応です。",
    path: "~/.codex/skills/gori-comic",
    availableInApp: true,
    launchHint: "話 → コマ割り → コマの絵",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #10): クライアントの赤入れPDF・注釈画像を読み取り、
    // 指している箇所をマスク化して部分修正。検品しワンタップで差し戻せる。
    id: "gori-redline",
    name: "赤入れ反映",
    shortName: "Redline",
    description:
      "赤ペンや注釈の入った画像を渡すと、どこを何色でどう直せと言われているのかを読み取って日本語に起こします。指している範囲がはっきりしていれば、その部分だけを直せます。",
    path: "~/.codex/skills/gori-redline",
    availableInApp: true,
    launchHint: "赤入れ画像 → 直しの指示に変換",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #11): 入稿物一式を文字量比率・必須表記・ロゴ・
    // NG表現の観点で検査し、根拠付きの指摘一覧を返す。
    id: "gori-regulation-check",
    name: "レギュレーション検査",
    shortName: "Regulation Check",
    description:
      "入稿前のクリエイティブを渡すと、文字の占める割合・入れ忘れてはいけない表記・ロゴの扱い・使ってはいけない表現を見て、どこが引っかかるかを理由つきで指摘します。",
    path: "~/.codex/skills/gori-regulation-check",
    availableInApp: true,
    launchHint: "入稿前に引っかかる箇所を洗い出す",
  },
  {
    // 2026-07-19 追加 (スキル一覧v2.1 #12): 商品写真1枚から白背景・シーンカット・
    // ディテール寄りの納品一式をセットで生成・整形。
    id: "gori-product-set",
    name: "EC納品セット",
    shortName: "Product Set",
    description:
      "商品写真を1枚渡すと、白背景の商品単体・使用シーン・寄りのディテールを一式にして作ります。撮り直しなしで、ECに載せる用の絵がひととおりそろいます。",
    path: "~/.codex/skills/gori-product-set",
    availableInApp: true,
    launchHint: "商品写真1枚 → 掲載用ひと揃い",
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
    description:
      "3Dの空間に人物や小物を置いて、カメラの動きをドラッグで作れます。作った動きは案内用の動画と最初のコマの画像として書き出せるので、動画生成にそのまま渡せます。動画そのものはここでは作りません。",
    path: "~/.codex/skills/gori-scene-3d",
    availableInApp: true,
    launchHint: "Blender不要でカメラワークを作る",
  },
];

export function getGoriSkill(id: string | null | undefined): GoriSkill | undefined {
  return GORI_SKILLS.find((skill) => skill.id === id);
}
