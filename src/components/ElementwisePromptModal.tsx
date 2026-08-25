import { useEffect, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ModalPortal } from "./ModalPortal";

/**
 * 要素別プロンプト編集モーダル (STΛCK 指示 2026-05-19)。
 *
 * 設計:
 * - プロンプトを `,` で分割し、`key: value` 形式の key を「カテゴリ」と見なして
 *   同カテゴリの値をひとつの textarea にまとめて表示する
 * - 例: "style: clean photo, bright even lighting, polished editorial finish"
 *   → カテゴリ「スタイル」の1行に "clean photo, bright even lighting, polished editorial finish"
 * - これでカテゴリ単位で「光だけ変えたい」「カメラだけ書き換えたい」が直感的にできる
 * - @dnd-kit でドラッグ&ドロップ並べ替え (HTML5 native は挙動が不安定だったため)
 * - 並べ替え中は挿入位置のプレビューを表示
 * - サイズは OptionPickerModal と統一 (max-w-5xl)
 */
type Props = {
  open: boolean;
  prompt: string;
  onClose: () => void;
  onApply: (next: string) => void;
};

/**
 * クリエイティブプロンプトのカテゴリカタログ。
 *
 * AI 画像生成 (Midjourney / SD / Flux / GPT Image / Higgsfield) で共通して
 * 使われる業界標準カテゴリを、クリエイティブの組み立て順 (主役 → 構図 →
 * 光 → カメラ → 色 → スタイル → 後処理) で並べた。
 *
 * - key: AI 送信時の英語キー (textarea の中身は `key: value` 形式で書く)
 * - label: 日本語表示
 * - hint: 入力欄プレースホルダ用のヒント
 * - group: ピッカーで「映画・写真」「人物」「画質・後処理」「その他」にグルーピング
 */
type CategoryDef = {
  key: string;
  label: string;
  hint: string;
  group: "scene" | "person" | "finish" | "other";
};

const CATEGORY_CATALOG: CategoryDef[] = [
  // ── シーン・撮影 (映画/写真の根幹) ──
  { key: "subject", label: "主役", hint: "例: 30代女性、青いジャケット", group: "scene" },
  { key: "composition", label: "構図", hint: "例: close-up, rule of thirds", group: "scene" },
  { key: "aspect ratio", label: "アスペクト比", hint: "例: 16:9, 1:1, 9:16", group: "scene" },
  { key: "environment", label: "環境", hint: "例: rainy London bus stop", group: "scene" },
  { key: "lighting", label: "光源", hint: "例: natural light, golden hour, backlight", group: "scene" },
  { key: "mood", label: "ムード", hint: "例: cinematic, moody, melancholic", group: "scene" },
  { key: "camera", label: "カメラ", hint: "例: modern cinema camera, Sony A7R", group: "scene" },
  { key: "lens", label: "レンズ", hint: "例: 85mm portrait, wide-angle 24mm", group: "scene" },
  { key: "shot", label: "ショット", hint: "例: close-up, medium shot, long shot", group: "scene" },
  { key: "depth of field", label: "被写界深度", hint: "例: shallow, deep focus, bokeh", group: "scene" },
  { key: "color", label: "色味", hint: "例: warm tones, desaturated, vibrant", group: "scene" },

  // ── 人物 ──
  { key: "pose", label: "ポーズ", hint: "例: looking away, hands in pockets", group: "person" },
  { key: "expression", label: "表情", hint: "例: smiling, serious, contemplative", group: "person" },
  { key: "clothing", label: "服装", hint: "例: vintage denim jacket", group: "person" },
  { key: "background", label: "背景", hint: "例: blurred urban, minimalist white", group: "person" },

  // ── スタイル・画質・後処理 ──
  // STΛCK 指示 (2026-05-19): 「○○風」(artist 名指し) は著作権・パブリシティ権
  // のグレーゾーンで AI 各社の規約でも非推奨のため、カタログから除外。
  { key: "style", label: "スタイル", hint: "例: photorealistic, anime, oil painting", group: "finish" },
  { key: "quality", label: "画質", hint: "例: ultra detailed, 8k, high resolution", group: "finish" },
  { key: "finish", label: "後処理", hint: "例: polished editorial, film grain, vintage", group: "finish" },
  { key: "film", label: "フィルム", hint: "例: Kodak Portra 400, film grain", group: "finish" },
  { key: "filter", label: "フィルター", hint: "例: sepia, black and white", group: "finish" },

  // ── その他 ──
  { key: "references", label: "参照", hint: "例: @img1, @img2", group: "other" },
  { key: "negative", label: "ネガティブ", hint: "例: no text, no watermark", group: "other" },
];

const GROUP_LABELS: Record<CategoryDef["group"], string> = {
  scene: "シーン・撮影",
  person: "人物",
  finish: "スタイル・画質・後処理",
  other: "その他",
};

/** key (英語) → 日本語ラベル の高速ルックアップ */
const LABEL_JA: Record<string, string> = Object.fromEntries(
  CATEGORY_CATALOG.map((c) => [c.key, c.label]),
);

/** key → CategoryDef 全体のルックアップ (ヒント表示用) */
const CATALOG_BY_KEY: Record<string, CategoryDef> = Object.fromEntries(
  CATEGORY_CATALOG.map((c) => [c.key, c]),
);

type Category = {
  /** dnd-kit 用の安定 ID。生成時刻+ランダムで衝突しないように。 */
  id: string;
  /** 元の英語キー (composition, style 等)。null は自由記述。 */
  key: string | null;
  /** 表示用日本語ラベル */
  label: string;
  /** textarea に表示するカンマ区切りの値 (英語のまま) */
  value: string;
};

function genId(): string {
  return `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parsePromptIntoCategories(prompt: string): Category[] {
  const pieces = prompt
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const categories: Category[] = [];
  for (const piece of pieces) {
    const idx = piece.indexOf(":");
    if (idx >= 0) {
      const key = piece.slice(0, idx).trim();
      const value = piece.slice(idx + 1).trim();
      categories.push({
        id: genId(),
        key: key.toLowerCase(),
        label: LABEL_JA[key.toLowerCase()] ?? key,
        value,
      });
    } else {
      if (categories.length === 0) {
        categories.push({ id: genId(), key: null, label: "自由記述", value: piece });
      } else {
        const last = categories[categories.length - 1];
        last.value = last.value ? `${last.value}, ${piece}` : piece;
      }
    }
  }
  return categories;
}

function serializeCategories(categories: Category[]): string {
  const parts: string[] = [];
  for (const cat of categories) {
    const trimmed = cat.value.trim();
    if (!trimmed) continue;
    if (cat.key === null) {
      parts.push(trimmed);
    } else {
      parts.push(`${cat.key}: ${trimmed}`);
    }
  }
  return parts.join(", ");
}

/** ソート可能な1行 */
function SortableRow({
  category,
  onUpdate,
  onRemove,
}: {
  category: Category;
  onUpdate: (value: string) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: category.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        "flex items-start gap-2 rounded-md p-1 transition",
        isDragging ? "bg-pink-500/5" : "",
      ].join(" ")}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="mt-1.5 cursor-grab select-none rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-pink-300 active:cursor-grabbing"
        title="ドラッグで並べ替え"
        aria-label="ドラッグハンドル"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="6" cy="3" r="1.4" />
          <circle cx="10" cy="3" r="1.4" />
          <circle cx="6" cy="8" r="1.4" />
          <circle cx="10" cy="8" r="1.4" />
          <circle cx="6" cy="13" r="1.4" />
          <circle cx="10" cy="13" r="1.4" />
        </svg>
      </button>
      <span
        className="mt-2 w-28 shrink-0 truncate text-xs font-bold text-neutral-300"
        title={category.label}
      >
        {category.label}
      </span>
      <textarea
        value={category.value}
        onChange={(e) => onUpdate(e.target.value)}
        rows={Math.min(4, Math.max(2, Math.ceil(category.value.length / 60)))}
        placeholder={
          category.key && CATALOG_BY_KEY[category.key]
            ? CATALOG_BY_KEY[category.key].hint
            : "値をカンマ区切りで入力"
        }
        className="min-w-0 flex-1 resize-none rounded-md border border-[#343434] bg-[#101010] px-3 py-2 font-mono text-[12px] leading-5 text-neutral-100 outline-none focus:border-pink-500"
      />
      <button
        type="button"
        onClick={onRemove}
        className="mt-1 h-8 w-8 shrink-0 rounded text-[14px] text-neutral-500 hover:bg-neutral-800 hover:text-rose-300"
        title="このカテゴリを削除"
        aria-label="カテゴリ削除"
      >
        ×
      </button>
    </div>
  );
}

/** DragOverlay 用のドラッグ中ゴースト表示 */
function DragGhost({ category }: { category: Category }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-pink-400/60 bg-[#181818] p-2 shadow-2xl">
      <span className="mt-1.5 select-none p-1 text-pink-300">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="6" cy="3" r="1.4" />
          <circle cx="10" cy="3" r="1.4" />
          <circle cx="6" cy="8" r="1.4" />
          <circle cx="10" cy="8" r="1.4" />
          <circle cx="6" cy="13" r="1.4" />
          <circle cx="10" cy="13" r="1.4" />
        </svg>
      </span>
      <span className="mt-2 w-28 shrink-0 truncate text-xs font-bold text-pink-200">
        {category.label}
      </span>
      <span className="min-w-0 flex-1 truncate rounded-md border border-pink-400/40 bg-[#101010] px-3 py-2 font-mono text-[12px] leading-5 text-neutral-100">
        {category.value || "(空)"}
      </span>
    </div>
  );
}

/** カテゴリ追加ピッカー (グループ別カタログ + 自由記述) */
function CategoryPicker({
  existingKeys,
  onPick,
  onClose,
}: {
  existingKeys: Set<string>;
  onPick: (def: CategoryDef | null) => void;
  onClose: () => void;
}) {
  return (
    <ModalPortal>
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl min-h-0 flex-col overflow-hidden rounded-xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#242424] px-6 py-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
              ADD
            </p>
            <h3 className="text-sm font-black text-white">カテゴリを追加</h3>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              AI 画像生成のベストプラクティクスに沿った標準カテゴリから選べます。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md border border-[#343434] bg-[#101010] px-3 py-1 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            × 閉じる
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
          {(["scene", "person", "finish", "other"] as const).map((group) => {
            const items = CATEGORY_CATALOG.filter((c) => c.group === group);
            return (
              <div key={group}>
                <p className="mb-2 text-[10px] font-black uppercase tracking-wide text-neutral-500">
                  {GROUP_LABELS[group]}
                </p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {items.map((def) => {
                    const already = existingKeys.has(def.key);
                    return (
                      <button
                        key={def.key}
                        type="button"
                        disabled={already}
                        onClick={() => onPick(def)}
                        title={already ? "すでに追加済み" : def.hint}
                        className={[
                          "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition",
                          already
                            ? "cursor-not-allowed border-[#222] bg-[#0a0a0a] text-neutral-600"
                            : "border-[#343434] bg-[#101010] hover:border-pink-400 hover:bg-pink-500/10",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "text-xs font-bold",
                            already ? "text-neutral-600" : "text-neutral-100",
                          ].join(" ")}
                        >
                          {def.label}
                          {already && " (追加済み)"}
                        </span>
                        <span
                          className={[
                            "truncate font-mono text-[10px]",
                            already ? "text-neutral-700" : "text-neutral-500",
                          ].join(" ")}
                        >
                          {def.key}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {/* 自由記述 (カスタム) */}
          <div className="border-t border-[#242424] pt-4">
            <button
              type="button"
              onClick={() => onPick(null)}
              className="w-full rounded-md border border-dashed border-[#444] bg-[#101010] px-3 py-2 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-pink-300"
            >
              + 自由記述行 (カテゴリなし) を追加
            </button>
          </div>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

export function ElementwisePromptModal({ open, prompt, onClose, onApply }: Props) {
  const initial = useMemo(() => parsePromptIntoCategories(prompt), [prompt]);
  const [categories, setCategories] = useState<Category[]>(initial);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setCategories(parsePromptIntoCategories(prompt));
    }
  }, [open, prompt]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // PointerSensor の activationConstraint で 5px 動かすまではドラッグ開始しない
  // → textarea のクリックや 「×」 削除ボタンが誤発火しない
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (!open) return null;

  const updateValue = (id: string, nextValue: string) => {
    setCategories((prev) =>
      prev.map((c) => (c.id === id ? { ...c, value: nextValue } : c)),
    );
  };

  const removeCategory = (id: string) => {
    setCategories((prev) => prev.filter((c) => c.id !== id));
  };

  /**
   * ピッカーから選択したカテゴリ定義 (or null = 自由記述) を末尾に追加。
   * 既に同じ key が存在する場合は重複追加せず、その行に focus する想定だが、
   * ピッカー側で既存カテゴリを disabled にしているので基本到達しない。
   */
  const handlePickCategory = (def: CategoryDef | null) => {
    setPickerOpen(false);
    if (def === null) {
      setCategories((prev) => [
        ...prev,
        { id: genId(), key: null, label: "自由記述", value: "" },
      ]);
    } else {
      setCategories((prev) => [
        ...prev,
        { id: genId(), key: def.key, label: def.label, value: "" },
      ]);
    }
  };

  const handleApply = () => {
    onApply(serializeCategories(categories));
    onClose();
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;
    setCategories((prev) => {
      const fromIdx = prev.findIndex((c) => c.id === active.id);
      const toIdx = prev.findIndex((c) => c.id === over.id);
      if (fromIdx < 0 || toIdx < 0) return prev;
      return arrayMove(prev, fromIdx, toIdx);
    });
  };

  const activeCategory = activeId
    ? categories.find((c) => c.id === activeId) ?? null
    : null;

  return (
    <ModalPortal>
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ヘッダ */}
        <div className="flex items-center justify-between gap-3 border-b border-[#242424] px-6 py-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
              EDIT
            </p>
            <h3 className="text-sm font-black text-white">要素別プロンプト編集</h3>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              カテゴリごとに編集できます。左端のグリップをドラッグで並べ替え可能。
              textarea の中身はカンマ区切りで英語のまま (AI に送る最終形式)。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md border border-[#343434] bg-[#101010] px-3 py-1 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            × 閉じる
          </button>
        </div>

        {/* 本体: カテゴリリスト */}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-6">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={categories.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {categories.map((cat) => (
                <SortableRow
                  key={cat.id}
                  category={cat}
                  onUpdate={(v) => updateValue(cat.id, v)}
                  onRemove={() => removeCategory(cat.id)}
                />
              ))}
            </SortableContext>
            <DragOverlay dropAnimation={{ duration: 150 }}>
              {activeCategory ? <DragGhost category={activeCategory} /> : null}
            </DragOverlay>
          </DndContext>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="mt-2 self-start rounded border border-dashed border-[#444] px-3 py-2 text-xs font-bold text-neutral-400 hover:border-pink-400 hover:text-pink-300"
          >
            + カテゴリを追加
          </button>
        </div>

        {/* フッター */}
        <div className="flex items-center justify-end gap-2 border-t border-[#242424] px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-[#343434] bg-[#101010] px-4 text-xs font-bold text-neutral-300 hover:border-[#555] hover:text-white"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="h-9 rounded-md bg-pink-500 px-4 text-xs font-black text-white hover:bg-pink-600"
          >
            適用
          </button>
        </div>
      </div>
      {/* カテゴリ追加ピッカー */}
      {pickerOpen && (
        <CategoryPicker
          existingKeys={new Set(categories.map((c) => c.key).filter((k): k is string => k !== null))}
          onPick={handlePickCategory}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
    </ModalPortal>
  );
}
