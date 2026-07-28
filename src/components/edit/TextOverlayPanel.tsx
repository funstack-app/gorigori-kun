import { useEffect, useState } from "react";

import { editFonts } from "../../lib/ipc";
import type { FontInfo } from "../../lib/edit/types";
import type { NormalizedBbox } from "./RegionSelectOverlay";

/**
 * 「セリフ・文字を直す」の入力パネル (2026-07-28)。
 *
 * ## なぜ AI を通さないのか
 *
 * 吹き出しのセリフを範囲指定の AI 修正で書き換えると、文字が崩壊する
 * (STΛCK 実測)。画像生成モデルは文字を「描く」のが構造的に苦手で、日本語では
 * さらに悪化する。ここは**下地を塗って、その上にフォントで文字を載せる**という
 * 決定論の経路にする。即時・無料・文字化けゼロ・全 OS で同じ結果。
 *
 * ## 手順は3つだけ
 *
 *   1. 直したいセリフをドラッグで囲む (RegionSelectOverlay を流用)
 *   2. 下地の色を決める (既定は白。スポイトで元画像の色も拾える)
 *   3. 文字を打って「文字を置く」
 *
 * 塗りと文字は 1 レイヤーずつ普通に載るので、後から動かす・undo する・
 * 書き出すは既存の仕組みにそのまま乗る。
 */

export type TextOverlayValues = {
  text: string;
  orientation: "vertical" | "horizontal";
  fontSize: number;
  color: string;
  fontFamily: string;
  fillColor: string;
};

type Props = {
  region: NormalizedBbox | null;
  values: TextOverlayValues;
  onChange: (patch: Partial<TextOverlayValues>) => void;
  onApply: () => void;
  onExit: () => void;
  /** スポイト待機中か。押すと親がキャンバスのクリックを1回だけ色拾いに使う。 */
  eyedropperActive: boolean;
  onToggleEyedropper: () => void;
  busy?: boolean;
  /**
   * 置いた文字を選び直しているか (再編集モード)。
   * true のときは「新しく置く」ではなく、いま選んでいる文字を直す画面になる。
   */
  editingExisting?: boolean;
  /** 再編集モードで、値の変更が確定した (スライダーを離した等) ことを親へ伝える。 */
  onCommit?: () => void;
};

export function TextOverlayPanel({
  region,
  values,
  onChange,
  onApply,
  onExit,
  eyedropperActive,
  onToggleEyedropper,
  busy,
  editingExisting,
  onCommit,
}: Props) {
  const [fonts, setFonts] = useState<FontInfo[]>([]);

  // 日本語フォントを優先して並べる (セリフの打ち替えが主用途)。
  // 取得に失敗してもパネルは壊さない — その場合は既定フォント1つで進める。
  useEffect(() => {
    let cancelled = false;
    editFonts
      .list("ja")
      .then((list) => {
        if (!cancelled) setFonts(list);
      })
      .catch(() => {
        if (!cancelled) setFonts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canApply = Boolean(region) && !busy;
  // 再編集中は「入力するたびキャンバスに反映される」ので確定ボタンが要らない。
  // 新規は「囲む → 打つ → 置く」なので置くボタンが要る。ここで画面が二役を持つ。
  const editing = Boolean(editingExisting);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-black text-white">
          {editing ? "この文字を直す" : "セリフ・文字を直す"}
        </h3>
        <button
          type="button"
          onClick={onExit}
          className="shrink-0 rounded border border-[#3a3a3a] px-2 py-0.5 text-[10px] font-bold text-neutral-400 hover:border-pink-400 hover:text-white"
        >
          やめる
        </button>
      </div>
      <p className="mt-1 text-[10px] font-bold leading-4 text-neutral-500">
        {editing
          ? "選んでいる文字を直します。変えるとすぐ反映されます。"
          : "直したいセリフをドラッグで囲むと、そこを塗りつぶして文字を置き直せます。AIは使わないので、文字が崩れません。"}
      </p>

      {/* 今どの段階かを1行で見せる。囲む前に文字だけ打って「効かない」を防ぐ。 */}
      <div className="mt-2.5 rounded-lg border border-[#343434] bg-[#1c1c1c] px-2.5 py-2">
        <span className="text-[10px] font-bold leading-4 text-neutral-300">
          {editing
            ? "文字を選んでいます。ドラッグで動かす・四隅で大きさを変えるもできます。"
            : region
              ? "囲みました。下に文字を入れてください。"
              : "まず、直したいところをドラッグで囲んでください。"}
        </span>
      </div>

      {/*
        下地の色は「これから塗る範囲」の設定なので、既にある文字を直している間は
        出さない (下地は別レイヤーで、この文字の属性ではない)。関係のない
        つまみを見せると「押しても効かない」に見える。
      */}
      {editing ? null : (
        <>
          <label className="mt-3 block text-[10px] font-black text-neutral-400">下地の色</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              value={values.fillColor}
              onChange={(event) => onChange({ fillColor: event.target.value })}
              className="h-9 w-16 shrink-0 rounded-lg border border-[#343434] bg-[#0b0b0b] px-1"
            />
            <button
              type="button"
              onClick={() => onChange({ fillColor: "#ffffff" })}
              className="shrink-0 rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-2 py-1.5 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              白にもどす
            </button>
            {/*
              白い吹き出し以外 (色地の看板・帯) にも使えるように、元画像の色をそのまま拾う。
              押すとキャンバスのクリックが1回だけ色拾いに切り替わる。
            */}
            <button
              type="button"
              onClick={onToggleEyedropper}
              className={[
                "shrink-0 rounded-md border px-2 py-1.5 text-[10px] font-bold",
                eyedropperActive
                  ? "border-pink-400 bg-pink-500/20 text-pink-100"
                  : "border-[#3a3a3a] bg-[#1a1a1a] text-neutral-300 hover:border-pink-400 hover:text-white",
              ].join(" ")}
            >
              {eyedropperActive ? "色を選んでください" : "画像から色を拾う"}
            </button>
          </div>
        </>
      )}

      <label className="mt-3 block text-[10px] font-black text-neutral-400">文字の向き</label>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {([
          { id: "vertical", label: "縦書き" },
          { id: "horizontal", label: "横書き" },
        ] as const).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              onChange({ orientation: item.id });
              // 押した瞬間に確定する操作 (段階がない) なので、その場で履歴を1手積む。
              if (editing) onCommit?.();
            }}
            className={[
              "rounded-md border px-2 py-1.5 text-[11px] font-bold",
              values.orientation === item.id
                ? "border-pink-400 bg-pink-500/20 text-pink-100"
                : "border-[#3a3a3a] bg-[#1a1a1a] text-neutral-300 hover:border-pink-400 hover:text-white",
            ].join(" ")}
          >
            {item.label}
          </button>
        ))}
      </div>

      <label className="mt-3 block text-[10px] font-black text-neutral-400">入れる文字</label>
      <textarea
        value={values.text}
        onChange={(event) => onChange({ text: event.target.value })}
        // 打っている最中は履歴を積まない (1文字ごとに1手になってしまう)。
        // 入力欄から離れた時点をひとまとまりの操作として確定する。
        onBlur={() => {
          if (editing) onCommit?.();
        }}
        rows={4}
        placeholder="例: おはよう！"
        className="mt-1 w-full resize-none rounded-lg border border-[#343434] bg-[#101010] px-2.5 py-2 text-xs leading-5 text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400"
      />

      <label className="mt-3 block text-[10px] font-black text-neutral-400">
        文字の大きさ ({values.fontSize}px)
      </label>
      <input
        type="range"
        min={8}
        max={200}
        value={values.fontSize}
        onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
        // つまみを離した時点で1手にする (ドラッグ中の連続値で履歴を埋めない)。
        onPointerUp={() => {
          if (editing) onCommit?.();
        }}
        onKeyUp={() => {
          if (editing) onCommit?.();
        }}
        className="mt-1 w-full accent-pink-500"
      />

      <label className="mt-3 block text-[10px] font-black text-neutral-400">文字の色</label>
      <input
        type="color"
        value={values.color}
        onChange={(event) => onChange({ color: event.target.value })}
        onBlur={() => {
          if (editing) onCommit?.();
        }}
        className="mt-1 h-9 w-full rounded-lg border border-[#343434] bg-[#0b0b0b] px-2"
      />

      <label className="mt-3 block text-[10px] font-black text-neutral-400">フォント</label>
      <select
        value={values.fontFamily}
        onChange={(event) => {
          onChange({ fontFamily: event.target.value });
          if (editing) onCommit?.();
        }}
        className="mt-1 w-full rounded-lg border border-[#343434] bg-[#0b0b0b] px-2.5 py-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
      >
        {fonts.length === 0 ? (
          <option value={values.fontFamily}>{values.fontFamily}</option>
        ) : null}
        {fonts.map((font) => (
          <option key={font.family} value={font.family} style={{ fontFamily: font.family }}>
            {font.displayName}
          </option>
        ))}
      </select>

      {/*
        再編集中は入力がそのままキャンバスへ反映されるので、確定ボタンを置かない。
        押さないと反映されないボタンがあると「押し忘れ」が生まれる。
      */}
      {editing ? (
        <p className="mt-4 text-[10px] font-bold leading-4 text-neutral-500">
          変えたところは、すぐ画像に反映されます。位置はキャンバスでドラッグして決めてください。
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={onApply}
            disabled={!canApply}
            className="mt-4 h-10 w-full shrink-0 rounded-lg bg-pink-500 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            文字を置く
          </button>
          <p className="mt-1.5 text-[10px] font-bold leading-4 text-neutral-500">
            置いたあとは、そのままドラッグで動かしたり、四隅で大きさを変えたりできます。
          </p>
        </>
      )}
    </div>
  );
}

export default TextOverlayPanel;
