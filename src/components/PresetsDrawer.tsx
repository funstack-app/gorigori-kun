import { useEffect, useMemo, useState } from "react";

import { PresetCard } from "./PresetCard";
import { CharacterIcon } from "./SkillIcon";
import { PresetThumbnailFocusModal } from "./PresetThumbnailFocus";
import { SafeImage } from "./SafeImage";
import { extractDropped, fileToUploadReference, isImageDrop } from "../lib/dragRef";
import { sendCharacterPresetToSheetRegenerate } from "../lib/character/sendImageToCharacterRegister";
import {
  focusToImageStyle,
  presetKind,
  sortPresets,
  usePresets,
  CHARACTER_CATEGORY_ID,
  type Preset,
  type PresetCategory,
  type SortKey,
  type ThumbnailFocus,
} from "../lib/store/presets";

const DEFAULT_NEW_CATEGORY_COLOR = "#6366f1";
const CATEGORY_COLOR_OPTIONS = [
  "#ec4899",
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#06b6d4",
  "#a855f7",
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "updatedDesc", label: "更新日 ↓" },
  { key: "updatedAsc", label: "更新日 ↑" },
  { key: "createdDesc", label: "作成日 ↓" },
  { key: "createdAsc", label: "作成日 ↑" },
  { key: "nameAsc", label: "名前 A→Z" },
  { key: "nameDesc", label: "名前 Z→A" },
  { key: "tagCountDesc", label: "タグ数 ↓" },
];

/**
 * プリセット管理画面。サイドバー版（fullPage=false、デフォルト）とページ版（fullPage=true）を
 * 同じコンポーネントで切り替える。
 *
 * - サイドバー版: 縦に積む（カテゴリ一覧 → プリセット一覧）。狭い領域向け
 * - ページ版: 2 カラム（左 = カテゴリ縦リスト / 右 = 検索 + カードグリッド）
 *
 * Why: 検索性と一覧性を最大化したい場面はページ版で、ピンポイントで触りたい
 * ときだけサイドバー版という使い分け。Midjourney Code Manager のサイドパネル
 * 体験をベースに、PC アプリの広い画面に合わせて拡張している。
 */
export function PresetsDrawer({
  fullPage = false,
  onNavigateToSkill,
}: {
  fullPage?: boolean;
  /**
   * 別スキル画面へ送り込んだ直後に呼ぶ。プリセット画面 (ドロワー / ページ版)
   * を閉じて、送り先が実際に見える状態にする。SkillsWorkspace の
   * onUseSkill と同じ役割。
   */
  onNavigateToSkill?: () => void;
}) {
  const categories = usePresets((s) => s.categories);
  const presets = usePresets((s) => s.presets);
  const addCategory = usePresets((s) => s.addCategory);
  const removeCategory = usePresets((s) => s.removeCategory);
  const updateCategory = usePresets((s) => s.updateCategory);
  const addPreset = usePresets((s) => s.addPreset);
  const updatePreset = usePresets((s) => s.updatePreset);
  const removePreset = usePresets((s) => s.removePreset);
  const toggleFavorite = usePresets((s) => s.toggleFavorite);
  const reorderPresets = usePresets((s) => s.reorderPresets);
  const [dragId, setDragId] = useState<string | null>(null);

  /*
   * 初期表示カテゴリ。
   *
   * 2026-07-25 修正: 「キャラクター」カテゴリを新設して DEFAULT_CATEGORIES の
   * 先頭に置いたため、categories[0] のままだと引き出しを開いた瞬間に
   * 空のキャラクタータブが出て「プリセットが全部消えた」ように見えていた。
   * さらにその状態で普通のプロンプトプリセットを登録すると、下の
   * `categoryId: activeCategoryId` でキャラの箱に混ざる
   * (カテゴリを分けた目的の正反対)。
   * → 初期表示は **キャラクター以外の先頭** にする。
   */
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(
    categories.find((c) => c.id !== CHARACTER_CATEGORY_ID)?.id ??
      categories[0]?.id ??
      null,
  );
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>("");
  const [draftPrompt, setDraftPrompt] = useState<string>("");
  const [draftDescription, setDraftDescription] = useState<string>("");
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftThumbnail, setDraftThumbnail] = useState<string | undefined>(undefined);
  const [draftThumbnailFocus, setDraftThumbnailFocus] = useState<ThumbnailFocus | undefined>(undefined);
  /**
   * STΛCK 報告 (2026-05-19): プリセット編集モーダルで attachedImages (キャラ画像)
   * を表示・編集できなかったため、保存済みでも見えない状態だった。
   * draftAttachedImages で保持して編集UIに反映する。
   */
  const [draftAttachedImages, setDraftAttachedImages] = useState<string[]>([]);
  /**
   * 編集中プリセットの種別と characterMeta を保持する。
   * kind === "character" のとき、属性 textarea を出し、保存時は characterMeta を
   * 維持したまま attributes だけ更新する（kind/他フィールドを黙って落とさない）。
   */
  const [draftKind, setDraftKind] = useState<"prompt" | "character">("prompt");
  const [draftCharacterMeta, setDraftCharacterMeta] = useState<
    Preset["characterMeta"] | undefined
  >(undefined);
  const [draftCharacterAttributes, setDraftCharacterAttributes] = useState<string>("");
  const [newCategoryName, setNewCategoryName] = useState<string>("");
  const [newCategoryColor, setNewCategoryColor] = useState<string>(DEFAULT_NEW_CATEGORY_COLOR);
  const [query, setQuery] = useState<string>("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sortKey, setSortKey] = useState<SortKey>("updatedDesc");
  /** キャラ絞り込み。true のときは kind === "character" のプリセットだけ表示。 */
  const [characterOnly, setCharacterOnly] = useState<boolean>(false);

  const visiblePresets = useMemo<Preset[]>(() => {
    const inCategory = presets.filter((p) => p.categoryId === activeCategoryId);
    const kindFiltered = characterOnly
      ? inCategory.filter((p) => presetKind(p) === "character")
      : inCategory;
    const q = query.trim().toLowerCase();
    const searched = q
      ? kindFiltered.filter((p) =>
          `${p.name} ${p.prompt} ${p.description ?? ""} ${p.characterMeta?.attributes ?? ""}`
            .toLowerCase()
            .includes(q),
        )
      : kindFiltered;
    return sortPresets(searched, sortKey);
  }, [presets, activeCategoryId, query, sortKey, characterOnly]);

  const startNew = () => {
    setEditingPresetId("__new__");
    setDraftName("");
    setDraftPrompt("");
    setDraftDescription("");
    setDraftTags([]);
    setDraftThumbnail(undefined);
    setDraftThumbnailFocus(undefined);
    setDraftAttachedImages([]);
    setDraftKind("prompt");
    setDraftCharacterMeta(undefined);
    setDraftCharacterAttributes("");
  };

  const startEdit = (preset: Preset) => {
    setEditingPresetId(preset.id);
    setDraftName(preset.name);
    setDraftPrompt(preset.prompt);
    setDraftDescription(preset.description ?? "");
    setDraftTags(preset.tags ?? []);
    setDraftThumbnail(preset.thumbnail);
    setDraftThumbnailFocus(preset.thumbnailFocus);
    // 保存済みの attachedImages を編集UIに復元
    setDraftAttachedImages(
      preset.attachedImages ? preset.attachedImages.map((a) => a.path) : [],
    );
    // キャラ型なら characterMeta を丸ごと保持し、attributes を編集欄へ復元。
    // 保存時は characterMeta を維持したまま attributes だけ差し替える。
    setDraftKind(presetKind(preset));
    setDraftCharacterMeta(preset.characterMeta);
    setDraftCharacterAttributes(preset.characterMeta?.attributes ?? "");
  };

  const cancelEdit = () => {
    setEditingPresetId(null);
    setDraftName("");
    setDraftPrompt("");
    setDraftDescription("");
    setDraftTags([]);
    setDraftThumbnail(undefined);
    setDraftThumbnailFocus(undefined);
    setDraftAttachedImages([]);
    setDraftKind("prompt");
    setDraftCharacterMeta(undefined);
    setDraftCharacterAttributes("");
  };

  const savePreset = () => {
    const name = draftName.trim();
    const prompt = draftPrompt.trim();
    const attributes = draftCharacterAttributes.trim();
    const isCharacter = draftKind === "character";
    // キャラ型は属性 or プロンプトのどちらかがあれば保存可。
    // プロンプト型は従来どおりプロンプト必須。
    const hasContent = isCharacter ? !!prompt || !!attributes : !!prompt;
    if (!name || !hasContent) return;
    // サムネが無いなら focus は無意味なので落とす
    const focusOnSave = draftThumbnail ? draftThumbnailFocus : undefined;
    const attachedImagesForSave =
      draftAttachedImages.length > 0
        ? draftAttachedImages.map((path) => ({ path, role: "subject" }))
        : undefined;
    // キャラ型のみ characterMeta を更新して渡す。既存の characterMeta
    // (sheetRoles / identityScore / verifiedAt / sourceImage 等) を維持したまま
    // attributes だけ差し替える。空なら attributes を落とす。
    const characterMetaForSave = isCharacter
      ? {
          ...(draftCharacterMeta ?? {}),
          attributes: attributes || undefined,
        }
      : undefined;
    if (editingPresetId === "__new__") {
      addPreset({
        name,
        prompt,
        kind: isCharacter ? "character" : undefined,
        characterMeta: characterMetaForSave,
        description: draftDescription.trim() || undefined,
        // 2026-07-25: 種別とカテゴリを一致させる。
        // キャラ型は必ずキャラクターカテゴリへ。逆に、キャラクターカテゴリを
        // 表示中に「プロンプト型」を登録した場合はキャラの箱に入れない
        // (カテゴリを分けた目的が崩れるため null = 未分類に落とす)。
        categoryId: isCharacter
          ? CHARACTER_CATEGORY_ID
          : activeCategoryId === CHARACTER_CATEGORY_ID
            ? null
            : activeCategoryId,
        tags: draftTags.length > 0 ? draftTags : undefined,
        thumbnail: draftThumbnail,
        thumbnailFocus: focusOnSave,
        attachedImages: attachedImagesForSave,
      });
    } else if (editingPresetId) {
      updatePreset(editingPresetId, {
        name,
        prompt,
        // kind は編集で変えない。characterMeta はキャラ型のときだけ更新する
        // （プロンプト型に characterMeta を書き込まない）。
        ...(isCharacter ? { characterMeta: characterMetaForSave } : {}),
        description: draftDescription.trim() || undefined,
        tags: draftTags.length > 0 ? draftTags : undefined,
        thumbnail: draftThumbnail,
        thumbnailFocus: focusOnSave,
        attachedImages: attachedImagesForSave,
      });
    }
    cancelEdit();
  };

  /**
   * B-5 (2026-07-30): 編集中のキャラ型プリセットをシート作り直しへ送る。
   * 編集内容はここでは preset に保存しない (上書きは作り直し後の「上書き登録」が
   * 唯一の書込点。二重書込にしない)。
   */
  const regenerateSheetFromDraft = () => {
    if (!editingPresetId || editingPresetId === "__new__") return;
    const sourceImage = draftCharacterMeta?.sourceImage;
    if (!sourceImage) return;
    const presetId = editingPresetId;
    const name = draftName.trim() || "キャラ";
    const attributes = draftCharacterAttributes.trim();
    cancelEdit();
    // 送り込みに成功したときだけプリセット画面を閉じる。失敗時 (元画像なし) は
    // エラートーストだけ出して、この画面に留まる。
    // 複数参照で登録されたキャラは全量を復元する (旧データは sourceImage 1 枚)。
    const sourceImages = draftCharacterMeta?.sourceImages;
    if (
      sendCharacterPresetToSheetRegenerate({
        presetId,
        name,
        attributes,
        sourceImage,
        sourceImages,
        sheetBackground: draftCharacterMeta?.sheetBackground,
        sheetPromptMode: draftCharacterMeta?.sheetPromptMode,
        sheetCustomPrompt: draftCharacterMeta?.sheetCustomPrompt,
      })
    ) {
      onNavigateToSkill?.();
    }
  };

  const handleAddCategory = () => {
    const name = newCategoryName.trim();
    if (!name) return;
    const cat = addCategory(name, newCategoryColor);
    setActiveCategoryId(cat.id);
    setNewCategoryName("");
    setNewCategoryColor(DEFAULT_NEW_CATEGORY_COLOR);
  };

  const handleRemoveCategory = async (id: string) => {
    const message = "このカテゴリを削除します。中のプリセットは「未分類」へ移動します。よろしいですか?";
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "カテゴリ削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) {
      return;
    }
    removeCategory(id);
    if (activeCategoryId === id) {
      setActiveCategoryId(null);
    }
  };

  const handleRemovePreset = async (id: string) => {
    const message = "このプリセットを削除しますか?";
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "プリセット削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) return;
    removePreset(id);
  };

  const categoryList = (
    <CategoryList
      categories={categories}
      presets={presets}
      activeCategoryId={activeCategoryId}
      onSelect={setActiveCategoryId}
      onRename={(id, name) => updateCategory(id, { name })}
      onChangeColor={(id, color) => updateCategory(id, { color })}
      onRemove={handleRemoveCategory}
      newCategoryName={newCategoryName}
      newCategoryColor={newCategoryColor}
      onChangeNewCategory={setNewCategoryName}
      onChangeNewCategoryColor={setNewCategoryColor}
      onAddCategory={handleAddCategory}
    />
  );

  const activeCategoryName = activeCategoryId
    ? categories.find((c) => c.id === activeCategoryId)?.name ?? "?"
    : "未分類";

  const presetFormModal = editingPresetId ? (
    <PresetFormModal
      isNew={editingPresetId === "__new__"}
      kind={draftKind}
      name={draftName}
      prompt={draftPrompt}
      characterAttributes={draftCharacterAttributes}
      description={draftDescription}
      tags={draftTags}
      thumbnail={draftThumbnail}
      thumbnailFocus={draftThumbnailFocus}
      attachedImages={draftAttachedImages}
      onChangeName={setDraftName}
      onChangePrompt={setDraftPrompt}
      onChangeCharacterAttributes={setDraftCharacterAttributes}
      onChangeDescription={setDraftDescription}
      onChangeTags={setDraftTags}
      onChangeThumbnail={setDraftThumbnail}
      onChangeThumbnailFocus={setDraftThumbnailFocus}
      onChangeAttachedImages={setDraftAttachedImages}
      onSave={savePreset}
      onCancel={cancelEdit}
      onRegenerateSheet={
        editingPresetId !== "__new__" &&
        draftKind === "character" &&
        draftCharacterMeta?.sourceImage
          ? regenerateSheetFromDraft
          : undefined
      }
    />
  ) : null;

  const isGridView = fullPage && viewMode === "grid";

  const presetGrid =
    visiblePresets.length === 0 ? (
      <p className="rounded-md border border-dashed border-[#343434] bg-[#101010] p-6 text-center text-[11px] text-neutral-500">
        {query.trim()
          ? "検索条件に一致するプリセットがありません"
          : "まだプリセットがありません。「＋ 新規」から登録できます。"}
      </p>
    ) : (
      <div className={isGridView
        ? "grid gap-2.5 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
        : "space-y-1.5"}>
        {visiblePresets.map((preset) => {
          const dragProps = {
            draggable: true,
            onDragStart: (e: React.DragEvent) => {
              setDragId(preset.id);
              e.dataTransfer.effectAllowed = "move";
            },
            onDragOver: (e: React.DragEvent) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            },
            onDrop: (e: React.DragEvent) => {
              e.preventDefault();
              if (dragId && dragId !== preset.id) {
                reorderPresets(dragId, preset.id);
              }
              setDragId(null);
            },
            onDragEnd: () => setDragId(null),
            className: dragId === preset.id ? "opacity-40" : "",
          };
          const isCharacter = presetKind(preset) === "character";
          return isGridView ? (
            <div
              key={preset.id}
              {...dragProps}
              title="ドラッグで並び替え"
              className={["relative", dragProps.className].join(" ").trim()}
            >
              {isCharacter && (
                <span
                  className="pointer-events-none absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-pink-400/60 bg-black/80 px-2 py-0.5 text-[9px] font-black text-pink-200 shadow-lg"
                  title="キャラクター登録"
                >
                  <CharacterIcon className="h-2.5 w-2.5" />
                  キャラ
                </span>
              )}
              <PresetCard
                preset={preset}
                onEdit={() => startEdit(preset)}
                onRemove={() => handleRemovePreset(preset.id)}
                onToggleFavorite={() => toggleFavorite(preset.id)}
              />
            </div>
          ) : (
            <div key={preset.id} {...dragProps} title="ドラッグで並び替え">
              <PresetRow
                preset={preset}
                onEdit={() => startEdit(preset)}
                onRemove={() => handleRemovePreset(preset.id)}
                onToggleFavorite={() => toggleFavorite(preset.id)}
              />
            </div>
          );
        })}
      </div>
    );

  // ページ版: 2 カラムレイアウト（左カテゴリ / 右プリセット + 検索）
  if (fullPage) {
    return (
      <>
        <div className="grid h-full min-h-0 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside
            data-tour="preset-categories"
            className="min-h-0 overflow-y-auto rounded-xl border border-[#2a2a2a] bg-[#181818] p-4"
          >
            {categoryList}
          </aside>
          <main
            data-tour="preset-list"
            className="flex min-h-0 flex-col gap-3 rounded-xl border border-[#2a2a2a] bg-[#181818] p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-black text-white">{activeCategoryName} のプリセット</h4>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  value={sortKey}
                  onChange={(event) => setSortKey(event.target.value as SortKey)}
                  className="h-8 rounded-md border border-[#343434] bg-[#101010] px-2 text-xs font-bold text-neutral-200 outline-none hover:border-pink-400 focus:border-pink-400"
                  title="並び替え"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <div className="flex h-8 overflow-hidden rounded-md border border-[#343434] bg-[#101010]">
                  <button
                    type="button"
                    onClick={() => setViewMode("grid")}
                    className={[
                      "w-9 text-xs font-black transition",
                      viewMode === "grid"
                        ? "bg-pink-500 text-white"
                        : "text-neutral-400 hover:text-white",
                    ].join(" ")}
                    title="グリッド表示"
                  >
                    ▦
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("list")}
                    className={[
                      "w-9 border-l border-[#343434] text-xs font-black transition",
                      viewMode === "list"
                        ? "bg-pink-500 text-white"
                        : "text-neutral-400 hover:text-white",
                    ].join(" ")}
                    title="リスト表示"
                  >
                    ☰
                  </button>
                </div>
                <button
                  data-tour="preset-new"
                  type="button"
                  onClick={startNew}
                  className="h-8 rounded-md bg-pink-500 px-3 text-xs font-bold text-white hover:bg-pink-600"
                >
                  ＋ 新規
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                data-tour="preset-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="検索（名前 / プロンプト本文 / メモ）"
                className="h-9 min-w-0 flex-1 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400"
              />
              <button
                type="button"
                onClick={() => setCharacterOnly((v) => !v)}
                className={[
                  "flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] font-bold transition",
                  characterOnly
                    ? "border-pink-400 bg-pink-500/10 text-white"
                    : "border-[#343434] bg-[#101010] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200",
                ].join(" ")}
                title="キャラクター登録のみ表示"
              >
                <span aria-hidden>👤</span>
                <span>キャラ</span>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">{presetGrid}</div>
          </main>
        </div>
        {presetFormModal}
      </>
    );
  }

  // サイドバー版（互換性のため残す。今は使ってない、念のため残置）
  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-3">
        {categoryList}
        <div className="flex min-h-0 flex-1 flex-col border-t border-[#242424] pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-black text-white">
              {activeCategoryName} のプリセット
            </h4>
            <button
              type="button"
              onClick={startNew}
              className="h-7 rounded-md bg-pink-500 px-3 text-[11px] font-bold text-white hover:bg-pink-600"
            >
              ＋ 新規
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">{presetGrid}</div>
        </div>
      </div>
      {presetFormModal}
    </>
  );
}

function CategoryList({
  categories,
  presets,
  activeCategoryId,
  onSelect,
  onRename,
  onChangeColor,
  onRemove,
  newCategoryName,
  newCategoryColor,
  onChangeNewCategory,
  onChangeNewCategoryColor,
  onAddCategory,
}: {
  categories: PresetCategory[];
  presets: Preset[];
  activeCategoryId: string | null;
  onSelect: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onChangeColor: (id: string, color: string) => void;
  onRemove: (id: string) => void;
  newCategoryName: string;
  newCategoryColor: string;
  onChangeNewCategory: (next: string) => void;
  onChangeNewCategoryColor: (next: string) => void;
  onAddCategory: () => void;
}) {
  const uncategorizedCount = presets.filter((p) => p.categoryId === null).length;
  return (
    <section>
      <h4 className="mb-2 text-xs font-black text-white">カテゴリ</h4>

      {/* カテゴリ追加フォームを最上部に配置（リストの上）。
          Enter は意図せぬ確定を防ぐためここでは反応させない。
          IME 変換確定の Enter で勝手に登録される事故を避ける。
          確定したいときは「追加」ボタンを押す。 */}
      <div className="mb-2 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={newCategoryName}
            onChange={(event) => onChangeNewCategory(event.target.value)}
            placeholder="新規カテゴリ名（追加ボタンで確定）"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
              }
            }}
            className="h-7 flex-1 rounded-md border border-[#343434] bg-[#101010] px-2 text-[11px] text-neutral-100 outline-none focus:border-pink-400"
          />
          <button
            type="button"
            onClick={onAddCategory}
            disabled={!newCategoryName.trim()}
            className="h-7 rounded-md bg-pink-500 px-2 text-[11px] font-bold text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            追加
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          {CATEGORY_COLOR_OPTIONS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => onChangeNewCategoryColor(color)}
              className={[
                "h-4 w-4 rounded-full border transition",
                newCategoryColor.toLowerCase() === color.toLowerCase()
                  ? "border-white"
                  : "border-[#343434] hover:border-neutral-300",
              ].join(" ")}
              style={{ backgroundColor: color }}
              title={color}
            />
          ))}
          <input
            type="color"
            value={newCategoryColor}
            onChange={(event) => onChangeNewCategoryColor(event.target.value)}
            className="h-5 w-7 cursor-pointer rounded border border-[#343434] bg-[#101010] p-0"
            title="カスタム色"
          />
        </div>
      </div>

      <div className="space-y-1">
        {categories.map((cat) => (
          <CategoryRow
            key={cat.id}
            category={cat}
            count={presets.filter((p) => p.categoryId === cat.id).length}
            active={cat.id === activeCategoryId}
            onSelect={() => onSelect(cat.id)}
            onRename={(name) => onRename(cat.id, name)}
            onChangeColor={(color) => onChangeColor(cat.id, color)}
            onRemove={() => onRemove(cat.id)}
          />
        ))}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={[
            "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] transition",
            activeCategoryId === null
              ? "bg-[#1f1f1f] text-white"
              : "text-neutral-400 hover:bg-[#181818] hover:text-neutral-200",
          ].join(" ")}
        >
          <span className="flex flex-1 items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-neutral-600" />
            <span className="flex-1 truncate text-left">未分類</span>
          </span>
          <span className="shrink-0 rounded bg-[#0f0f0f] px-1.5 py-0.5 text-[10px] font-bold text-neutral-400">
            {uncategorizedCount}
          </span>
        </button>
      </div>
    </section>
  );
}

function CategoryRow({
  category,
  count,
  active,
  onSelect,
  onRename,
  onChangeColor,
  onRemove,
}: {
  category: PresetCategory;
  count: number;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onChangeColor: (color: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>(category.name);
  const [draftColor, setDraftColor] = useState<string>(category.color);

  const commitEdit = () => {
    const nextName = draft.trim();
    if (nextName && nextName !== category.name) onRename(nextName);
    if (draftColor !== category.color) onChangeColor(draftColor);
    setEditing(false);
  };

  if (editing) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md bg-[#181818] px-2 py-1"
        onBlur={(event) => {
          const nextFocus = event.relatedTarget as Node | null;
          if (!event.currentTarget.contains(nextFocus)) commitEdit();
        }}
      >
        <input
          type="color"
          value={draftColor}
          onChange={(event) => setDraftColor(event.target.value)}
          className="h-5 w-6 shrink-0 cursor-pointer rounded border border-[#343434] bg-[#101010] p-0"
          title="カテゴリ色"
        />
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter は何もしない（IME 変換確定の Enter で勝手に保存されるのを防ぐ）。
            // 確定はフォーカスアウト or Escape キャンセル。
            if (event.key === "Enter") {
              event.preventDefault();
            } else if (event.key === "Escape") {
              setDraft(category.name);
              setDraftColor(category.color);
              setEditing(false);
            }
          }}
          className="h-6 flex-1 rounded border border-[#343434] bg-[#101010] px-1.5 text-[11px] text-neutral-100 outline-none focus:border-pink-400"
        />
      </div>
    );
  }

  return (
    <div
      className={[
        "group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] transition",
        active
          ? "bg-[#1f1f1f] text-white"
          : "text-neutral-400 hover:bg-[#181818] hover:text-neutral-200",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: category.color }}
        />
        <span className="truncate flex-1">{category.name}</span>
        {/* STΛCK 指示 (2026-05-17): 件数バッジを名前の右側に統一表示。
            「未分類」の表記と揃える。 */}
        <span className="shrink-0 rounded bg-[#0f0f0f] px-1.5 py-0.5 text-[10px] font-bold text-neutral-400">
          {count}
        </span>
      </button>
      <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onClick={() => {
            setDraft(category.name);
            setDraftColor(category.color);
            setEditing(true);
          }}
          className="text-[10px] text-neutral-400 hover:text-white"
          title="名前を編集"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="text-[10px] text-neutral-400 hover:text-red-400"
          title="削除"
        >
          ×
        </button>
      </div>
    </div>
  );
}

type PresetFormProps = {
  isNew: boolean;
  /** プリセット種別。"character" のとき属性 textarea を出す。 */
  kind: "prompt" | "character";
  name: string;
  prompt: string;
  /** キャラ型の属性テキスト（髪色・目・服装など）。プロンプト型では使わない。 */
  characterAttributes: string;
  description: string;
  tags: string[];
  thumbnail?: string;
  thumbnailFocus?: ThumbnailFocus;
  /** F-#7 修正 (2026-05-19): キャラ添付画像 (path 配列) */
  attachedImages: string[];
  onChangeName: (next: string) => void;
  onChangePrompt: (next: string) => void;
  onChangeCharacterAttributes: (next: string) => void;
  onChangeDescription: (next: string) => void;
  onChangeTags: (next: string[]) => void;
  onChangeThumbnail: (next: string | undefined) => void;
  onChangeThumbnailFocus: (next: ThumbnailFocus | undefined) => void;
  onChangeAttachedImages: (next: string[]) => void;
  onSave: () => void;
  onCancel: () => void;
  /** B-5: キャラ型のみ。シート作り直しへ送る。新規・sourceImage 無しでは undefined。 */
  onRegenerateSheet?: () => void;
};

/**
 * 編集 / 新規追加のモーダルダイアログ。
 *
 * 起動条件:
 * - 「＋ 新規」ボタン
 * - PresetCard / PresetRow の ✎ ペンマーク
 *
 * 閉じる:
 * - 背景（オーバーレイ）クリック
 * - Escape キー
 * - 「キャンセル」ボタン
 *
 * 保存後は親が cancelEdit() を呼んで閉じる。
 */
function PresetFormModal(props: PresetFormProps) {
  // Escape で閉じる
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  // body スクロール抑止（モーダル open 時）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 p-4 sm:items-center"
      onMouseDown={(event) => {
        // 背景（このコンテナ自身）クリックで閉じる。子クリックは無視。
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <div
        className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-[#2a2a2a] bg-[#161616] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={props.isNew ? "新規プリセット" : "プリセット編集"}
      >
        <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
          <h3 className="text-sm font-black text-white">
            {props.isNew ? "新規プリセット" : "プリセット編集"}
          </h3>
          <button
            type="button"
            onClick={props.onCancel}
            className="flex h-7 w-7 items-center justify-center rounded-md text-base text-neutral-400 hover:bg-neutral-800 hover:text-white"
            title="閉じる（Escape）"
          >
            ×
          </button>
        </div>
        <div className="p-4">
          <PresetForm {...props} />
        </div>
      </div>
    </div>
  );
}

function PresetForm({
  isNew,
  kind,
  name,
  prompt,
  characterAttributes,
  description,
  tags,
  thumbnail,
  thumbnailFocus,
  attachedImages,
  onChangeName,
  onChangePrompt,
  onChangeCharacterAttributes,
  onChangeDescription,
  onChangeTags,
  onChangeThumbnail,
  onChangeThumbnailFocus,
  onChangeAttachedImages,
  onSave,
  onCancel,
  onRegenerateSheet,
}: PresetFormProps) {
  const isCharacter = kind === "character";
  // キャラ型は属性 or プロンプトのどちらかがあれば保存可。プロンプト型はプロンプト必須。
  const canSave =
    name.trim().length > 0 &&
    (isCharacter
      ? prompt.trim().length > 0 || characterAttributes.trim().length > 0
      : prompt.trim().length > 0);
  const [tagDraft, setTagDraft] = useState<string>("");

  /** Enter 単独では保存しない。Cmd/Ctrl+Enter のときだけ保存トリガー。
   *  Shift+Enter は textarea で改行扱い、input では何もしない（ブラウザデフォルト）。
   *  IME 変換確定中の Enter は無視（意図しない保存を防ぐ）。 */
  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const isComposing =
      (event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229;
    if (isComposing) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) onSave();
    }
  };

  const addTag = () => {
    const t = tagDraft.trim();
    if (!t) return;
    if (!tags.includes(t)) onChangeTags([...tags, t]);
    setTagDraft("");
  };

  // 新しいサムネを登録した直後、ユーザー要望で必ず focal モーダルを出す。
  // この state は「ローカル focal モーダル open フラグ + 編集対象 src + 初期 focus」を保持する。
  const [focalModal, setFocalModal] = useState<
    | { src: string; initial: ThumbnailFocus | undefined; reason: "new" | "edit" }
    | null
  >(null);

  const handleThumbnailFile = async (file: File | null) => {
    if (!file) {
      onChangeThumbnail(undefined);
      onChangeThumbnailFocus(undefined);
      return;
    }
    const { fileToThumbnailDataUrl } = await import("../lib/preset/thumbnail");
    try {
      const dataUrl = await fileToThumbnailDataUrl(file);
      onChangeThumbnail(dataUrl);
      // 新規登録は focal を未設定 (中央/等倍) にリセットしてからモーダルで調整させる
      onChangeThumbnailFocus(undefined);
      setFocalModal({ src: dataUrl, initial: undefined, reason: "new" });
    } catch (error) {
      console.error("thumbnail conversion failed", error);
    }
  };

  const handleAdjustFocus = () => {
    if (!thumbnail) return;
    setFocalModal({ src: thumbnail, initial: thumbnailFocus, reason: "edit" });
  };

  // モーダル化後は外側にタイトルが出るので、内側のラベルは廃止。
  // 旧 inline 表示時の名残（`{isNew ? "新規プリセット" : "編集"}` のヘッダ）は削除済み。
  void isNew;

  return (
    <div className="space-y-3">
      {/* 16:9 サムネプレビュー + 操作ボタン。ユーザー指摘:
          - 編集画面のプレビューは実際の見え方（16:9）に合わせる
          - 差し替え / 位置調整がここから出来る */}
      <PresetThumbnailField
        thumbnail={thumbnail}
        thumbnailFocus={thumbnailFocus}
        onPickFile={handleThumbnailFile}
        onAdjustFocus={handleAdjustFocus}
        onClear={() => {
          onChangeThumbnail(undefined);
          onChangeThumbnailFocus(undefined);
        }}
      />

      <div className="space-y-2">
        <input
          type="text"
          value={name}
          onChange={(event) => onChangeName(event.target.value)}
          onKeyDown={onInputKey}
          placeholder="プリセット名（例: 朝のキッチン）"
          className="h-8 w-full rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
        />
        <input
          type="text"
          value={description}
          onChange={(event) => onChangeDescription(event.target.value)}
          onKeyDown={onInputKey}
          placeholder="メモ（任意）"
          className="h-7 w-full rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[11px] text-neutral-100 outline-none focus:border-pink-400"
        />
      </div>

      {focalModal && (
        <PresetThumbnailFocusModal
          src={focalModal.src}
          initialFocus={focalModal.initial}
          onSave={(next) => {
            onChangeThumbnailFocus(next);
            setFocalModal(null);
          }}
          onCancel={() => {
            // reason="new" の場合: 初期は undefined にしているので、キャンセル = focus 未設定 (中央/等倍)
            // reason="edit" の場合: 既存 focus を変えずに閉じる
            setFocalModal(null);
          }}
        />
      )}

      <textarea
        value={prompt}
        onChange={(event) => onChangePrompt(event.target.value)}
        onKeyDown={onInputKey}
        placeholder={
          isCharacter
            ? "プロンプト本文（任意。属性だけでも保存できます）"
            : "プロンプト本文（プリセットを呼ぶと末尾に追記されます）"
        }
        rows={5}
        className="w-full resize-none rounded-md border border-[#343434] bg-[#0b0b0b] p-2 font-mono text-[11px] leading-5 text-neutral-100 outline-none focus:border-pink-400"
      />

      {/* キャラ型プリセットのみ: 属性テキスト（髪色・目・服装・体型など）を編集する。
          生成時に characterPromptText() でプロンプトへ自動合成される。 */}
      {isCharacter && (
        <div className="space-y-1.5">
          <span className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
            キャラ属性
          </span>
          <textarea
            value={characterAttributes}
            onChange={(event) => onChangeCharacterAttributes(event.target.value)}
            onKeyDown={onInputKey}
            placeholder="髪色・目の色・服装・体型など（生成時にプロンプトへ自動で足されます）"
            rows={3}
            className="w-full resize-none rounded-md border border-[#343434] bg-[#0b0b0b] p-2 text-[11px] leading-5 text-neutral-100 outline-none focus:border-pink-400"
          />
        </div>
      )}

      {kind === "character" && onRegenerateSheet && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={onRegenerateSheet}
            className="rounded-md border border-pink-500/40 bg-pink-500/10 px-3 py-1.5 text-[11px] font-bold text-pink-200 transition hover:bg-pink-500/20"
          >
            この属性でシートを作り直す
          </button>
          <p className="text-[10px] text-neutral-500">
            キャラクター登録の画面が開きます。生成して「上書き登録」すると、このキャラのシートが置き換わります。
          </p>
        </div>
      )}

      {/*
        STΛCK 報告 (2026-05-19): プリセット編集モーダルで attachedImages (キャラ画像)
        を編集できなかったため、保存済みでも見えない状態だった。タグの直前に
        「キャラ添付画像」セクションを追加。サムネ表示 + ✕ で個別削除可能。

        さらに STΛCK 指示 (2026-05-19): drop target 化。ライブラリ等から画像を
        ドラッグ&ドロップで追加できる (画像があるエリアからこのエリアへ自由に流す)。
      */}
      <div
        className="space-y-1.5"
        onDragOver={(event) => {
          if (isImageDrop(event.dataTransfer)) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          // 内部 ref はそのまま、外部 OS ファイル/別モニタ画像は writeUpload で
          // 取り込んでから path を追加する (穴埋め: 従来は refs のみで外部画像を
          // 取りこぼしていた)。
          const { refs, files } = extractDropped(event.dataTransfer);
          const addPaths = (paths: string[]) => {
            const dropped = paths.filter((p) => !attachedImages.includes(p));
            if (dropped.length > 0) {
              onChangeAttachedImages([...attachedImages, ...dropped]);
            }
          };
          if (refs.length > 0) addPaths(refs.map((r) => r.path));
          if (files.length > 0) {
            void Promise.all(files.map((f) => fileToUploadReference(f)))
              .then((uploaded) => addPaths(uploaded.map((r) => r.path)))
              .catch((err) => console.error("preset drop upload failed", err));
          }
        }}
      >
        <span className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
          キャラ添付画像 ({attachedImages.length} 枚)
        </span>
        <p className="text-[10px] text-neutral-500">
          プリセット呼び出し時にこれらの画像も自動で参照ラックに追加されます。
          ライブラリやプレビューからドラッグで追加できます。
        </p>
        {attachedImages.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {attachedImages.map((path) => (
              <div
                key={path}
                className="group relative h-16 w-16 overflow-hidden rounded border border-[#343434] bg-black"
                title={path}
              >
                <SafeImage path={path} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() =>
                    onChangeAttachedImages(
                      attachedImages.filter((p) => p !== path),
                    )
                  }
                  className="absolute right-0 top-0 hidden h-5 w-5 items-center justify-center bg-black/80 text-[11px] text-white group-hover:flex hover:text-rose-300"
                  title="この画像をプリセットから外す"
                  aria-label="画像を外す"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded border border-dashed border-[#343434] bg-[#0b0b0b] px-3 py-3 text-center text-[11px] text-neutral-500">
            キャラ画像は紐づいていません — ここに画像をドラッグできます
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <span className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
          タグ
        </span>
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-[#343434] bg-[#0b0b0b] p-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-[#1f1f1f] px-2 py-0.5 text-[10px] text-neutral-200"
            >
              <span>#{tag}</span>
              <button
                type="button"
                onClick={() => onChangeTags(tags.filter((t) => t !== tag))}
                className="text-neutral-500 hover:text-red-400"
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              // IME 変換中の Enter は無視（変換確定の Enter で勝手に登録されるのを防ぐ）。
              // event.nativeEvent.isComposing が true なら確定中とみなす。
              const isComposing =
                (event.nativeEvent as KeyboardEvent).isComposing ||
                event.keyCode === 229;
              if (event.key === "," && !isComposing) {
                event.preventDefault();
                addTag();
              } else if (event.key === "Tab" && !isComposing && tagDraft.trim()) {
                event.preventDefault();
                addTag();
              } else if (event.key === "Backspace" && !tagDraft && tags.length > 0) {
                onChangeTags(tags.slice(0, -1));
              }
              // Enter は確定しない。意図しない登録を防ぐため、カンマ / Tab / 「追加」相当の
              // フォーカスアウト時 onBlur で確定する。
            }}
            onBlur={() => {
              if (tagDraft.trim()) addTag();
            }}
            placeholder={tags.length === 0 ? "タグを追加（カンマ or Tab で確定）" : ""}
            className="min-w-[80px] flex-1 bg-transparent text-[11px] text-neutral-100 outline-none placeholder:text-neutral-600"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] text-neutral-600">
          ⌘/Ctrl + Enter で保存
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 rounded-md border border-[#343434] bg-[#0b0b0b] px-3 text-[11px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="h-7 rounded-md bg-pink-500 px-3 text-[11px] font-bold text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 編集モーダル用の 16:9 サムネプレビューフィールド。
 *
 * - 表示: aspect-[16/9]、focal point + zoom を反映した実際の見え方
 * - サムネあり時: hover で「差し替え / 位置調整」オーバーレイ + 右上 × 削除
 * - サムネなし時: クリック or ドロップでファイル選択
 * - ファイル選択は <label> + hidden <input type=file>、ドロップは onDrop
 *
 * 位置調整は別モーダル (PresetThumbnailFocusModal) で行うため、ここでは
 * onAdjustFocus を呼び出すだけ。
 */
function PresetThumbnailField({
  thumbnail,
  thumbnailFocus,
  onPickFile,
  onAdjustFocus,
  onClear,
}: {
  thumbnail?: string;
  thumbnailFocus?: ThumbnailFocus;
  onPickFile: (file: File | null) => void;
  onAdjustFocus: () => void;
  onClear: () => void;
}) {
  const [drag, setDrag] = useState(false);
  const style = focusToImageStyle(thumbnailFocus);
  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        setDrag(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDrag(false);
        const file = event.dataTransfer.files[0];
        if (file) onPickFile(file);
      }}
      className={[
        "group relative aspect-[16/9] w-full overflow-hidden rounded-lg border-2 bg-[#0b0b0b] transition",
        drag
          ? "border-pink-400 bg-pink-500/10 shadow-[0_0_0_3px_rgba(236,72,153,0.25)]"
          : thumbnail
            ? "border-[#2a2a2a]"
            : "border-dashed border-[#3a3a3a] hover:border-pink-400 hover:bg-[#101010]",
      ].join(" ")}
    >
      {thumbnail ? (
        <>
          <img
            src={thumbnail}
            alt="thumbnail"
            className="absolute inset-0 h-full w-full object-cover"
            style={style}
            draggable={false}
          />
          {/* hover オーバーレイ: 「差し替え」と「位置調整」のクイックアクション */}
          <div className="absolute inset-0 z-10 hidden items-center justify-center gap-2 bg-black/55 text-xs font-bold text-white group-hover:flex">
            <label className="cursor-pointer rounded-md bg-pink-500 px-3 py-1.5 hover:bg-pink-400">
              差し替え
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  onPickFile(file);
                  event.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              onClick={onAdjustFocus}
              className="rounded-md border border-white/40 bg-black/60 px-3 py-1.5 hover:border-pink-300 hover:text-pink-200"
            >
              位置調整
            </button>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="absolute right-2 top-2 z-20 hidden h-7 w-7 items-center justify-center rounded-full bg-black/85 text-sm font-black text-white shadow-lg group-hover:flex hover:bg-red-500"
            title="サムネを削除"
          >
            ×
          </button>
        </>
      ) : (
        <label className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1 px-3 text-center">
          <span className="text-3xl leading-none text-neutral-500 group-hover:text-pink-300">
            ＋
          </span>
          <span className="text-xs font-bold leading-tight text-neutral-400">
            サムネを追加
          </span>
          <span className="text-[10px] leading-tight text-neutral-600">
            クリック or ドラッグ＆ドロップ
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              onPickFile(file);
              event.target.value = "";
            }}
          />
        </label>
      )}
      {drag && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-pink-500/20 text-sm font-black text-pink-100">
          ここにドロップ
        </div>
      )}
    </div>
  );
}

/** リスト版の 1 行（リストモード / サイドバー版で使用） */
function PresetRow({
  preset,
  onEdit,
  onRemove,
  onToggleFavorite,
}: {
  preset: Preset;
  onEdit: () => void;
  onRemove: () => void;
  onToggleFavorite?: () => void;
}) {
  const tags = preset.tags ?? [];
  const isFavorite = !!preset.favorite;
  const isCharacter = presetKind(preset) === "character";
  // ユーザー指摘: グリッド / リスト / ピッカーで見え方を統一する。
  // focal point + zoom の両方を反映する（編集時に設定した見え方そのまま）。
  const imageStyle = focusToImageStyle(preset.thumbnailFocus);
  return (
    <div className="group flex items-stretch gap-2.5 rounded-md border border-[#2a2a2a] bg-[#101010] p-2 hover:border-pink-400">
      {/* リストでも 16:9 でサムネ表示。カード表示と同じ比率・同じ見え方に揃える。
          ★バッジはサムネに乗せず、右側のボタン群側で表現する。 */}
      <div className="relative aspect-[16/9] h-14 shrink-0 overflow-hidden rounded-md border border-[#242424] bg-[#1b1b1b]">
        {preset.thumbnail ? (
          <img
            src={preset.thumbnail}
            alt=""
            className="h-full w-full object-cover"
            style={imageStyle}
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#242424_0%,#171717_100%)] text-[8px] font-bold uppercase tracking-wide text-neutral-600">
            No Img
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isCharacter && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-pink-400/60 bg-pink-500/10 px-1.5 py-px text-[9px] font-black text-pink-300"
              title="キャラクター登録"
            >
              <CharacterIcon className="h-2.5 w-2.5" />
              キャラ
            </span>
          )}
          <div className="truncate text-xs font-bold text-neutral-100">{preset.name}</div>
          {tags.length > 0 && (
            <div className="hidden shrink-0 flex-wrap items-center gap-1 sm:flex">
              {tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="max-w-[68px] truncate rounded-full bg-[#1f1f1f] px-1.5 py-px text-[9px] font-bold text-neutral-300"
                  title={tag}
                >
                  #{tag}
                </span>
              ))}
              {tags.length > 3 && (
                <span className="rounded-full bg-[#2a2a2a] px-1.5 py-px text-[9px] font-bold text-neutral-400">
                  +{tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[10px] text-neutral-500">
          {preset.prompt}
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-1 pt-0.5">
        {onToggleFavorite && (
          <button
            type="button"
            onClick={onToggleFavorite}
            className={[
              "text-xs transition",
              isFavorite
                ? "text-pink-400 opacity-100 hover:text-pink-300"
                : "text-neutral-500 opacity-0 hover:text-pink-400 group-hover:opacity-100",
            ].join(" ")}
            title={isFavorite ? "お気に入りから外す" : "お気に入りに追加"}
          >
            {isFavorite ? "★" : "☆"}
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="text-[10px] text-neutral-400 opacity-0 transition hover:text-white group-hover:opacity-100"
          title="編集"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="text-[10px] text-neutral-400 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
          title="削除"
        >
          ×
        </button>
      </div>
    </div>
  );
}
