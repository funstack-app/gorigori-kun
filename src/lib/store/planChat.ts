import { create } from "zustand";

import { onNotification, rpcRequest, type RpcNotification } from "../ipc";
import type {
  InputItem,
  ThreadStartParams,
  ThreadStartResult,
} from "../codex-types";
import type { SceneConstruction, StoryboardParams } from "../storyboard/types";
import { buildWorldContextBlock } from "../agents/systemPrompts";
import { useActiveProject } from "./activeProject";
import { useProjects, type ProjectChatMessage } from "./projects";
import { useReferenceRoles } from "./referenceRoles";
import { useSettings } from "./settings";
import { useSkillMode } from "./skillMode";
import { useToasts } from "./toasts";

/**
 * 企画タブ専用のチャット状態。
 *
 * 既存 useThreads（画像生成スレッド）とは別に、独立した plan thread を
 * codex app-server で起動して GPT-5.5 と対話する。画像生成しないので
 * sandbox は read-only / approvalPolicy は never。
 *
 * 設計理由:
 *  - useThreads.activeThreadId は画像生成タブが握っているので競合させない
 *  - 通知 listener は独立に張る（threadId で振り分け）
 *  - メッセージは ChatGPT 風に { user, assistant }[] のフラット配列で持つ
 *    （turn という概念を UI に見せない）
 */

export type PlanRole = "user" | "assistant";

export type PlanMessage = {
  id: string;
  role: PlanRole;
  text: string;
  /** ストリーミング中は true、完了で false。assistant のみ意味を持つ。 */
  streaming?: boolean;
  attachedImages?: string[];
  createdAt: number;
};

const PLAN_MODEL = "gpt-5.5";

/**
 * codex app-server の personality は列挙型 ('none' | 'friendly' | 'pragmatic')。
 * 自由文を渡すと unknown variant エラーで thread/start が失敗する。
 * 企画相談には事実ベースの 'pragmatic' を採用。
 */
const PERSONALITY: "none" | "friendly" | "pragmatic" = "pragmatic";

/**
 * 自由文の人格設定は personality フィールドでは渡せないので、
 * 最初のユーザー入力に prefix として 1 度だけ混ぜる。以降の turn では混ぜない。
 *
 * フォーマット指示が肝:
 *  - プロンプトは「カンマ区切りタグ列」の英語 1 行で
 *  - 各案は独立した Markdown のコードブロック ``` で囲む
 *  - コードブロックの前に日本語で「この案がどういう絵か」を 1〜3 行で説明
 *  - 案が複数あるときは「案 1」「案 2」と見出しを付け、各案ごとに
 *    「日本語説明 → コードブロック」のセットを繰り返す
 *
 * UI 側ではコードブロックを抽出して「エリアブロック + 採用ボタン」に変換する。
 */
/**
 * ストーリーカットスキルがアクティブなときに使う専用 ROLE_PREFIX。
 *
 * 設計思想 (STΛCK 指示 2026-05-15):
 *  - ユーザーは映像のプロではない前提
 *  - 起承転結・三幕構成・shot type 等の専門用語は質問に使わない
 *  - 1メッセージ最大2問
 *  - AI が決めるべきこと (カット数、構図、シーン分割) はユーザーに聞かない
 *  - 「何を伝えたいか」を必ず聞く
 *  - 主人公が複数なら参照画像全員分を要求
 *  - 確定はキーワード検知ではなく、UI 上の「確定」ボタンで行う
 *  - 「OK」「いいね」と言われても勝手に終了しない
 *
 * 完全な対話ガイドは ~/.codex/skills/gori-storyboard/references/story-elicit.md にある。
 */
const STORYBOARD_ROLE_PREFIX = [
  "[役割設定（最初のメッセージにのみ含めています。返信ではこの役割設定への言及は不要です）]",
  "",
  "あなたはストーリーカット生成スキルの企画フェーズを担当する、気さくな映像ディレクターです。",
  "ユーザーと自然に会話しながら、作りたい映像の核を引き出し、最終的にカット構成案にまとめます。",
  "決まった質問票を順番に埋めるのではなく、相手の話の流れに乗って、足りない情報だけを会話の中で拾ってください。",
  "",
  "【会話の姿勢】",
  "- ユーザーは映像のプロではない。「起承転結」「三幕構成」「ロングショット」「DoP」のような専門用語を質問文に使わない。",
  "- テンプレ的な一問一答にしない。相手の言葉に共感・リアクションしてから、自然に次の話題へ。1メッセージあたりの質問は最大2つまで。",
  "- 相手がたくさん話してくれたら、まとめて受け止めて先に進む。逆に一言だけなら、こちらから具体例を出して広げる。",
  "- カット数・構図・シーン分割・カメラワークは AI 側で設計する。ユーザーに「何カット作りたい?」「どんな構図?」とは聞かない。",
  "- 主人公が複数いるとわかったら、その場で「主人公全員の参照画像をアップロードしてください」と自然に案内する。",
  "- ユーザーが「OK」「いいね」と言っても勝手に確定しない。「いい感じですね。よければ右上の確定ボタンを押してください」と案内する。",
  "",
  "【会話の中で最終的に把握したいこと（順番は問わない・自然に拾う）】",
  "  - 何を伝えたいか / 見た人にどんな気持ちになってほしいか ★これが全構成判断の軸。必ず引き出す★",
  "  - どんな動画にしたいか（一言でもOK。ざっくりした願望から広げる）",
  "  - 主役は誰か（一人 or 複数）、舞台・場所・全体の雰囲気",
  "  - 感情の動き（短尺なら一番心が動く瞬間、長めなら最初・中盤・最後の変化）",
  "  - 尺（何秒くらいか）",
  "  - アスペクト比（9:16 縦長Reels / 1:1 Instagram / 16:9 YouTube / 4:5）",
  "  - テンポ（速め: TikTok風 / 標準: 一般YouTube / ゆっくり: 映画風）",
  "  - 映像のタッチ（実写風 / イラスト / アニメ / 3DCG / 油絵タッチ / 水彩 など）",
  "     ユーザーが「実写」「イラスト」等と答えたら toneKeywords に必ず反映する。",
  "     例: ['realistic', 'cinematic photo', 'natural lighting'] / ['anime', '2D illustration', 'flat colors']",
  "  - 参照画像（キャラ/IP）が添付されていれば、その画像を詳細に観察してルックを言語化する（後述の look_analysis に使う）。",
  "     会話の中で「この参照画像はこういうルックですね」と要点を見せて合意を取れると良い。",
  "尺・アスペクト比・テンポは事務的に聞きすぎず、会話が温まったタイミングで自然に確認する。",
  "ユーザーが指定しなければ、伝えたいことや雰囲気から妥当な値を提案して合意を取ってよい（無理に空欄を質問で埋めない）。",
  "",
  "【十分に揃ったら、AI が構成案を提示する ★必須★】",
  "必要な核（特に「伝えたいこと」と尺・テンポ・雰囲気）が見えてきたら、こちらから構成案を出します。",
  "尺をテンポで割って **内部的に** カット数を計算する（内部計算式は cut-calculator.md 参照）:",
  "  fast 1.75秒/カット、standard 2.5秒/カット、slow 4.0秒/カット",
  "  例: 30秒 standard → 12カット",
  "",
  "★重要★ 構成案は **各カットの具体的な内容** を全て番号付きリストで提示する。「展開を進める」のような抽象表現は禁止。",
  "★重要★ この時点で必ず **2 つ以上のシーン** に分けて見せる（場所・状況・感情が変わるところでシーンを切る）。全カットを 1 シーンに押し込まない。",
  "",
  "構成案フォーマット（必ず以下の形式で全カット書き下す）:",
  "  【全体】尺、カット数、雰囲気、テンポ",
  "  【ストーリー全体の流れ】",
  "  ■シーン1: <短いシーン名（場所・状況）>",
  "    1. [秒数]秒 - 具体的な描写 (誰が何をしている / 構図 / 感情)",
  "    2. [秒数]秒 - 具体的な描写",
  "  ■シーン2: <場所/状況/感情が変わったので新シーン>",
  "    3. [秒数]秒 - 具体的な描写",
  "    ...",
  "    N. [秒数]秒 - 具体的な描写",
  "",
  "  最後に「この方向で進めてOKですか? 修正したい部分があれば教えてください」",
  "",
  "  例 (30秒・8カットのスチームパンクロボット、2シーン構成):",
  "    ■シーン1: 工房の目覚め",
  "      1. 工房の朝、停止していたロボットに光が差す ― 3.5秒",
  "      2. ロボットが目を覚まし、古い設計図を見る ― 3.5秒",
  "    ■シーン2: 旅立ち",
  "      3. 壊れた小さな機械を手に取り、扉の外へ歩き出す ― 3.5秒",
  "      ...",
  "",
  "【ブラッシュアップ】",
  "ユーザーが何か修正を伝えたら、構成全体を更新して再提示する（シーン分けは維持する）。",
  "ユーザーが「OK」と言っても **勝手に確定せず**、「右上の確定ボタンを押してください」と案内する。",
  "",
  "【確定時のJSON出力】",
  "ユーザーが確定ボタンを押すと、UI側から「[FINALIZE_STORYBOARD] 今までの内容を確定形式のJSONで出してください」というメッセージが届きます。",
  "そのメッセージを受け取ったときだけ、返答の **末尾に** 必ず以下の形式でJSONを1行付けてください:",
  "",
  "[STORYBOARD_PARAMS] {\"story_prompt\":\"...\",\"intent\":\"...\",\"duration_seconds\":30,\"aspect_ratio\":\"9:16\",\"tempo\":\"standard\",\"scene_construction\":{\"total_cuts\":12,\"cuts\":[{\"cut_id\":\"shot_001\",\"description\":\"冒頭: 朝の柔らかい光の中、主人公の寝室を俯瞰\",\"duration_seconds\":3.2,\"scene_group_id\":\"awakening\"},{\"cut_id\":\"shot_004\",\"description\":\"玄関を出て街へ歩き出す\",\"duration_seconds\":2.8,\"scene_group_id\":\"into_the_city\"}],\"scene_groups\":[{\"id\":\"awakening\",\"cut_ids\":[\"shot_001\",\"shot_002\",\"shot_003\"],\"intent\":\"establish character waking up in their room\",\"primary_location\":\"bedroom at dawn\"},{\"id\":\"into_the_city\",\"cut_ids\":[\"shot_004\",\"shot_005\",\"shot_006\"],\"intent\":\"character steps out and moves through the city\",\"primary_location\":\"city street, morning\"}]}}",
  "",
  "【scene_construction.cuts の生成ルール ★最重要★】",
  "JSON 出力時は、**直前に提示した構成案のカット一覧をそのままコピー**して JSON 化する。新しく仮の説明を作らない。",
  "",
  "1. 各カットの description は **提示した構成案の具体描写そのまま** を入れる。「展開を進める」「冒頭: 状況提示」のような抽象テンプレは絶対禁止。",
  "2. description フォーマット: 具体的な行動・構図・感情を1〜2文で。例: 「工房の朝、停止していたロボットに光が差す。ローアングルからの逆光ショット。」",
  "3. 各カットの duration_seconds は **提示した構成案の秒数そのまま**。新しく一律 2.5 秒にしてはいけない。",
  "4. total_cuts は cuts.length と必ず一致。",
  "5. cut_id は shot_001, shot_002 形式で連番。",
  "6. 最低 8 個の cuts を出す (1〜2 個だけのスケルトン JSON は絶対 NG)。提示した構成案のカット全件分を必ず含める。",
  "7. **scene_groups は必ず 2 つ以上**。各 cut の scene_group_id は所属シーンの id と一致させ、cut_ids にも漏れなく対応させる。全カットを 1 つの scene_group にまとめるのは不合格。",
  "",
  "【演出の前出し ★最重要・2026-06-06★】",
  "各 cut には description に加えて、以下の演出フィールドも **必ず** 埋める。",
  "これにより裏側で毎カット AI 設計する処理が不要になり、生成が大幅に速くなる (18分→数十秒)。",
  "演出をここで詰めるほど、生成画像の意図一致と品質が上がる。手を抜かない。",
  "  - cut_role: カットの役割。establishing / action / detail / reaction / climax / resolution のいずれか",
  "  - shot_type: ショットサイズ。extreme_close / close / medium / full / wide / extreme_wide のいずれか",
  "  - camera_angle: カメラアングル。front / side / three_quarter / high / low / dutch のいずれか",
  "  - action_verbs: このカットの動き・アクションを表す動詞の配列。例: ['目を開ける','見上げる']",
  "  - camera_motion: カメラの動き。static / pan_left / pan_right / tilt_up / tilt_down / dolly_in / dolly_out / handheld のいずれか",
  "  - must_change: このカットで前カットから変える要素の配列。例: ['カメラアングル','構図']",
  "  - negative_constraints: このカットで避けるべきこと。例: ['顔の同一性が崩れる','背景が不自然に変わる']",
  "★多様性ルール: 隣り合うカットで shot_type / camera_angle を必ず変える。同じ寄り引き・同じアングルの連続は禁止。",
  "  全体で 寄り(close系) / 中(medium系) / 引き(wide系) を最低1つずつ、アングルも3種以上を散らす。",
  "演出フィールドの cut への記載例:",
  "  {\"cut_id\":\"shot_001\",\"description\":\"...\",\"duration_seconds\":3.2,\"scene_group_id\":\"awakening\",\"cut_role\":\"establishing\",\"shot_type\":\"wide\",\"camera_angle\":\"high\",\"action_verbs\":[\"目を開ける\"],\"camera_motion\":\"dolly_in\",\"must_change\":[\"構図\"],\"negative_constraints\":[\"顔の同一性が崩れる\"]}",
  "",
  "【ルック分析 (look_analysis) ★参照画像があれば必須★】",
  "ユーザーが参照画像 (キャラ/IP) を添付している場合、会話の中でその画像を **詳細に** ルック分析し、",
  "scene_construction.look_analysis に入れる。これが全カット共通の「一貫性の核」になる。",
  "Fashion Photo GPT 級の詳細さで、画像生成にそのまま使えるレベルまで言語化する。曖昧な要約は禁止。",
  "  - subject_identity: 被写体/キャラの正体 (例: 'レトロな機械式カウンターの奥に座る小柄なヒューマノイド型キャラクター')",
  "  - silhouette: シルエット・体型・全体フォルム",
  "  - color_profile: 色。**光が当たる部分と影の部分の色変化まで** 書く (例: 'ややくすんだ消防服レッド。肩や袖山はオレンジ寄り、影部はレンガ色に沈む')",
  "  - material: 素材・質感 (例: '中厚のコットンツイル。光が強く跳ねる頭部のグロス塗装と対比')",
  "  - key_parts: 各パーツの構造の配列 (頭部/顔/手/服の特徴。一貫させるべき固有ディテール)",
  "  - identity_anchors: 絶対に維持すべき同一性要素の配列 (これがブレると別人になる)",
  "  - mood: 全体のムード・世界観 (例: '赤と銅の密室的な世界。制御された熱、孤独な職務')",
  "  - source_image_path: 分析元の参照画像パス (添付画像欄から)",
  "look_analysis の記載例:",
  "  \"look_analysis\":{\"subject_identity\":\"...\",\"silhouette\":\"...\",\"color_profile\":\"...\",\"material\":\"...\",\"key_parts\":[\"...\"],\"identity_anchors\":[\"...\"],\"mood\":\"...\",\"source_image_path\":\"...\"}",
  "参照画像が無い場合は look_analysis を省略してよい (description ベースで生成する)。",
  "",
  "【シーン (scene_group) 粒度ルール ★最重要★】 (P18a)",
  "0. **scene_groups は必ず 2 つ以上** に分ける。1 つしか無い JSON は不合格。構成案で見せたシーン分けをそのまま JSON 化する。",
  "1. **1 シーン = 3〜5 カット** で細かく分ける。1 シーン 8+ カットは長すぎる。**全カットを 1 シーンにまとめるのは絶対 NG**。",
  "2. 場所・状況・感情のいずれかが変わるたびに **新しい scene_group** を作る。短尺でも最低 2 シーンに分けることで展開が生まれる。",
  "   例: 「教会に到着 (シーン1)」→ 「祭壇まで歩く (シーン2)」→ 「ひざまずいて祈る (シーン3)」",
  "3. 各 scene_group には **意味のある id** を付ける (機械名NG):",
  "   ✅ 良い例: `arrival_at_church`, `walk_to_altar`, `kneel_in_prayer`, `confrontation_with_priest`",
  "   ❌ 悪い例: `scene_1`, `group_a`, `morning`",
  "4. 各 scene_group には短い `intent` を書く (英語 or 日本語、1文):",
  "   例: `intent: 'establish solemn arrival, slow approach to altar'`",
  "5. 各 scene_group には `primary_location` を書く (シーン内で動かない大ロケーション):",
  "   例: `primary_location: 'abandoned church nave'`",
  "6. 各 cut には自身が所属する `scene_group_id` を入れる。",
  "7. scene_construction の中に `scene_groups` 配列も含める (各 group は id / cut_ids / intent / primary_location):",
  "   `\"scene_groups\":[{\"id\":\"walk_to_altar\",\"cut_ids\":[\"shot_001\",\"shot_002\",\"shot_003\"],\"intent\":\"...\",\"primary_location\":\"...\"}]`",
  "",
  "なぜシーンを細かく分けるか: シーン内では場所・キャラ位置・カメラ軸が連動するため連続性が出るが、",
  "1 シーンが長すぎると同じ場所でカメラがぐるぐる回ってるだけの単調な映像になる。",
  "シーンを切り替えることで「展開」が生まれる。",
  "",
  "JSON以外のメッセージでは [STORYBOARD_PARAMS] を絶対に出さない。",
  "添付画像のパスはユーザー入力の [添付画像] 欄を参照する。",
  "",
  "【参照画像の役割 ★FB#3・2026-06-06★】",
  "[添付画像] 欄では各画像に [キャラ参照] / [スタイル参照] の役割ラベルが付く。これはユーザーが明示指定したもの。AI が勝手に入れ替えない。",
  "- キャラ参照: 登場キャラ/被写体の同一性を保つ対象。複数枚 (登場キャラ全員) ありうる。",
  "- スタイル参照: 絵のタッチ/質感のみ参照。人物の同一性には使わない。",
  "JSON 出力時、キャラ参照が複数あれば character_reference_paths 配列に全キャラのパスを入れる (単数 character_reference_path は先頭キャラ)。",
  "スタイル参照が複数あれば style_reference_paths 配列に全スタイルのパスを入れる。",
  "  例: \"character_reference_paths\":[\"/a.png\",\"/b.png\"],\"style_reference_paths\":[\"/style.png\"]",
  "ルック分析 (look_analysis) はキャラ参照を対象に行う (スタイル参照はタッチ言語化に使ってよい)。",
  "",
  "[ここからユーザーのリクエスト]",
  "",
].join("\n");

const ROLE_PREFIX = [
  "[役割設定（最初のメッセージにのみ含めています。返信ではこの役割設定への言及は不要です）]",
  "",
  "あなたは画像生成のプロンプトを一緒に詰めるアシスタントです。",
  "ユーザーが作りたいものをヒアリングし、被写体・構図・ライティング・スタイル・",
  "ムードなどを段階的に質問しながら解像度を上げてください。",
  "",
  "プロンプト案を提示するときは必ず次のフォーマットで返してください:",
  "",
  "1. 案ごとに見出し（例: **案1: 重厚なスチームパンク探偵**）を付ける",
  "2. その案がどういう絵かを日本語で 1〜3 行で説明する",
  "3. 説明の直後に Markdown のコードブロック (```～```) を置き、",
  "   その中に「英語のカンマ区切りタグ列」だけを 1 行で書く",
  "   - 「Subject:」「Style:」のようなラベルは付けない",
  "   - 改行を入れない（必ず 1 行）",
  "   - 例: `cinematic portrait of a steampunk detective, brass goggles, dramatic warm rim lighting, 16:9, photorealistic`",
  "4. 案が複数あれば、案 1 / 案 2 / 案 3 のセットを縦に繰り返す",
  "5. コードブロックの中に日本語や説明を混ぜない（純粋にプロンプトのみ）",
  "",
  "ヒアリング段階ではコードブロックを使わず、プレーンに質問するだけで良いです。",
  "ストーリーカット案件の場合は、次の順で必ず確認してください: 1. 動画尺は何秒くらいですか？ 2. アスペクト比は？(9:16 / 1:1 / 16:9 / 4:5) 3. テンポは速め/標準/ゆっくり？ 4. キャラクター基準画像をアップロードしてください 5. スタイル基準画像はありますか？（任意）",
  "動画パラメータが揃ったら、尺とテンポから推奨カット数を計算し、番号付きのシーン構成案を提示してください。",
  "ストーリーカットの最終確認時は、返答末尾に必ず [STORYBOARD_PARAMS] と1行JSONを付けてください。",
  "JSON形式: {\"duration_seconds\":10,\"aspect_ratio\":\"16:9\",\"tempo\":\"standard\",\"character_reference_path\":\"/path/to/character.png\",\"style_reference_path\":\"/path/to/style.png\",\"scene_construction\":{\"total_cuts\":4,\"cuts\":[{\"cut_id\":\"shot_001\",\"description\":\"導入\",\"duration_seconds\":2.5}]}}",
  "添付画像のパスはユーザー入力の [添付画像] 欄を参照してください。各画像には [キャラ参照] / [スタイル参照] の役割ラベルが付くので、それに従い、AI が勝手に入れ替えないでください。キャラ参照が複数あれば character_reference_paths 配列に全パスを入れます。",
  "「採用してください」のようなメタ指示文は不要です（UI 側に採用ボタンが出ます）。",
  "",
  "[ここからユーザーのリクエスト]",
  "",
].join("\n");

type PlanChatState = {
  threadId?: string;
  /** thread/start 進行中フラグ */
  starting: boolean;
  /** turn/start ↔ turn/completed 進行中フラグ */
  sending: boolean;
  /** チャット履歴 (user / assistant をフラットに並べる) */
  messages: PlanMessage[];
  /** ストリーミング中の assistant メッセージ id（item id をそのまま使う）。
   *  notification の delta はこの id 宛に積む。 */
  streamingItemId?: string;

  attached: boolean;
  storyboardParams: StoryboardParams | null;
  sceneConstruction: SceneConstruction | null;
  pendingImages: string[];
  addPendingImages: (paths: string[]) => void;
  removePendingImage: (path: string) => void;
  clearPendingImages: () => void;
  setStoryboardParams: (params: StoryboardParams | null) => void;
  setSceneConstruction: (scene: SceneConstruction | null) => void;
  attach: () => Promise<void>;
  ensureThread: () => Promise<string>;
  send: (text: string, attachedImages?: string[]) => Promise<void>;
  resetThread: () => void;
};

let listenerHandle: undefined | (() => void);
let threadStartPromise: Promise<string> | undefined;

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendString(prev: unknown, delta: string): string {
  if (typeof prev === "string") return prev + delta;
  return delta;
}

function extractTextDelta(params: any): string | undefined {
  if (typeof params?.delta === "string") return params.delta;
  if (typeof params?.textDelta === "string") return params.textDelta;
  return undefined;
}

function isAspectRatio(value: unknown): value is StoryboardParams["aspect_ratio"] {
  return value === "9:16" || value === "1:1" || value === "16:9" || value === "4:5";
}

function normalizeTempo(value: unknown): StoryboardParams["tempo"] | null {
  if (value === "fast" || value === "standard" || value === "slow") return value;
  if (value === "速め" || value === "早め" || value === "速い") return "fast";
  if (value === "標準" || value === "普通") return "standard";
  if (value === "ゆっくり" || value === "遅め" || value === "slowly") return "slow";
  return null;
}

function jsonAfterMarker(text: string, marker: string): unknown | null {
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function latestAttachedImages(messages: PlanMessage[]): string[] {
  return messages.flatMap((message) => message.attachedImages ?? []);
}


/** 文字列フィールドを安全に取り出す (空はundefined)。 */
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
/** 文字列配列を安全に取り出す。 */
function optStrArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return arr.length ? arr : undefined;
}
/** snake/camel 両対応でフィールドを引く。 */
function pick(o: Record<string, unknown>, snake: string, camel: string): unknown {
  return o[snake] ?? o[camel];
}

/** ルック分析を正規化 (2026-06-06)。snake/camel 両対応。 */
function normalizeLookAnalysis(value: unknown): SceneConstruction["look_analysis"] {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const subjectIdentity = optStr(pick(o, "subject_identity", "subjectIdentity"));
  const mood = optStr(o.mood);
  // 最低限 subjectIdentity か mood が無ければルック分析として扱わない。
  if (!subjectIdentity && !mood) return undefined;
  return {
    subjectIdentity: subjectIdentity ?? "",
    silhouette: optStr(o.silhouette) ?? "",
    colorProfile: optStr(pick(o, "color_profile", "colorProfile")) ?? "",
    material: optStr(o.material) ?? "",
    keyParts: optStrArray(pick(o, "key_parts", "keyParts")) ?? [],
    identityAnchors: optStrArray(pick(o, "identity_anchors", "identityAnchors")) ?? [],
    mood: mood ?? "",
    sourceImagePath: optStr(pick(o, "source_image_path", "sourceImagePath")) ?? "",
  };
}

function normalizeSceneConstruction(value: unknown): SceneConstruction | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { total_cuts?: unknown; cuts?: unknown; look_analysis?: unknown; lookAnalysis?: unknown };
  if (!Array.isArray(raw.cuts)) return null;
  const cuts = raw.cuts.flatMap((cut, index) => {
    if (!cut || typeof cut !== "object") return [];
    const item = cut as Record<string, unknown>;
    const description = typeof item.description === "string" ? item.description : "";
    if (!description.trim()) return [];
    // 演出フィールド (2026-06-06): 企画タブで前出しした演出をそのまま運ぶ。
    // 値があるものだけ載せる (部分前出しを許容)。snake/camel 両対応。
    return [{
      cut_id: typeof item.cut_id === "string" && (item.cut_id as string).trim() ? (item.cut_id as string) : `shot_${String(index + 1).padStart(3, "0")}`,
      description,
      duration_seconds: typeof item.duration_seconds === "number" && Number.isFinite(item.duration_seconds) ? (item.duration_seconds as number) : 2,
      cut_role: optStr(pick(item, "cut_role", "cutRole")),
      shot_type: optStr(pick(item, "shot_type", "shotType")),
      camera_angle: optStr(pick(item, "camera_angle", "cameraAngle")),
      action_verbs: optStrArray(pick(item, "action_verbs", "actionVerbs")),
      camera_motion: optStr(pick(item, "camera_motion", "cameraMotion")),
      must_keep: optStrArray(pick(item, "must_keep", "mustKeep")),
      must_change: optStrArray(pick(item, "must_change", "mustChange")),
      negative_constraints: optStrArray(pick(item, "negative_constraints", "negativeConstraints")),
    }];
  });
  if (cuts.length === 0) return null;
  const totalCuts = typeof raw.total_cuts === "number" && Number.isFinite(raw.total_cuts) ? raw.total_cuts : cuts.length;
  const look_analysis = normalizeLookAnalysis(raw.look_analysis ?? raw.lookAnalysis);
  return { total_cuts: totalCuts, cuts, look_analysis };
}

function extractStructuredStoryboard(text: string, messages: PlanMessage[]): { params: StoryboardParams; scene: SceneConstruction } | null {
  const payload = jsonAfterMarker(text, "[STORYBOARD_PARAMS]");
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const source = (root.storyboardParams && typeof root.storyboardParams === "object")
    ? (root.storyboardParams as Record<string, unknown>)
    : root;
  const duration = Number(source.duration_seconds ?? source.durationSeconds);
  const aspect = source.aspect_ratio ?? source.aspectRatio;
  const tempo = normalizeTempo(source.tempo);
  const attached = latestAttachedImages(messages);
  // FB#3 (2026-06-06): フォールバックの「1枚目=キャラ/2枚目=スタイル」自動割当を廃し、
  // ユーザーが referenceRoles で明示指定した役割を尊重する。AI が JSON に明示パスを
  // 返していればそれを最優先、無ければ役割指定済みの先頭画像を採用する。
  const roleStore = useReferenceRoles.getState();
  const charAttached = attached.filter((p) => roleStore.getRole(p) === "character");
  const styleAttached = attached.filter((p) => roleStore.getRole(p) === "style");
  const characterPath = typeof source.character_reference_path === "string"
    ? source.character_reference_path
    : typeof source.characterReferencePath === "string"
      ? source.characterReferencePath
      : charAttached[0] ?? attached[0] ?? "";
  const stylePath = typeof source.style_reference_path === "string"
    ? source.style_reference_path
    : typeof source.styleReferencePath === "string"
      ? source.styleReferencePath
      : styleAttached[0];
  // 複数キャラ参照 (登場キャラ全員) を後方互換フィールドと別に保持する。
  // 単数 character_reference_path は先頭キャラを指すので、配列にはそれを含む全キャラを入れる。
  const characterPaths = (() => {
    const fromJson = optStrArray(
      pick(source, "character_reference_paths", "characterReferencePaths"),
    );
    if (fromJson && fromJson.length > 0) return fromJson;
    if (charAttached.length > 0) return charAttached;
    return characterPath ? [characterPath] : [];
  })();
  const stylePaths = (() => {
    const fromJson = optStrArray(
      pick(source, "style_reference_paths", "styleReferencePaths"),
    );
    if (fromJson && fromJson.length > 0) return fromJson;
    if (styleAttached.length > 0) return styleAttached;
    return stylePath ? [stylePath] : [];
  })();

  // STΛCK 指示 (2026-05-20): Phase 1 ゴール深掘りでは画像必須にしない。
  // characterPath は Phase 2 絵コンテレビュー後 / Phase 3 生成開始時に
  // 後付けで確定する。ここでは duration/aspect/tempo が揃えば params を作る。
  if (!Number.isFinite(duration) || duration <= 0 || !isAspectRatio(aspect) || !tempo) {
    return null;
  }

  const params: StoryboardParams = {
    duration_seconds: duration,
    aspect_ratio: aspect,
    tempo,
    character_reference_path: characterPath,
    style_reference_path: stylePath || undefined,
    // FB#3 (2026-06-06): 複数キャラ/スタイル参照。後方互換の単数フィールドは残しつつ、
    // 配列があれば下流 (本生成) が全参照を画像生成へ渡せる。空配列は付けない。
    ...(characterPaths.length > 1 ? { character_reference_paths: characterPaths } : {}),
    ...(stylePaths.length > 1 ? { style_reference_paths: stylePaths } : {}),
    // ストーリー本文と意図も保持 (現在の構成モーダルで表示するため)
    ...(typeof source.story_prompt === "string" ? { story_prompt: source.story_prompt } : {}),
    ...(typeof source.storyPrompt === "string" ? { story_prompt: source.storyPrompt } : {}),
    ...(typeof source.intent === "string" ? { intent: source.intent } : {}),
    ...(typeof source.atmosphere === "string" ? { atmosphere: source.atmosphere } : {}),
    ...(typeof source.location === "string" ? { location: source.location } : {}),
  } as StoryboardParams;
  const rawScene = root.scene_construction ?? root.sceneConstruction ?? source.scene_construction ?? source.sceneConstruction;
  const scene = normalizeSceneConstruction(rawScene);
  // STΛCK 指示 (2026-05-15): AI が scene_construction.cuts を返さなかった/不完全だった場合、
  // テンプレで仮構成を作るフォールバックは廃止。null を返して UI 側でエラー扱いにする。
  if (!scene) return null;
  return { params, scene };
}

export const usePlanChat = create<PlanChatState>((set, get) => ({
  starting: false,
  sending: false,
  messages: [],
  attached: false,
  storyboardParams: null,
  sceneConstruction: null,
  pendingImages: [],
  addPendingImages: (paths) =>
    set((state) => {
      const next = [...state.pendingImages];
      for (const path of paths) {
        if (path && !next.includes(path)) next.push(path);
      }
      return { pendingImages: next };
    }),
  removePendingImage: (path) =>
    set((state) => ({ pendingImages: state.pendingImages.filter((item) => item !== path) })),
  clearPendingImages: () => set({ pendingImages: [] }),
  setStoryboardParams: (storyboardParams) => set({ storyboardParams }),
  setSceneConstruction: (sceneConstruction) => set({ sceneConstruction }),

  attach: async () => {
    if (get().attached) return;
    set({ attached: true });
    listenerHandle?.();
    listenerHandle = await onNotification((n: RpcNotification) => {
      const planId = get().threadId;
      if (!planId) return;
      const params = n.params as any;
      const tid = params?.threadId ?? params?.thread?.id;
      // 自分の plan thread 以外は無視（画像生成 thread の通知が混ざるため）
      if (tid !== planId) return;

      if (n.method === "item/started") {
        const item = params?.item;
        if (item?.type === "agentMessage" && item.id) {
          // 新しい assistant メッセージの開始
          const newMsg: PlanMessage = {
            id: item.id,
            role: "assistant",
            text: typeof item.text === "string" ? item.text : "",
            streaming: true,
            createdAt: Date.now(),
          };
          set((s) => ({
            messages: [...s.messages, newMsg],
            streamingItemId: item.id,
          }));
        }
      } else if (n.method === "item/agentMessage/delta") {
        const itemId = params?.itemId;
        const delta = extractTextDelta(params);
        if (!itemId || delta === undefined) return;
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === itemId
              ? { ...m, text: appendString(m.text, delta) }
              : m,
          ),
        }));
      } else if (n.method === "item/completed") {
        const item = params?.item;
        if (item?.type === "agentMessage" && item.id) {
          const finalText = typeof item.text === "string" && item.text.length > 0 ? item.text : undefined;
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === item.id
                ? {
                    ...m,
                    text: finalText ?? m.text,
                    streaming: false,
                  }
                : m,
            ),
            streamingItemId: s.streamingItemId === item.id ? undefined : s.streamingItemId,
          }));
          const responseText =
            finalText ??
            get().messages.find((m) => m.id === item.id)?.text ??
            "";
          const parsed = extractStructuredStoryboard(responseText, get().messages);
          if (parsed) {
            set({ storyboardParams: parsed.params, sceneConstruction: parsed.scene });
          } else {
            // ★★★ STΛCK 指示 (2026-05-15) ★★★
            // 直前のユーザー入力が FINALIZE 要求だったのに、応答に有効な
            // scene_construction が含まれていなかった場合はエラー扱い。
            // テンプレ仮構成で誤魔化さず、ユーザーに再試行を促す。
            const recentUserText = (() => {
              const msgs = get().messages;
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === "user") return msgs[i].text;
              }
              return "";
            })();
            const wasFinalizeRequest = recentUserText.includes(
              "[FINALIZE_STORYBOARD]",
            );
            if (wasFinalizeRequest) {
              useToasts.getState().push({
                kind: "error",
                text:
                  "確定 JSON の取得に失敗しました。AI が具体的な構成を返していません。\nもう一度「確定」ボタンを押すか、企画チャットで「先ほどの構成を JSON で出してください」と伝えてください。",
                ttlMs: 8000,
              });
            }
          }
        }
      } else if (n.method === "turn/completed") {
        // 念のためフラグを下ろす（item/completed が来ない異常系の保険）
        set((s) => ({
          sending: false,
          messages: s.messages.map((m) =>
            m.streaming ? { ...m, streaming: false } : m,
          ),
          streamingItemId: undefined,
        }));
        const status = params?.turn?.status;
        if (status === "failed") {
          const err = params?.turn?.error?.message ?? "企画チャットでエラーが発生しました";
          useToasts.getState().push({ kind: "error", text: err, ttlMs: 6000 });
        }
        // 会話完了 → アクティブプロジェクトがあれば planChat ログを上書き保存
        // 「会話 1 ターンごとにスナップショット保存」の動き。
        // streaming は保存しないので一度フラグ整理した後の messages を渡す。
        const activeProjectId = useActiveProject.getState().activeProjectId;
        if (activeProjectId) {
          const snapshot: ProjectChatMessage[] = get().messages.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.text,
            attachedImages: m.attachedImages,
            createdAt: m.createdAt,
          }));
          useProjects.getState().setPlanChat(activeProjectId, snapshot);
        }
      }
    });
  },

  ensureThread: async () => {
    const existing = get().threadId;
    if (existing) return existing;
    if (threadStartPromise) return threadStartPromise;

    threadStartPromise = (async () => {
      set({ starting: true });
      try {
        // attach は冪等。最初の thread/start 前に必ず張っておく。
        await get().attach();
        const params: ThreadStartParams = {
          model: PLAN_MODEL,
          // 画像生成しないので最弱権限で OK
          approvalPolicy: "never",
          sandbox: "read-only",
          personality: PERSONALITY,
        };
        const r = await rpcRequest<ThreadStartResult>("thread/start", params);
        set({ threadId: r.thread.id });
        return r.thread.id;
      } catch (err) {
        useToasts.getState().push({
          kind: "error",
          text: `企画チャットの起動に失敗しました: ${(err as Error)?.message ?? err}`,
          ttlMs: 6000,
        });
        throw err;
      } finally {
        set({ starting: false });
        threadStartPromise = undefined;
      }
    })();
    return threadStartPromise;
  },

  send: async (text: string, attachedImages?: string[]) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (get().sending) return;
    // 初回ターンだけ ROLE_PREFIX を混ぜて assistant の振る舞いを誘導する。
    // UI には trimmed のままを表示し、codex に送る input だけ拡張する。
    //
    // ストーリーカットスキルがアクティブな場合は専用 prefix を使用。
    // (STΛCK 指示 2026-05-15: スキル選択→企画タブ→ストーリー引き出しモード)
    const isFirstTurn = get().messages.length === 0;
    const skillState = useSkillMode.getState();
    const isStoryboardSkill =
      skillState.enabled && skillState.selectedSkillId === "gori-storyboard";
    const rolePrefix = isStoryboardSkill ? STORYBOARD_ROLE_PREFIX : ROLE_PREFIX;
    // FB#16: 設定で登録した世界観 / コンテキストを初回ターンだけ前置きする。
    // ROLE_PREFIX より前に置き、AI が作品設定を踏まえて役割を理解できるようにする。
    const worldContext = isFirstTurn
      ? buildWorldContextBlock(useSettings.getState().settings.worldContext)
      : "";
    const imagesForTurn = attachedImages ?? get().pendingImages;
    // FB#3 (2026-06-06): 添付画像の役割 (キャラ/スタイル) をユーザーが明示指定して
    // いれば、それをそのまま AI に伝える。AI の文脈推測に任せず、登場キャラが複数
    // いるケースで「勝手にスタイル参照になる」事故を防ぐ。役割は referenceRoles
    // ストア (パス → "character" | "style") が握る。未指定はキャラ既定。
    const roleStore = useReferenceRoles.getState();
    const charImages = imagesForTurn.filter((p) => roleStore.getRole(p) === "character");
    const styleImages = imagesForTurn.filter((p) => roleStore.getRole(p) === "style");
    const imageNote = imagesForTurn.length > 0
      ? `\n\n[添付画像]\n${imagesForTurn
          .map((path, index) => {
            const role = roleStore.getRole(path) === "style" ? "スタイル参照" : "キャラ参照";
            return `${index + 1}. [${role}] ${path}`;
          })
          .join("\n")}\n` +
        (charImages.length > 0
          ? `キャラ参照 (登場キャラ/被写体の同一性を保つ対象, ${charImages.length}枚): ${charImages.join(", ")}\n`
          : "") +
        (styleImages.length > 0
          ? `スタイル参照 (絵のタッチ/質感のみ参照し人物同一性には使わない, ${styleImages.length}枚): ${styleImages.join(", ")}\n`
          : "") +
        "上記の役割指定に従ってください。キャラ参照は人物の同一性維持に、スタイル参照はタッチ/質感の参照に使い分けてください。役割をAIが勝手に入れ替えないでください。"
      : "";
    const submitText = `${isFirstTurn ? worldContext : ""}${isFirstTurn ? rolePrefix : ""}${trimmed}${imageNote}`;
    // user メッセージは楽観的に「ユーザーが書いたまま」を表示する
    const userMsg: PlanMessage = {
      id: generateId(),
      role: "user",
      text: trimmed,
      attachedImages: imagesForTurn.length > 0 ? imagesForTurn : undefined,
      createdAt: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, userMsg], sending: true }));
    try {
      const threadId = await get().ensureThread();
      const input: InputItem[] = [
        { type: "text", text: submitText },
        ...imagesForTurn.map((path) => ({ type: "localImage" as const, path })),
      ];
      await rpcRequest("turn/start", {
        threadId,
        input,
        model: PLAN_MODEL,
      });
      set({ pendingImages: [] });
      // sending=false は turn/completed 通知で下ろす
    } catch (err) {
      useToasts.getState().push({
        kind: "error",
        text: `送信に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
      set({ sending: false });
    }
  },

  resetThread: () => {
    set({
      threadId: undefined,
      messages: [],
      sending: false,
      streamingItemId: undefined,
      storyboardParams: null,
      sceneConstruction: null,
      pendingImages: [],
    });
  },
}));
