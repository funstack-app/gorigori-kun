import type {
  ComicColorMode,
  ComicEnvReference,
  ComicFrameStyle,
  ComicGutterStyle,
  ComicImageCharacter,
  ComicPageGenMode,
  ComicReadingDirection,
  PageCountChoice,
} from "../../../lib/comic/types";
import { MAX_STORY_PAGES } from "../../../lib/comic/prompts";
import {
  ALL_COMIC_LAYOUT_TEMPLATES,
  type ComicLayoutTemplate,
} from "../../../lib/comic/layoutTemplates";
import { compact } from "../../../lib/ui/foldSummary";
import { REFERENCE_ROLE_META } from "../../../lib/store/referenceRoles";
import { usePresets } from "../../../lib/store/presets";
import { SafeImage } from "../../SafeImage";
import { COMIC_TEMPLATE_THUMBNAILS } from "./templateThumbnails";

const AUTO_TEMPLATE_ID = "auto";

/**
 * 絵柄のクイック選択チップ（qvs 2026-08-03）。
 * クリックでテキスト欄へ確定英語句をセットするだけの決定論UI（トグルではなく上書き）。
 * プロンプト定数だが UI 専属なので comic/prompts.ts へは置かない。
 */
const COMIC_STYLE_CHIPS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: "少年漫画",
    text: "shonen manga style, dynamic bold ink lines, high-energy action shading",
  },
  {
    label: "少女漫画",
    text: "shojo manga style, delicate thin lines, sparkling decorative screentones, expressive large eyes",
  },
  {
    label: "劇画",
    text: "gekiga style, heavy dramatic ink shading, realistic proportions, gritty texture",
  },
  {
    label: "ゆるコメディ",
    text: "loose comedy manga style, simple rounded lines, minimal shading",
  },
  {
    label: "アメコミ",
    text: "american comic book style, bold outlines, dramatic shadows, halftone dots",
  },
  {
    label: "水彩",
    text: "soft watercolor illustration style, gentle color bleeding, hand-painted texture",
  },
];

type CharacterPresets = ReturnType<typeof usePresets.getState>["presets"];

export function buildLayoutSummary(
  pageGenMode: ComicPageGenMode,
  templateId: string,
  pageCountChoice: PageCountChoice,
): string {
  const modeLabel =
    pageGenMode === "aligned" ? "きっちりコマ割り" : "おまかせ一枚描き";
  const template = ALL_COMIC_LAYOUT_TEMPLATES.find((item) => item.id === templateId);
  const templateLabel =
    templateId === AUTO_TEMPLATE_ID
      ? "おまかせ"
      : template
        ? `${template.label}（${template.panelCount}コマ）`
        : "未設定";
  const pageLabel =
    pageCountChoice === "auto" ? "ページ数おまかせ" : `${pageCountChoice}ページ`;
  return compact(modeLabel, templateLabel, pageLabel);
}

export function buildArtStyleSummary(
  colorMode: ComicColorMode,
  styleText: string,
  hasStyleAnchor = false,
): string {
  if (colorMode === "faithful") {
    return compact(
      "キャラ忠実（参照の画風を維持）",
      hasStyleAnchor ? "画風のお手本あり" : "",
    );
  }
  const colorLabel = colorMode === "mono" ? "白黒（標準）" : "カラー";
  return compact(colorLabel, styleText, hasStyleAnchor ? "画風のお手本あり" : "");
}

export type ComicStyleAnchorOption = {
  id: string;
  name: string;
  imagePath: string;
};

export function buildFormatSummary(
  readingDirection: ComicReadingDirection,
  frameStyle: ComicFrameStyle,
  gutterStyle: ComicGutterStyle,
): string {
  const dirLabel = readingDirection === "rtl" ? "右→左" : "左→右";
  const frameLabel =
    frameStyle === "thin" ? "細い" : frameStyle === "bold" ? "太い" : "標準";
  const gutterLabel =
    gutterStyle === "narrow" ? "狭い" : gutterStyle === "wide" ? "広い" : "標準";
  return compact(`${dirLabel}・枠線 ${frameLabel}・間隔 ${gutterLabel}`);
}

export function buildCastSummary(
  characterPresets: CharacterPresets,
  selectedIds: string[],
  imageCharacters: ComicImageCharacter[],
  envReferences: ComicEnvReference[],
): string {
  const presetNames = selectedIds.flatMap((id) => {
    const preset = characterPresets.find((item) => item.id === id);
    return preset ? [preset.name] : [];
  });
  const castNames = [...presetNames, ...imageCharacters.map((item) => item.name)].join("・");
  const envSummary = envReferences.length > 0 ? `＋背景小物${envReferences.length}点` : "";
  return compact(`${castNames}${castNames && envSummary ? " " : ""}${envSummary}`);
}

/**
 * 多角形コマの枠線・塗りを描く SVG オーバーレイ。
 * ページ/サムネの percent 座標系 (0-100) を preserveAspectRatio="none" で
 * コンテナへ引き伸ばし、div の percent 配置と完全に一致させる。
 * vectorEffect="non-scaling-stroke" で線幅は表示pxで一定（縮小オフセット計算は不要）。
 */
function PolygonFrameOverlay({
  template,
  stroke,
  strokeWidth,
  fill = "none",
}: {
  template: ComicLayoutTemplate;
  stroke: string;
  strokeWidth: number;
  fill?: string;
}) {
  const polys = template.slots.filter((s) => s.points);
  if (polys.length === 0) return null;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {polys.map((slot, i) => (
        <polygon
          key={i}
          points={(slot.points ?? []).map((p) => p.join(",")).join(" ")}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/**
 * コマ割りテンプレのミニプレビュー。
 *
 * マンガ01〜12 は STΛCK 提供の参照画像を12分割したサムネ画像を出す
 * (COMIC_TEMPLATE_THUMBNAILS。STΛCK 指示 2026-07-28)。
 * それ以外はスロット定義（percent 座標）だけから CSS で描くので、画像アセットを
 * 持たずテンプレを足せば自動で絵が付く（配布時のリソース漏れも起きない）。
 */
function TemplateMiniPreview({
  template,
  selected,
}: {
  template: ComicLayoutTemplate;
  selected: boolean;
}) {
  const thumbnail = COMIC_TEMPLATE_THUMBNAILS[template.id];
  return (
    <div
      className={`relative w-full max-h-[72px] overflow-hidden rounded-sm border ${
        selected ? "border-pink-400 bg-white/90" : "border-[#3a3a3a] bg-[#0f0f0f]"
      }`}
      style={{ aspectRatio: `${template.pageAspect.w} / ${template.pageAspect.h}` }}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          className={`h-full w-full object-contain ${selected ? "" : "opacity-70 invert"}`}
        />
      ) : (
        <>
          {template.slots.map((slot, i) =>
            slot.points ? null : (
              <div
                key={i}
                className={`absolute border ${
                  selected ? "border-pink-600 bg-pink-500/20" : "border-neutral-600 bg-[#1c1c1c]"
                }`}
                style={{
                  left: `${slot.x}%`,
                  top: `${slot.y}%`,
                  width: `${slot.w}%`,
                  height: `${slot.h}%`,
                }}
              />
            ),
          )}
          <PolygonFrameOverlay
            template={template}
            stroke={selected ? "#db2777" : "#525252"}
            strokeWidth={1}
            fill={selected ? "rgba(236,72,153,0.2)" : "#1c1c1c"}
          />
        </>
      )}
    </div>
  );
}

export function LayoutSection({
  pageGenMode,
  setPageGenMode,
  templateId,
  setTemplateId,
  pageCountChoice,
  setPageCountChoice,
}: {
  pageGenMode: ComicPageGenMode;
  setPageGenMode: (v: ComicPageGenMode) => void;
  templateId: string;
  setTemplateId: (v: string) => void;
  pageCountChoice: PageCountChoice;
  setPageCountChoice: (v: PageCountChoice) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          つくり方
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(
            [
              {
                value: "direct",
                label: "おまかせ一枚描き",
                description: "AIがページ全体を1枚の絵として描きます（構図の勢い優先）",
              },
              {
                value: "aligned",
                label: "きっちりコマ割り",
                description: "1枚で描いてから、コマ枠をテンプレどおりに揃えます",
              },
            ] as const
          ).map((option) => {
            const selected = pageGenMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setPageGenMode(option.value)}
                aria-pressed={selected}
                className={`flex flex-col gap-1 rounded-md border px-3 py-2 text-left transition ${
                  selected
                    ? "border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-300 hover:border-pink-500/40"
                }`}
              >
                <span className="text-xs font-semibold">{option.label}</span>
                <span className="text-[11px] leading-relaxed text-neutral-500">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          コマ割りの参考（任意）
        </label>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {(() => {
            const selected = templateId === AUTO_TEMPLATE_ID;
            return (
              <button
                type="button"
                onClick={() => setTemplateId(AUTO_TEMPLATE_ID)}
                className={`flex w-full flex-col items-center gap-2 rounded-md border px-2 py-2 text-[11px] font-medium transition ${
                  selected
                    ? "border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <div
                  className={`flex w-full max-h-[72px] items-center justify-center overflow-hidden rounded-sm border ${
                    selected
                      ? "border-pink-400 bg-pink-500/10"
                      : "border-[#3a3a3a] bg-[#0f0f0f]"
                  }`}
                  style={{ aspectRatio: "3 / 4" }}
                >
                  <span className="text-[11px]">AIが最適化</span>
                </div>
                <span className="flex flex-col items-center gap-0.5 leading-tight">
                  <span className="text-center">おまかせ</span>
                </span>
              </button>
            );
          })()}
          {ALL_COMIC_LAYOUT_TEMPLATES.map((t) => {
            const selected = templateId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplateId(t.id)}
                className={`flex w-full flex-col items-center gap-2 rounded-md border px-2 py-2 text-[11px] font-medium transition ${
                  selected
                    ? "border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <TemplateMiniPreview template={t} selected={selected} />
                <span className="flex flex-col items-center gap-0.5 leading-tight">
                  <span className="text-center">{t.label}</span>
                  <span className="text-center text-[11px] font-normal text-neutral-400">
                    {t.panelCount}コマ
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label
          className="mb-1.5 block text-xs font-medium text-neutral-400"
          htmlFor="comic-page-count"
        >
          ページ数
        </label>
        {/*
          ページ数の上限は撤廃（2026-07-28 STΛCK指示）。ページ生成は並列で発行し、
          Rust の GLOBAL_GEN_SEMAPHORE が順番に消化するため、枚数の安全弁は
          そちらが持つ。ここでは 1 以上であることだけを守る。
        */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={pageCountChoice === "auto"}
              onChange={(e) =>
                setPageCountChoice(e.target.checked ? "auto" : MAX_STORY_PAGES)
              }
              className="h-3.5 w-3.5 accent-pink-500"
            />
            おまかせ
          </label>
          <input
            id="comic-page-count"
            type="number"
            min={1}
            step={1}
            disabled={pageCountChoice === "auto"}
            value={pageCountChoice === "auto" ? "" : String(pageCountChoice)}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (!Number.isFinite(n) || n < 1) return;
              setPageCountChoice(n);
            }}
            className="w-20 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none disabled:opacity-40"
          />
        </div>
      </div>
    </div>
  );
}

export function ArtStyleSection({
  colorMode,
  setColorMode,
  styleText,
  setStyleText,
  styleAnchorImagePath,
  styleAnchorOptions,
  styleAnchorBusy,
  onPickStyleAnchorFromLedger,
  onOpenStyleAnchorLibrary,
  onPickStyleAnchorFile,
  onClearStyleAnchor,
}: {
  colorMode: ComicColorMode;
  setColorMode: (v: ComicColorMode) => void;
  styleText: string;
  setStyleText: (v: string) => void;
  styleAnchorImagePath: string | null;
  styleAnchorOptions: ComicStyleAnchorOption[];
  styleAnchorBusy: boolean;
  onPickStyleAnchorFromLedger: (path: string) => void;
  onOpenStyleAnchorLibrary: () => void;
  onPickStyleAnchorFile: () => void;
  onClearStyleAnchor: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          画風
        </label>
        <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
          {(
            [
              { value: "mono", label: "白黒（標準）" },
              { value: "color", label: "カラー" },
              { value: "faithful", label: "キャラ忠実" },
            ] as const
          ).map((option) => {
            const selected = colorMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setColorMode(option.value)}
                aria-pressed={selected}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  selected
                    ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border border-transparent text-neutral-400 hover:text-pink-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {/* faithful のときだけ、何が起きるかを1行で説明する（他の画風には出さない）。 */}
        {colorMode === "faithful" && (
          <p className="mt-1 text-[11px] text-neutral-500">
            リファレンス画像の画風・質感をそのまま保って作ります（漫画調への変換をしません）。
          </p>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          画風のお手本（任意）
        </label>
        {styleAnchorImagePath ? (
          <div className="mb-2 flex items-center gap-3 rounded-md border border-pink-500/30 bg-pink-500/5 p-2.5">
            <SafeImage
              path={styleAnchorImagePath}
              alt="画風のお手本"
              className="h-16 w-12 shrink-0 rounded bg-[#101010] object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-pink-200">設定済み</p>
              <p className="mt-1 text-[11px] leading-4 text-neutral-500">
                以後のページとコマは、この画像の線・塗り・質感へ合わせます。
              </p>
            </div>
            <button
              type="button"
              onClick={onClearStyleAnchor}
              disabled={styleAnchorBusy}
              className="rounded border border-[#343434] px-2 py-1 text-[11px] text-neutral-300 transition hover:border-rose-400/60 hover:text-rose-300 disabled:opacity-40"
            >
              解除
            </button>
          </div>
        ) : (
          <p className="mb-2 rounded-md border border-dashed border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2.5 text-[11px] leading-4 text-neutral-500">
            未設定では、これまでどおり文章だけで画風を指定します。最初のページを保存すると、そのページを自動でお手本にします。
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <select
            value=""
            onChange={(event) => {
              if (event.target.value) onPickStyleAnchorFromLedger(event.target.value);
            }}
            disabled={styleAnchorBusy || styleAnchorOptions.length === 0}
            aria-label="台帳のルックから画風のお手本を選ぶ"
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 outline-none transition focus:border-pink-500/50 disabled:opacity-40"
          >
            <option value="">
              {styleAnchorOptions.length > 0
                ? "台帳のルックから選ぶ"
                : "台帳のルックはありません"}
            </option>
            {styleAnchorOptions.map((option) => (
              <option key={option.id} value={option.imagePath}>
                {option.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onOpenStyleAnchorLibrary}
            disabled={styleAnchorBusy}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:opacity-40"
          >
            ライブラリから選ぶ
          </button>
          <button
            type="button"
            onClick={onPickStyleAnchorFile}
            disabled={styleAnchorBusy}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:opacity-40"
          >
            ローカルから選ぶ
          </button>
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          選んだ画像はアプリ内へ複製するため、元画像を移動しても使えます。
        </p>
      </div>

      {/* qvs (2026-08-03): 絵柄をキャラ参照と分離したテキスト項目で指定する。
          faithful は参照画像が絵柄の供給源なので構造的に排他＝無効化する。 */}
      <div>
        <label
          className="mb-1.5 block text-xs font-medium text-neutral-400"
          htmlFor="comic-style-text"
        >
          絵柄の指定（任意）
        </label>
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {COMIC_STYLE_CHIPS.map((chip) => {
            const selected = styleText === chip.text;
            return (
              <button
                key={chip.label}
                type="button"
                onClick={() => setStyleText(chip.text)}
                disabled={colorMode === "faithful"}
                aria-pressed={selected}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  selected
                    ? "border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-300 hover:border-pink-500/40 hover:text-white"
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
        <input
          id="comic-style-text"
          value={styleText}
          onChange={(e) => setStyleText(e.target.value)}
          disabled={colorMode === "faithful"}
          placeholder="例: 劇画タッチ、太い主線、リアルな陰影"
          aria-label="絵柄の指定"
          className="w-full rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-pink-500/50 focus:outline-none disabled:opacity-40"
        />
        <p className="mt-1 text-[11px] text-neutral-500">
          {colorMode === "faithful"
            ? "「キャラ忠実」ではリファレンス画像の画風を使うため、絵柄の指定は無効になります。"
            : "白黒／カラーの選択が優先されます。絵柄はその中でのタッチの指定です（毎回同じ見た目になる保証はありません）。"}
        </p>
      </div>
    </div>
  );
}

export function FormatSection({
  readingDirection,
  setReadingDirection,
  frameStyle,
  setFrameStyle,
  gutterStyle,
  setGutterStyle,
}: {
  pageGenMode: ComicPageGenMode;
  readingDirection: ComicReadingDirection;
  setReadingDirection: (v: ComicReadingDirection) => void;
  frameStyle: ComicFrameStyle;
  setFrameStyle: (v: ComicFrameStyle) => void;
  gutterStyle: ComicGutterStyle;
  setGutterStyle: (v: ComicGutterStyle) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          読み方向
        </label>
        <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
          {(
            [
              { value: "rtl", label: "右→左（日本式・標準）" },
              { value: "ltr", label: "左→右" },
            ] as const
          ).map((option) => {
            const selected = readingDirection === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setReadingDirection(option.value)}
                aria-pressed={selected}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  selected
                    ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border border-transparent text-neutral-400 hover:text-pink-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          枠線の太さ
        </label>
        <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
          {(
            [
              { value: "thin", label: "細い" },
              { value: "standard", label: "標準" },
              { value: "bold", label: "太い" },
            ] as const
          ).map((option) => {
            const selected = frameStyle === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setFrameStyle(option.value)}
                aria-pressed={selected}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  selected
                    ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border border-transparent text-neutral-400 hover:text-pink-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          コマの間隔
        </label>
        <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
          {(
            [
              { value: "narrow", label: "狭い" },
              { value: "standard", label: "標準" },
              { value: "wide", label: "広い" },
            ] as const
          ).map((option) => {
            const selected = gutterStyle === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setGutterStyle(option.value)}
                aria-pressed={selected}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  selected
                    ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border border-transparent text-neutral-400 hover:text-pink-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          読み方向・枠線・コマ間隔・吹き出しの種類はAIへの指示で近づけます。毎回同じ見た目になる保証はありません。
        </p>
      </div>
    </div>
  );
}

export function CastSection({
  characterPresets,
  selectedIds,
  toggleCharacter,
  imageCharacters,
  onPickFiles,
  onOpenLibrary,
  onRenameImageChar,
  onRestoreImageCharName,
  onRemoveImageChar,
  envReferences,
  onPickEnvFiles,
  onOpenEnvLibrary,
  onRenameEnvRef,
  onRestoreEnvRefName,
  onToggleEnvRefKind,
  onRemoveEnvRef,
}: {
  characterPresets: CharacterPresets;
  selectedIds: string[];
  toggleCharacter: (id: string) => void;
  imageCharacters: ComicImageCharacter[];
  onPickFiles: () => void;
  onOpenLibrary: () => void;
  onRenameImageChar: (id: string, name: string) => void;
  onRestoreImageCharName: (id: string) => void;
  onRemoveImageChar: (id: string) => void;
  envReferences: ComicEnvReference[];
  onPickEnvFiles: () => void;
  onOpenEnvLibrary: () => void;
  onRenameEnvRef: (id: string, name: string) => void;
  onRestoreEnvRefName: (id: string) => void;
  onToggleEnvRefKind: (id: string) => void;
  onRemoveEnvRef: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          登場キャラ（登録キャラ・画像から追加）
        </label>
        {characterPresets.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#2a2a2a] bg-[#1a1a1a] px-3 py-3 text-xs text-neutral-500">
            登録キャラがありません。キャラを登録すると、同一キャラでコマを生成できます（キャラなしでも話は作れます）。
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {characterPresets.map((p) => {
              const selected = selectedIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggleCharacter(p.id)}
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition ${
                    selected
                      ? "border-pink-500 bg-pink-500/10 text-pink-100"
                      : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-300 hover:border-[#3a3a3a]"
                  }`}
                >
                  {p.thumbnail && (
                    <img src={p.thumbnail} alt="" className="h-6 w-6 rounded object-cover" />
                  )}
                  {p.name}
                </button>
              );
            })}
          </div>
        )}

        {imageCharacters.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {imageCharacters.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5"
              >
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded">
                  <SafeImage
                    path={c.imagePath}
                    alt={c.name}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <input
                    value={c.name}
                    onChange={(e) => onRenameImageChar(c.id, e.target.value)}
                    // 空名はネーム配役・参照解決を壊すため、既定名へ戻す（黙って壊さない）。
                    onBlur={() => onRestoreImageCharName(c.id)}
                    className="w-24 rounded border border-[#2a2a2a] bg-[#121212] px-1.5 py-0.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                    aria-label="キャラ名"
                  />
                  <span className="text-[10px] text-neutral-500">
                    {c.source === "file" ? "添付" : "ライブラリ"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveImageChar(c.id)}
                  className="rounded px-1 text-neutral-500 transition hover:text-rose-400"
                  title={`${c.name} を削除`}
                  aria-label={`${c.name} を削除`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onPickFiles}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            画像を追加
          </button>
          <button
            type="button"
            onClick={onOpenLibrary}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            ライブラリから選ぶ
          </button>
        </div>
      </div>

      {/* 3ir (2026-08-03): 背景・小物の環境参照。全ページに一律添付して
          「ドアのデザインがページ間で変わる」問題を直接解消する。 */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          背景・小物（ページ間でデザイン固定・任意）
        </label>
        {envReferences.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#2a2a2a] bg-[#1a1a1a] px-3 py-3 text-xs text-neutral-500">
            ドア・部屋・持ち物などの画像を追加すると、全ページで同じデザインに固定されやすくなります。
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {envReferences.map((ref) => (
              <div
                key={ref.id}
                className="flex items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5"
              >
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded">
                  <SafeImage
                    path={ref.imagePath}
                    alt={ref.name}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <input
                    value={ref.name}
                    onChange={(e) => onRenameEnvRef(ref.id, e.target.value)}
                    // 空名はプロンプトの参照名を壊すため、既定名へ戻す。
                    onBlur={() => onRestoreEnvRefName(ref.id)}
                    className="w-24 rounded border border-[#2a2a2a] bg-[#121212] px-1.5 py-0.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                    aria-label="参照の名前"
                  />
                  <button
                    type="button"
                    onClick={() => onToggleEnvRefKind(ref.id)}
                    title={REFERENCE_ROLE_META[ref.kind].description}
                    className="rounded border border-[#2a2a2a] bg-[#121212] px-1.5 py-0.5 text-[10px] text-neutral-300 transition hover:border-pink-500/40 hover:text-pink-200"
                  >
                    {REFERENCE_ROLE_META[ref.kind].label}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveEnvRef(ref.id)}
                  className="rounded px-1 text-neutral-500 transition hover:text-rose-400"
                  title={`${ref.name} を削除`}
                  aria-label={`${ref.name} を削除`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onPickEnvFiles}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            画像を追加
          </button>
          <button
            type="button"
            onClick={onOpenEnvLibrary}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            ライブラリから選ぶ
          </button>
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          背景・小物はAIへの指示と参照画像で近づけます。毎回完全に同じになる保証はありません。
        </p>
      </div>
    </div>
  );
}
