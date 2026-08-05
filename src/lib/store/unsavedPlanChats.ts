import { create } from "zustand";

import { createPersistGuard, describeOutcome } from "./persistGuard";
import type { ProjectChatMessage } from "./projects";

/**
 * 「保存しない」企画チャットの自動退避 (29z 2026-08-03)。
 *
 * comicStoryHistory.ts と同型の plugin-store 方式の別ファイル。
 * プロジェクト未選択 (activeProjectId === null) のまま進めた企画チャットは
 * 従来メモリのみで、再起動・クラッシュで全損していた。turn/completed ごとに
 * ここへ自動退避し、チャット履歴ページから開き直せるようにする。
 *
 * 寿命は「最新5件・最終更新から7日」。プロジェクト正本 (projects.json) には
 * 書かない (ユーザーが「保存しない」を選んだ意思を壊さないため)。
 * 保存失敗はトーストを出さない (自動保存が作業を邪魔しない。console.warn のみ)。
 */

const STORE_FILE = "plan-chat-unsaved.json";
const STORE_KEY = "items";
/** 保持する未保存チャットの上限。超えた分は updatedAt が古い順に落とす。 */
const MAX_ITEMS = 5;
/** 最終更新からこの時間を超えたエントリは prune で落とす (7日)。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type UnsavedPlanChat = {
  id: string;
  /** 最初の user メッセージ先頭40字。無ければ「（企画チャット）」。 */
  title: string;
  messages: ProjectChatMessage[];
  createdAt: number;
  updatedAt: number;
};

type State = {
  items: UnsavedPlanChat[];
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * 未保存チャットを追加/更新する。id 未指定なら発番して先頭に追加、
   * 指定ありなら該当エントリを更新して先頭へ。
   *
   * 戻り値は `{ id, created }` (messages が空なら何もせず
   * `{ id: 渡された id か空文字, created: false }`)。
   *
   * **created を返す理由 (B2 2026-08-03)**: 呼び出し側 (planChat.ts) は
   * 「upsert の await 中に画面側の紐づけが変わった」ときに、遅れて出来た
   * エントリを掃除する。このとき *新規に作られた* エントリだけを消さないと、
   * 既存エントリ (7日間の安全網) まで巻き添えで消える。id だけでは
   * 「新規発番されたのか、既存を更新しただけなのか」が区別できない。
   */
  upsert: (
    id: string | undefined,
    messages: ProjectChatMessage[],
  ) => Promise<{ id: string; created: boolean }>;
  remove: (id: string) => Promise<void>;
};

/** 「読めなければ書かない」を担保する共有ガード (W0)。parse は normalize が担う。 */
const guard = createPersistGuard<UnsavedPlanChat[]>({
  name: "unsavedPlanChats",
  file: STORE_FILE,
  key: STORE_KEY,
  parse: (raw) => parseChats(raw),
});

/**
 * 保存する。読込が未確定 / 失敗中なら **書かずに false** を返す
 * (自動退避なのでトーストは出さない。console.warn は guard 側で出る)。
 */
async function persist(items: UnsavedPlanChat[]): Promise<boolean> {
  return guard.save(items);
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `u_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/**
 * 最初の user メッセージ先頭40字をタイトルにする。
 *
 * g8t (2026-08-04) で export した。企画タブの昇格バンド (PlanWorkspace) が
 * 案件名のプリフィルに使う。履歴ページの未保存行タイトルと同じ規則にすることで
 * 「履歴で見ていた名前がそのまま案件名候補になる」= 命名規則の正本を1つに保つ。
 */
export function deriveTitle(messages: ProjectChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.text.trim());
  const text = firstUser?.text.trim() ?? "";
  if (!text) return "（企画チャット）";
  return text.slice(0, 40);
}

/**
 * TTL 超過を落とし、updatedAt 降順で MAX_ITEMS 件に切り詰める (決定論)。
 * load / upsert の両方で通す。
 */
function prune(items: UnsavedPlanChat[]): UnsavedPlanChat[] {
  const now = Date.now();
  return items
    .filter((it) => now - it.updatedAt <= TTL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ITEMS);
}

/**
 * 保存済み JSON を型に合わせて検証する (persistGuard の parse)。
 *
 * **形が壊れていたら捨てずに invalid を返す** (2026-08-06 / DL-14)。
 * 未保存チャットは「保存しない」を選んだ作業の唯一の安全網なので、読めない
 * ものを黙って捨てた状態を次の upsert で正本にしてはいけない。
 *
 * ただし「id はあるが messages が空」等の**内容として空**のエントリは、
 * 壊れているのではなく単に無価値なので従来どおり畳む (書き込み封鎖はしない)。
 */
function parseChats(
  raw: unknown,
): { ok: true; value: UnsavedPlanChat[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "配列ではありません" };
  const seen = new Set<string>();
  const items: UnsavedPlanChat[] = [];
  for (const it of raw as UnsavedPlanChat[]) {
    if (!it || typeof it.id !== "string" || !it.id) {
      return { ok: false, reason: "id を持たない要素があります" };
    }
    if (it.messages !== undefined && !Array.isArray(it.messages)) {
      return { ok: false, reason: "messages が配列でない要素があります" };
    }
    if (seen.has(it.id)) continue;
    if (!Array.isArray(it.messages) || it.messages.length === 0) continue;
    seen.add(it.id);
    const messages = it.messages.filter(
      (m): m is ProjectChatMessage =>
        !!m && typeof m.id === "string" && typeof m.text === "string",
    );
    if (messages.length === 0) continue;
    const updatedAt = typeof it.updatedAt === "number" ? it.updatedAt : Date.now();
    items.push({
      id: it.id,
      title: typeof it.title === "string" && it.title ? it.title : deriveTitle(messages),
      messages,
      createdAt: typeof it.createdAt === "number" ? it.createdAt : updatedAt,
      updatedAt,
    });
  }
  return { ok: true, value: items };
}

export const useUnsavedPlanChats = create<State>((set, get) => ({
  items: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    const outcome = await guard.load();
    if (outcome.status === "ok") {
      const normalized = outcome.value;
      const items = prune(normalized);
      set({ items, loaded: true });
      // TTL/件数で落ちた分をディスクにも反映する (次回起動で復活させない)。
      if (items.length !== normalized.length) await persist(items);
      return;
    }
    if (outcome.status !== "absent") {
      // 読めなかった。画面は空のままだが、guard が書き込みを封鎖しているので
      // この空が次の upsert で既存の退避を潰すことはない (DL-14 の核心)。
      console.warn(`[unsavedPlanChats] ${describeOutcome(outcome)}`);
    }
    set({ loaded: true });
  },

  upsert: async (id, messages) => {
    // 起動直後 (load 未完了) の書き込みでディスクの既存台帳を空配列基準で
    // 上書きしないよう、必ず先に読み込む (load は loaded ガード付きで冪等)。
    if (!get().loaded) await get().load();
    if (messages.length === 0) return { id: id ?? "", created: false };
    const now = Date.now();
    const entryId = id ?? uid();
    let next: UnsavedPlanChat[] = [];
    // 「台帳に無い id を新規として作った」かどうか。id 未指定の発番はもちろん、
    // id 指定でも台帳側に実体が無ければ (TTL/件数で落ちた後など) 新規作成になる。
    let created = false;
    set((s) => {
      const existing = s.items.find((i) => i.id === entryId);
      created = !existing;
      const entry: UnsavedPlanChat = {
        id: entryId,
        title: deriveTitle(messages),
        messages,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      next = prune([entry, ...s.items.filter((i) => i.id !== entryId)]);
      return { items: next };
    });
    await persist(next);
    return { id: entryId, created };
  },

  remove: async (id) => {
    // upsert と同じ理由。load 前の削除でディスクの台帳を消し飛ばさない。
    if (!get().loaded) await get().load();
    let next: UnsavedPlanChat[] = [];
    set((s) => {
      next = s.items.filter((i) => i.id !== id);
      return { items: next };
    });
    await persist(next);
  },
}));
