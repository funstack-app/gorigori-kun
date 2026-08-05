import { images, type FileSizeEntry } from "./ipc";
import { useToasts } from "./store/toasts";

/**
 * 添付画像の合計サイズの事前ガード (7zf / 2026-08-03)。
 *
 * ## なぜ要るか
 *
 * NRC さん報告 (2026-07-31): ストーリー生成で API の入力上限 512MB を超え、
 * 送信してから初めて英語のエラーで落ちた。送る前には何の目安も出ていないため、
 * ユーザーには「なぜ失敗したか」も「どうすれば通るか」も分からない。
 *
 * ## 設計の要点
 *
 * - **ブロックは送信ファネル1点** (usePlanChat.send)。企画タブもゴールチャットも
 *   ここへ合流するので、1箇所で全経路を塞げる。
 * - **fail-open**: サイズが取れない画像や ipc 自体の失敗では送信を止めない。
 *   検査基盤の故障でユーザーの操作を止めるのは、従来より悪い体験になる。
 * - 自動リサイズはしない。「勝手に画質を落とした」という別の不信を生むため、
 *   検査と案内に留めて判断はユーザーに委ねる。
 */

/** API 側の入力合計上限 (実測: NRC 2026-07-31 のエラー)。表示用。 */
export const API_TOTAL_LIMIT_MB = 512;

/**
 * 送信をブロックする生バイト合計。
 * localImage は転送時に base64 相当 (約4/3倍) へ膨らむため、512MB より低く置く。
 * 380MB × 4/3 ≒ 507MB で上限直下。512 を生バイトで判定すると
 * 「ガードを通ったのに API で死ぬ」偽陰性が出る。
 */
export const MAX_TOTAL_IMAGE_BYTES = 380 * 1024 * 1024;

/** 添付時に警告を出し始める合計 (ブロックの約半分)。 */
export const WARN_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export type ImagePayloadMeasurement = {
  totalBytes: number;
  entries: FileSizeEntry[];
  /** サイズを取得できなかったパス (合計には 0 として算入)。 */
  unknown: string[];
};

/** 添付画像の合計バイト数を測る。取得不能なパスは unknown に分離する。 */
export async function measureImagePayload(paths: string[]): Promise<ImagePayloadMeasurement> {
  const entries = await images.fileSizes(paths);
  let totalBytes = 0;
  const unknown: string[] = [];
  for (const entry of entries) {
    if (typeof entry.size === "number") totalBytes += entry.size;
    else unknown.push(entry.path);
  }
  return { totalBytes, entries, unknown };
}

/**
 * 送信前のブロック検査。送ってよければ true。
 *
 * 検査自体が失敗した場合は true を返す (fail-open)。
 */
export async function guardImagePayloadForSend(paths: string[]): Promise<boolean> {
  try {
    const { totalBytes, entries } = await measureImagePayload(paths);
    if (totalBytes <= MAX_TOTAL_IMAGE_BYTES) return true;
    const top = entries
      .filter((e): e is FileSizeEntry & { size: number } => typeof e.size === "number")
      .sort((a, b) => b.size - a.size)
      .slice(0, 3)
      .map((e) => `${basename(e.path)} (${toMb(e.size)} MB)`)
      .join("、");
    useToasts.getState().push({
      kind: "error",
      text: `添付画像の合計サイズが大きすぎるため送信できません（合計 ${toMb(totalBytes)} MB）。\n送信できる合計はおよそ 380 MB までです（送信時の変換で API の上限 ${API_TOTAL_LIMIT_MB} MB に達するため）。\n大きい画像: ${top}。画像を減らすか、小さくしてから送信してください。`,
      ttlMs: 10000,
    });
    return false;
  } catch (error) {
    // 検査基盤の故障で送信を止めない (fail-open)。従来と同じ挙動に落ちるだけ。
    console.warn("[imagePayloadGuard] size check failed; allowing send", error);
    return true;
  }
}

// ──────────── 添付の入口ガード (貼り付け / ドロップ / ファイル選択) ────────────

/**
 * 1 度の操作で受け付ける最大枚数。
 *
 * 上の合計バイト数とは別軸の柵。小さい画像でも 50 枚一括で投げられると、
 * 添付チップのデコードとプレビュー保持でメモリを食う。枚数の暴投を先に弾く。
 */
export const MAX_ATTACH_COUNT = 20;

/**
 * 1 枚あたりの警告しきい値。
 *
 * 合計は下回っていても、1 枚が極端に大きいと処理中の一時メモリが跳ねる。
 * ブロックはせず「重い」ことを知らせる（判断はユーザーに委ねる方針を踏襲）。
 */
export const WARN_SINGLE_FILE_BYTES = 80 * 1024 * 1024;

export type AttachIntakeDecision = {
  /** 受け付けてよいか。false なら 1 枚も取り込まない。 */
  accepted: boolean;
  /** 拒否・警告の理由文（3 点書式）。問題なしなら null。 */
  message: string | null;
  /** message の重み。accepted=false は必ず "error"。 */
  kind: "error" | "warn";
};

/**
 * 添付を **受け付ける前に** 枚数と合計サイズを検査する（純関数）。
 *
 * ## なぜ入口で見るか
 *
 * 既存の `guardImagePayloadForSend` は送信ファネル 1 点でしか効かない。
 * 2026-08-05 のクラッシュは **貼り付けの最中**に起きており、送信までたどり着いて
 * いない。したがって送信ガードでは構造的に防げない。ここで受け付ける前に弾く。
 *
 * ## 判定の順序
 *
 * 1. 枚数超過 → 拒否（合計サイズを測るまでもない）
 * 2. 合計超過 → 拒否
 * 3. 単体が巨大 → 受け付けるが警告
 *
 * @param sizes 取り込もうとしているファイルのバイト数。取得できないものは含めない
 * @param existingBytes 既に添付済みの合計バイト数（0 でよい）
 * @param existingCount 既に添付済みの枚数（0 でよい）
 */
export function evaluateAttachIntake(
  sizes: number[],
  existingBytes = 0,
  existingCount = 0,
): AttachIntakeDecision {
  const totalCount = existingCount + sizes.length;
  if (totalCount > MAX_ATTACH_COUNT) {
    return {
      accepted: false,
      kind: "error",
      message:
        `一度に添付できるのは ${MAX_ATTACH_COUNT} 枚までです（今回 ${totalCount} 枚）。\n` +
        `枚数が多いとアプリが不安定になるため、受け付ける前に止めています。\n` +
        `枚数を減らして、もう一度お試しください。`,
    };
  }

  const incoming = sizes.reduce((sum, size) => sum + size, 0);
  const total = existingBytes + incoming;
  if (total > MAX_TOTAL_IMAGE_BYTES) {
    return {
      accepted: false,
      kind: "error",
      message:
        `添付画像の合計サイズが大きすぎます（合計 ${toMb(total)} MB）。\n` +
        `受け付けられる合計はおよそ ${toMb(MAX_TOTAL_IMAGE_BYTES)} MB までです。\n` +
        `画像を減らすか、小さくしてから添付してください。`,
    };
  }

  const largest = sizes.reduce((max, size) => (size > max ? size : max), 0);
  if (largest > WARN_SINGLE_FILE_BYTES) {
    return {
      accepted: true,
      kind: "warn",
      message:
        `とても大きな画像が含まれています（最大 ${toMb(largest)} MB）。\n` +
        `読み込みに時間がかかり、動作が重くなることがあります。\n` +
        `重いと感じたら、小さくしてから添付し直してください。`,
    };
  }

  if (total > WARN_TOTAL_IMAGE_BYTES) {
    return {
      accepted: true,
      kind: "warn",
      message:
        `添付画像の合計が ${toMb(total)} MB になりました。\n` +
        `合計およそ ${toMb(MAX_TOTAL_IMAGE_BYTES)} MB を超えると添付できません。\n` +
        `これ以上増やす場合は、画像を小さくすることをおすすめします。`,
    };
  }

  return { accepted: true, kind: "warn", message: null };
}

/**
 * `evaluateAttachIntake` を実行し、必要ならトーストを出す。
 *
 * @returns 受け付けてよければ true
 */
export function guardAttachIntake(
  sizes: number[],
  existingBytes = 0,
  existingCount = 0,
): boolean {
  const decision = evaluateAttachIntake(sizes, existingBytes, existingCount);
  if (decision.message) {
    useToasts.getState().push({
      kind: decision.kind,
      text: decision.message,
      ttlMs: decision.accepted ? 6000 : 10000,
    });
  }
  return decision.accepted;
}

/** 同じ MB 値で連続警告しないための去重。 */
let lastWarnedMb: number | null = null;

/**
 * 添付時の非ブロック警告 (fire-and-forget)。
 * 送信を止めないので await しない前提で呼んでよい。
 */
export function warnImagePayloadInBackground(paths: string[]): void {
  if (paths.length === 0) {
    lastWarnedMb = null;
    return;
  }
  void (async () => {
    try {
      const { totalBytes } = await measureImagePayload(paths);
      if (totalBytes <= WARN_TOTAL_IMAGE_BYTES) {
        lastWarnedMb = null;
        return;
      }
      const mb = toMb(totalBytes);
      if (lastWarnedMb === mb) return;
      lastWarnedMb = mb;
      useToasts.getState().push({
        kind: "warn",
        text: `添付画像の合計が ${mb} MB になっています。合計およそ 380 MB を超えると送信できません。`,
        ttlMs: 6000,
      });
    } catch (error) {
      console.warn("[imagePayloadGuard] background size check failed", error);
    }
  })();
}
