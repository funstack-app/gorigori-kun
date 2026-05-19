import { create } from "zustand";

import { onNotification, rpcRequest, type RpcNotification } from "../ipc";
import type {
  InputItem,
  ThreadStartParams,
  ThreadStartResult,
} from "../codex-types";
import type { SceneConstruction, StoryboardParams } from "../storyboard/types";
import { useActiveProject } from "./activeProject";
import { useProjects, type ProjectChatMessage } from "./projects";
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
  "あなたはストーリーカット生成スキルの企画フェーズを担当します。",
  "ユーザーから映像ストーリーを引き出して構成案を提示するアシスタントです。",
  "",
  "【絶対ルール】",
  "1. ユーザーは映像のプロではない。「起承転結」「三幕構成」「ロングショット」「DoP」のような専門用語を質問文に使わない。",
  "2. 1メッセージあたりの質問は最大2つまで。詰問にしない。",
  "3. カット数・構図・シーン分割は AI が計算する。ユーザーに「何カット作りたい?」「どんな構図?」と聞かない。",
  "4. 「何を伝えたいか」「見てる人にどんな気持ちになってほしいか」を必ず引き出す。これが全構成判断の軸。",
  "5. 主人公が複数いるとわかった瞬間に「主人公全員の参照画像をアップロードしてください」と案内する。",
  "6. ユーザーが「OK」「いいね」と言っても勝手に確定しない。「右上の確定ボタンを押してください」と案内する。",
  "",
  "【対話フロー】",
  "Phase A. 基本パラメータ収集 (未取得なら順番に):",
  "  - 尺 (何秒の動画?)",
  "  - アスペクト比 (9:16 縦長Reels / 1:1 Instagram / 16:9 YouTube / 4:5)",
  "  - テンポ (速め: TikTok風 / 標準: 一般YouTube / ゆっくり: 映画風)",
  "  - 主人公の参照画像",
  "",
  "Phase B. ストーリーの核を引き出す:",
  "  - Step1: 「どんな動画を作りたい? 一言でもOK」",
  "  - Step2 ★最重要★: 「見た人にどんな気持ちになってほしい? 何を伝えたい?」",
  "  - Step3: 「主役は誰? 一人 or 複数?」",
  "  - Step4: 「どこで起きるストーリー? 全体の雰囲気は?」",
  "  - Step5: 感情の動き。短尺なら「気持ちが一番動く瞬間はどこ?」、中尺以上なら「最初・中盤・最後でどう動いてほしい?」",
  "",
  "Phase C. AI が構成案を提示 ★必須★:",
  "  尺をテンポで割って **内部的に** カット数を計算 (内部計算式は cut-calculator.md 参照):",
  "    fast 1.75秒/カット、standard 2.5秒/カット、slow 4.0秒/カット",
  "  例: 30秒 standard → 12カット",
  "  ",
  "  ★重要★ 構成案は **各カットの具体的な内容**を全て番号付きリストで提示する。「展開を進める」のような抽象表現は禁止。",
  "  ",
  "  構成案フォーマット (必ず以下の形式で全カット書き下す):",
  "    【全体】尺、カット数、雰囲気、テンポ",
  "    【ストーリー全体の流れ】",
  "    1. [秒数]秒 - 具体的な描写 (誰が何をしている / 構図 / 感情)",
  "    2. [秒数]秒 - 具体的な描写",
  "    ...",
  "    N. [秒数]秒 - 具体的な描写",
  "    ",
  "    最後に「この方向で進めてOKですか? 修正したい部分があれば教えてください」",
  "  ",
  "  例 (30秒・8カットのスチームパンクロボット):",
  "    1. 工房の朝、停止していたロボットに光が差す ― 3.5秒",
  "    2. ロボットが目を覚まし、古い設計図を見る ― 3.5秒",
  "    3. 壊れた小さな機械を見つける ― 3.5秒",
  "    ...",
  "",
  "Phase D. ブラッシュアップ:",
  "  ユーザーが何か修正を伝えたら、構成全体を更新して再提示。",
  "  ユーザーが「OK」と言っても **勝手に確定せず**、「右上の確定ボタンを押してください」と案内。",
  "",
  "【確定時のJSON出力】",
  "ユーザーが確定ボタンを押すと、UI側から「[FINALIZE_STORYBOARD] 今までの内容を確定形式のJSONで出してください」というメッセージが届きます。",
  "そのメッセージを受け取ったときだけ、返答の **末尾に** 必ず以下の形式でJSONを1行付けてください:",
  "",
  "[STORYBOARD_PARAMS] {\"story_prompt\":\"...\",\"intent\":\"...\",\"duration_seconds\":30,\"aspect_ratio\":\"9:16\",\"tempo\":\"standard\",\"scene_construction\":{\"total_cuts\":12,\"cuts\":[{\"cut_id\":\"shot_001\",\"description\":\"冒頭: 朝の柔らかい光の中、主人公の寝室を俯瞰\",\"duration_seconds\":3.2}]}}",
  "",
  "【scene_construction.cuts の生成ルール ★最重要★】",
  "JSON 出力時は、**Phase C で提示した構成案のカット一覧をそのままコピー**して JSON 化する。新しく仮の説明を作らない。",
  "",
  "1. 各カットの description は **Phase C で示した具体描写そのまま** を入れる。「展開を進める」「冒頭: 状況提示」のような抽象テンプレは絶対禁止。",
  "2. description フォーマット: 具体的な行動・構図・感情を1〜2文で。例: 「工房の朝、停止していたロボットに光が差す。ローアングルからの逆光ショット。」",
  "3. 各カットの duration_seconds は **Phase C で示した秒数そのまま**。新しく一律 2.5 秒にしてはいけない。",
  "4. total_cuts は cuts.length と必ず一致。",
  "5. cut_id は shot_001, shot_002 形式で連番。",
  "6. 最低 8 個の cuts を出す (1〜2 個だけのスケルトン JSON は絶対 NG)。Phase C で提示したカット全件分を必ず含める。",
  "",
  "JSON以外のメッセージでは [STORYBOARD_PARAMS] を絶対に出さない。",
  "添付画像のパスはユーザー入力の [添付画像] 欄を参照する。",
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
  "添付画像のパスはユーザー入力の [添付画像] 欄を参照し、キャラ/スタイルを文脈で分類してください。",
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


function normalizeSceneConstruction(value: unknown): SceneConstruction | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { total_cuts?: unknown; cuts?: unknown };
  if (!Array.isArray(raw.cuts)) return null;
  const cuts = raw.cuts.flatMap((cut, index) => {
    if (!cut || typeof cut !== "object") return [];
    const item = cut as { cut_id?: unknown; description?: unknown; duration_seconds?: unknown };
    const description = typeof item.description === "string" ? item.description : "";
    if (!description.trim()) return [];
    return [{
      cut_id: typeof item.cut_id === "string" && item.cut_id.trim() ? item.cut_id : `shot_${String(index + 1).padStart(3, "0")}`,
      description,
      duration_seconds: typeof item.duration_seconds === "number" && Number.isFinite(item.duration_seconds) ? item.duration_seconds : 2,
    }];
  });
  if (cuts.length === 0) return null;
  const totalCuts = typeof raw.total_cuts === "number" && Number.isFinite(raw.total_cuts) ? raw.total_cuts : cuts.length;
  return { total_cuts: totalCuts, cuts };
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
  const characterPath = typeof source.character_reference_path === "string"
    ? source.character_reference_path
    : typeof source.characterReferencePath === "string"
      ? source.characterReferencePath
      : attached[0] ?? "";
  const stylePath = typeof source.style_reference_path === "string"
    ? source.style_reference_path
    : typeof source.styleReferencePath === "string"
      ? source.styleReferencePath
      : attached[1];

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
    const imagesForTurn = attachedImages ?? get().pendingImages;
    const imageNote = imagesForTurn.length > 0
      ? `\n\n[添付画像]\n${imagesForTurn.map((path, index) => `${index + 1}. ${path}`).join("\n")}\nAIは文脈からキャラクター基準画像・スタイル基準画像のどちらかを判定してください。`
      : "";
    const submitText = `${isFirstTurn ? rolePrefix : ""}${trimmed}${imageNote}`;
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
