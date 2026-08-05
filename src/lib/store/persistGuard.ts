/**
 * 「読めなければ書かない」を全ストアで共有するための最小ラッパ (W0 / 2026-08-06)。
 *
 * ## なぜ要るか
 *
 * presets.ts が 2026-07-30〜08-06 の実害 (実ユーザーのプリセット30体消失) を経て
 * 確立した不変条件が、他のストアへ横展開されていなかった。同じ型の穴が
 * savedPrompts / worldContexts / settings / errorLog / comicStoryHistory /
 * unsavedPlanChats / images(favorites,judgements) / referenceRoles に転移している
 * (Sol 監査 DL-05〜DL-16)。
 *
 * 転移した穴はどれも同じ形をしている:
 *
 * ```ts
 * try {
 *   const raw = await store.get(KEY) ?? [];   // ← 読めた 0 件と読めなかったを混同
 *   set({ items: normalize(raw), loaded: true });
 * } catch {
 *   set({ loaded: true });                    // ← 読めなかったのに「空で読み終えた」
 * }
 * // …次の mutate が、その空を基準にディスクの既存台帳を上書きする
 * ```
 *
 * ## この module が提供する不変条件
 *
 * 1. **読込は 4 値**: `ok` / `absent` / `invalid` / `ioError`。
 *    「読めた 0 件」と「読めなかった」を型で区別する。
 * 2. **書込み封鎖**: 書いてよいのは `ok` と `absent` のときだけ。
 *    `invalid` / `ioError` の間は **1 バイトも書かない**
 *    (読めない正本を、空になった画面の内容で潰さない)。
 * 3. **保存の成否を返す**: `save()` は `Promise<boolean>`。握り潰さない。
 *    呼び出し側は「保存できたか」で成功トースト・画面反映を分岐できる。
 *
 * ## presets.ts / scene3d.ts / motionStore.ts を置換しない理由
 *
 * この 3 つは Rust 側の専用コマンド (`presets_read` / `presets_write` 等) を使い、
 * 世代バックアップ・空上書きガード・保存先切替の所有権トークン・localStorage 冗長
 * バックアップという固有の機構を既に持っている。しかも先行ワーカー (S/T/U/V) が
 * 直したばかりで実害の再発防止テストも付いている。同じ不変条件を**既に満たしている**
 * ものを共通ラッパへ寄せ替えるのは、利得ゼロで退行リスクだけがある取引なので行わない。
 * 本 module の対象は plugin-store 系 (`@tauri-apps/plugin-store`) のストア群に絞る。
 */

/** 読込結果の 4 値。`ok` 以外は「値が無い」ではなく「状態が違う」ことを表す。 */
export type LoadOutcome<T> =
  /** 正常に読めた。`value` が正本の内容 (0 件の空配列もここに入る)。 */
  | { status: "ok"; value: T }
  /** ファイル/キーがまだ存在しない。初回起動・移行前。**書いてよい**。 */
  | { status: "absent" }
  /** 読めたが形が壊れている (手編集・部分書き込み)。**書いてはいけない**。 */
  | { status: "invalid"; reason: string }
  /** I/O 自体が失敗した (権限・ディスク・Tauri 外)。**書いてはいけない**。 */
  | { status: "ioError"; error: unknown };

/** 読込結果が「以後の書き込みを解禁してよい」状態か。`ok` と `absent` だけ true。 */
export function canWriteAfter<T>(outcome: LoadOutcome<T>): boolean {
  return outcome.status === "ok" || outcome.status === "absent";
}

/** ログ・トースト用の短い説明。`status` をそのまま人に見せないための橋渡し。 */
export function describeOutcome<T>(outcome: LoadOutcome<T>): string {
  switch (outcome.status) {
    case "ok":
      return "読み込み成功";
    case "absent":
      return "未作成 (新規)";
    case "invalid":
      return `内容が不正: ${outcome.reason}`;
    case "ioError":
      return `読み出し失敗: ${String(outcome.error)}`;
  }
}

/**
 * `@tauri-apps/plugin-store` の最小インターフェース。
 * 実体 (`Store`) に依存すると、テストで型を満たすためだけに未使用 API の
 * スタブを書く羽目になるため、使う 3 メソッドだけを構造的に要求する。
 */
export type KeyValueStore = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

/** `createPersistGuard` の設定。 */
export type PersistGuardOptions<T> = {
  /** ログに出す識別名 (例: "savedPrompts")。 */
  name: string;
  /** plugin-store のファイル名 (例: "prompts.json")。 */
  file: string;
  /** 値を格納するキー (例: "items")。 */
  key: string;
  /**
   * 生の JSON を検証して正規化する。
   *
   * - 妥当なら `{ ok: true, value }`
   * - 壊れているなら `{ ok: false, reason }` → **`invalid` になり書込みが封鎖される**
   *
   * 「壊れた要素を黙って捨てて残りを返す」実装にすると、この guard の意味が消える
   * (捨てた状態が次の保存で正本になる)。捨てるなら invalid として封鎖するか、
   * 呼び出し側で明示的に隔離してから ok を返すこと。
   */
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; reason: string };
  /**
   * テスト・DI 用の store ローダ。省略時は `@tauri-apps/plugin-store` を動的 import する。
   * 解決に失敗したら `null` を返すこと (= `ioError` 扱いになる)。
   */
  loadStore?: () => Promise<KeyValueStore | null>;
};

/** `createPersistGuard` の戻り値。 */
export type PersistGuard<T> = {
  /**
   * 正本を読む。呼ぶたびに実際に読みにいく (キャッシュしない)。
   * 結果の `status` に応じて内部の書込み解禁状態も更新する。
   */
  load: () => Promise<LoadOutcome<T>>;
  /**
   * 保存する。**未解禁 (読込が `invalid` / `ioError` / 未実行) なら書かずに false を返す**。
   * 書けたら true。I/O が失敗しても throw せず false を返す
   * (呼び出し側が成功トーストを抑止できるようにするため)。
   */
  save: (value: T) => Promise<boolean>;
  /** 現在書込みが解禁されているか (テスト・UI の状態表示用)。 */
  canWrite: () => boolean;
  /**
   * 読込が一度でも決着したか (成否を問わない)。
   * 「まだ読み込み中」と「読めなかった」を区別する必要がある画面で使う。
   */
  isDecided: () => boolean;
  /**
   * ユーザーが明示的に「この内容で上書きする」と決めた操作 (バックアップ復元) のために
   * 書込みを強制解禁する。
   *
   * なぜ必要か: 正本が壊れている (`invalid`) ときこそ復元が要る。そこを塞ぐと
   * 「復元がいちばん必要な場面で復元できない」矛盾になる (presets.ts の
   * restoreFromBackup と同じ判断。Codex 検分 2026-07-30)。
   *
   * **読込がまだ決着していない間は解禁しない** (false を返す)。読み込み中の解禁は
   * 「復元しました」と出るのに直後の読込結果で潰される最悪の見え方になる。
   */
  unlockForExplicitOverwrite: () => boolean;
};

/**
 * plugin-store 上の 1 キーに対する「読めなければ書かない」ラッパを作る。
 *
 * 生成した guard はモジュールスコープに 1 つ置いて使い回す
 * (mutate のたびに作ると解禁状態がリセットされ、封鎖が効かなくなる)。
 */
export function createPersistGuard<T>(options: PersistGuardOptions<T>): PersistGuard<T> {
  const { name, file, key, parse } = options;

  /** 書込み解禁フラグ。`ok` / `absent` を読めたときだけ true になる。 */
  let writeUnlocked = false;
  /** 読込が決着したか (成否問わず)。 */
  let decided = false;

  let storePromise: Promise<KeyValueStore | null> | null = null;

  const defaultLoadStore = async (): Promise<KeyValueStore | null> => {
    const { load } = await import("@tauri-apps/plugin-store");
    return (await load(file, { defaults: {}, autoSave: true })) as KeyValueStore;
  };

  const resolveStore = (): Promise<KeyValueStore | null> => {
    if (storePromise) return storePromise;
    storePromise = (options.loadStore ?? defaultLoadStore)().catch((err) => {
      console.warn(`[${name}] ストアを開けませんでした`, err);
      return null;
    });
    return storePromise;
  };

  return {
    load: async (): Promise<LoadOutcome<T>> => {
      const outcome = await readOutcome();
      decided = true;
      // 解禁は「一度でも読めた」で決める。読めなかった読込が、既に解禁済みの
      // 状態を後から取り消すことはしない (再読込の一時的失敗で保存が止まらないように)。
      if (canWriteAfter(outcome)) writeUnlocked = true;
      if (!canWriteAfter(outcome)) {
        console.warn(`[${name}] ${describeOutcome(outcome)} — 書き込みを封鎖します`);
      }
      return outcome;
    },

    save: async (value: T): Promise<boolean> => {
      if (!writeUnlocked) {
        // ここが本 module の核心。読めていない正本を、空になった画面の内容で
        // 上書きする経路を**構造的に**塞ぐ。
        console.warn(`[${name}] 読み込み未確定のため保存を中止しました`);
        return false;
      }
      const store = await resolveStore();
      if (!store) return false;
      try {
        await store.set(key, value);
        await store.save();
        return true;
      } catch (err) {
        console.warn(`[${name}] 保存に失敗しました`, err);
        return false;
      }
    },

    canWrite: () => writeUnlocked,
    isDecided: () => decided,

    unlockForExplicitOverwrite: () => {
      if (!decided) return false;
      writeUnlocked = true;
      return true;
    },
  };

  /** 実際の読み出し + 検証。解禁判断は呼び出し側 (`load`) が行う。 */
  async function readOutcome(): Promise<LoadOutcome<T>> {
    const store = await resolveStore();
    if (!store) return { status: "ioError", error: new Error("store unavailable") };
    let raw: unknown;
    try {
      raw = await store.get(key);
    } catch (err) {
      return { status: "ioError", error: err };
    }
    // plugin-store はキー未作成で undefined を返す。null も未作成と同義に扱う
    // (旧バージョンが null を書いた台帳との後方互換)。
    if (raw === undefined || raw === null) return { status: "absent" };
    const parsed = parse(raw);
    if (!parsed.ok) return { status: "invalid", reason: parsed.reason };
    return { status: "ok", value: parsed.value };
  }
}
