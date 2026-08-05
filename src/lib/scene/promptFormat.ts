import type {
  ImagePromptJson,
  VideoPromptJson,
  VideoTimelineEntry,
} from "./buildPromptJson";
import { stringifyPromptJson } from "./buildPromptJson";

/**
 * 「AIで整える」の出力形式と、その決定論変換。
 *
 * ## なぜ YAML を自前で書くか (2026-08-03 STΛCK指示 ③)
 *
 * LLM には常に JSON を返させ、YAML への変換はクライアント側で決定論的に行う。
 * LLM に YAML を直接書かせると壊れ YAML の修復・検証が要り、既存の
 * subset / whitelist ガード (JSON 前提) が使えなくなる。
 *
 * 対象データは自制御下の ImagePromptJson | VideoPromptJson だけ
 * (フラットな string/number + references / timeline の浅い配列)。
 * 書き出し専用でパースはしないので、YAML ライブラリを runtime に足さない。
 */

/** 「AIで整える」の出力形式。 */
export type PromptFormat = "json" | "yaml";

/** 画像スキーマの許可キー (buildPromptJson.ImagePromptJson と同期を保つ)。 */
export const ALLOWED_IMAGE_KEYS = [
  "subject",
  "composition",
  "shot_size",
  "camera_angle",
  "framing",
  "aspect_ratio",
  "environment",
  "lighting",
  "mood",
  "camera",
  "shot",
  "style",
  "references",
] as const;

/** 動画スキーマの許可キー (VideoPromptJson と同期を保つ)。 */
export const ALLOWED_VIDEO_KEYS = [
  "subject",
  "scene",
  "subject_motion",
  "motion_strength",
  "camera_motion",
  "staging",
  "lighting",
  "mood",
  "style",
  "aspect_ratio",
  "duration_seconds",
  "timeline",
  "references",
] as const;

/**
 * plain scalar として裸で出してよい文字列のホワイトリスト (B3 2026-08-03 r3)。
 *
 * **英字始まり**の英数字 + 空白/アンダースコア/ハイフンのみ。
 * 数字始まりを許さないのが要点で、これだけで YAML の数値表記
 * (10進・16進 `0xFF`・8進 `0o17` / `017`・2進 `0b101`・区切り付き `1_000`・
 * 指数 `1e3`・小数 `.5`・60進 `1:30`・日付 `2026-08-03`) が**まとめて**
 * 引用符側に落ちる。個別に列挙して追いかけると必ず取りこぼす
 * (r2 で `0xFF` / `0b101` / `1_000` を取りこぼした実測)。
 *
 * カンマ・ピリオド・丸括弧・アポストロフィ・アンパサンドも外した。
 * 引用符を付けても意味は変わらず、パーサ差 (フロースタイル・タグ解釈) の
 * リスクだけが減る。
 */
const YAML_PLAIN_SAFE = /^[A-Za-z][A-Za-z0-9 _-]*$/;

/**
 * 上のホワイトリストを通っても **型が変わってしまう** 予約語 (B3 2026-08-03)。
 *
 * 実 YAML パーサは `style: true` を真偽値、`mood: null` を null として読む。
 * このシリアライザの入力は全て string | number なので、**string は必ず
 * string として読み戻せる**ことを引用符で保証する。
 *
 * 対象は YAML_PLAIN_SAFE (英字始まり) を通りうる綴りだけ:
 *   - 真偽値: true/false と YAML 1.1 別綴り (yes/no/on/off/y/n)
 *   - null:   null (`~` と空文字は英字始まりでないので上で既に落ちる)
 *   - 非数:   .inf / .nan は先頭がピリオドなのでこれも上で落ちる
 *
 * 大文字小文字は問わない (YAML は True/TRUE も真偽値として読む)。
 */
const YAML_RESERVED_WORD = /^(?:true|false|yes|no|on|off|y|n|null)$/i;

function yamlScalar(value: string | number): string {
  // number は「数値として読み戻ってほしい」ので素で出す (型は変わらない)。
  if (typeof value === "number") return String(value);
  // ホワイトリストに合致し、かつ予約語でないものだけを裸で出す。
  // それ以外は**すべて**ダブルクォートで出す (YAML 1.2 のダブルクォート
  // スタイルは JSON エスケープ互換なので常に valid かつ必ず string で戻る)。
  if (YAML_PLAIN_SAFE.test(value) && !YAML_RESERVED_WORD.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * PromptJson を YAML 文字列にする (書き出し専用・パースはしない)。
 * - キー順は Object.entries の挿入順 (build 側の組み立て順) を保つ
 * - undefined / null / 空配列のキーは出さない
 * - 配列 (references / timeline) はブロックシーケンス:
 *     timeline:
 *       - time: 0-2s
 *         action: "..."
 * - キーが1つも無ければ空文字を返す (stringifyPromptJson と同じ契約)
 */
export function stringifyPromptYaml(
  json: ImagePromptJson | VideoPromptJson,
): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(json)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        // references / timeline の要素はどちらも浅いオブジェクト。
        // 空文字の項目は JSON 側と同様に落とす。
        const entries = Object.entries(item as Record<string, unknown>).filter(
          (pair): pair is [string, string] =>
            typeof pair[1] === "string" && pair[1].length > 0,
        );
        let first = true;
        for (const [k, v] of entries) {
          lines.push(`${first ? "  - " : "    "}${k}: ${yamlScalar(v)}`);
          first = false;
        }
      }
      continue;
    }

    if (typeof value === "string" || typeof value === "number") {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }

  return lines.join("\n");
}

/** 選択形式でシリアライズする。json は stringifyPromptJson (2-space indent) に委譲。 */
export function stringifyPromptByFormat(
  json: ImagePromptJson | VideoPromptJson,
  format: PromptFormat,
): string {
  return format === "yaml"
    ? stringifyPromptYaml(json)
    : stringifyPromptJson(json);
}

/**
 * timeline の検証: 要素は { time: 非空string } 必須、action / camera は
 * 非空 string のときだけ残す。不正要素は捨てる。最大 12 件で切る。
 * 生き残り 0 件なら undefined (キーごと落とす)。
 */
export function sanitizeTimeline(
  value: unknown,
): VideoTimelineEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries: VideoTimelineEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const time = typeof item.time === "string" ? item.time.trim() : "";
    if (!time) continue;

    const entry: VideoTimelineEntry = { time };
    if (typeof item.action === "string" && item.action.trim()) {
      entry.action = item.action.trim();
    }
    if (typeof item.camera === "string" && item.camera.trim()) {
      entry.camera = item.camera.trim();
    }
    entries.push(entry);
    if (entries.length >= 12) break;
  }

  return entries.length > 0 ? entries : undefined;
}

/** references の要素は {slot: 非空string, note?: 非空string} のみ残す。 */
function sanitizeReferences(
  value: unknown,
): { slot: string; note?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const refs: { slot: string; note?: string }[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const slot = typeof item.slot === "string" ? item.slot.trim() : "";
    if (!slot) continue;
    const note = typeof item.note === "string" ? item.note.trim() : "";
    refs.push(note ? { slot, note } : { slot });
  }

  return refs.length > 0 ? refs : undefined;
}

/**
 * LLM 出力 (または手貼り JSON) を許可キーだけに濾す。
 * - 非オブジェクト / 配列トップレベルは null (整形失敗扱い)
 * - 値の型検証: duration_seconds → 正の有限数のみ採用。
 *   timeline → sanitizeTimeline。references → {slot: string, note?: string}
 *   の形の要素のみ残す。その他キー → 非空 string のみ採用。
 * - 生き残りキーが 0 なら null
 *
 * テキスト経路は入力がテキストなので keepSubsetOfInput (入力キーの部分集合検証)
 * が構造的に使えない。代わりにキー集合を固定してガードする。
 */
export function keepAllowedKeys<T extends object>(
  output: unknown,
  allowed: readonly string[],
): T | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;

  const allowedSet = new Set(allowed);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (!allowedSet.has(key)) continue;
    if (value === undefined || value === null) continue;

    if (key === "duration_seconds") {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        result[key] = value;
      }
      continue;
    }
    if (key === "timeline") {
      const timeline = sanitizeTimeline(value);
      if (timeline) result[key] = timeline;
      continue;
    }
    if (key === "references") {
      const refs = sanitizeReferences(value);
      if (refs) result[key] = refs;
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      result[key] = value.trim();
    }
  }

  if (Object.keys(result).length === 0) return null;
  return result as T;
}
