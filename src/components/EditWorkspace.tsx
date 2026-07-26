import { useEffect, useState } from "react";

import { images as imagesIpc } from "../lib/ipc";
import { useBatches } from "../lib/store/batches";
import { beginDirectRun } from "../lib/store/generationStatus";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { EditorCanvas } from "./edit/EditorCanvas";
import type { NormalizedBbox } from "./edit/RegionSelectOverlay";
import { useEditor } from "./edit/editor/editorStore";
import { useEditorActions } from "./edit/editor/useEditor";

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 編集タブ = 「ことばで直す」だけの画面 (2026-07-26 STΛCK 指示で全面再設計)。
 *
 * ## なぜ道具を全部外したか
 *
 * 直前まではレイヤー分解・人物切り抜き・図形・テキスト追加・領域消去など
 * 11個の道具が左レールと右パネルに並び、AI編集はその中の1パネルでしかなかった。
 * 結果「何をする画面なのか分からない」状態になっていた (STΛCK 指摘)。
 *
 * レイヤー分解系はさらに 3つの弱点を抱えていた:
 *   - ローカル AI (ort/ONNX) のモデル DL が要る = 初回に長い待ちが発生する
 *   - Intel Mac では動かない (v2.0.0 で Intel 版の配布を止めた原因そのもの)
 *   - 分解を経ないと他の道具が使えず、必須の関門になっていた
 *
 * 対して「ことばで直す」は通常の画像生成と同じ経路 (images_generate_batch) だけに
 * 依存する。モデル DL 不要・全 OS で同じに動く。**やることを1つに絞る**。
 *
 * ## 外した道具の行き先
 *
 * 部品 (EditorToolbar / EditorLayerList / EditPrimaryAction / WordsToolPanel 等) は
 * 削除せずファイルとして残している。理由は 2つ:
 *   - 赤入れ反映スキルが useEditorActions().applyRedlineFix を使っており、
 *     その内部実装がレイヤー機構の上に載っている (消すと赤入れが壊れる)
 *   - 「レイヤー分解に戻したい」となったとき、復帰が import 1行で済む
 * 画面に出さないだけで、機構は生きている。
 *
 * ## 範囲指定 (2026-07-26 追記)
 *
 * ChatGPT の画像編集と同じで「直したい場所を囲んでから言う」ができる。
 * 囲まなければ従来どおり画像全体。**道具は増やさない** — 増えたのは
 * 「キャンバスをドラッグすると四角ができる」ことだけで、押すボタンは
 * 「AIで直す」1つのまま。
 *
 * 範囲ありのときは applyRedlineFix (赤入れ反映と同じ経路) に流す。自前で
 * マスク生成を書き直さないのは、この経路がマスク外の非改変を**画素レベルで**
 * 保証しているため (詳細は下の runRegion() のコメント)。
 */
export function EditWorkspace() {
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const busyTool = useEditor((state) => state.busyTool);
  const { chooseImage, performUndo, performRedo, exportPng, applyRedlineFix } =
    useEditorActions();

  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 直す範囲 (0..1 の正規化 bbox)。null = 画像全体。 */
  const [region, setRegion] = useState<NormalizedBbox | null>(null);

  // 画像を差し替えたら選択は無効になる (前の画像の座標を持ち越さない)。
  useEffect(() => {
    setRegion(null);
  }, [sourceImagePath]);

  const canRun = Boolean(sourceImagePath && instruction.trim()) && !busy && busyTool === null;

  // Cmd/Ctrl+Z = 元に戻す / Cmd/Ctrl+Shift+Z = やり直す。
  // 編集タブ表示中だけ有効 (このコンポーネントがマウントされている間だけ listener を張る)。
  // input / textarea / contentEditable にフォーカスがあるときは発火しない
  // (テキスト入力の標準 Undo を奪わないため)。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        void performRedo();
      } else {
        void performUndo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [performUndo, performRedo]);

  /**
   * 選んだ範囲だけを直す。
   *
   * ## なぜ applyRedlineFix を使い回すのか (自前でマスクを作らない理由)
   *
   * 「マスクを渡す」だけでは、その範囲だけが変わる保証にならない。
   * Rust 側 (batch_gen.rs build_final_prompt) はマスク画像を画像生成モデルへの
   * **プロンプト上の指示**として添えているだけで、モデルが素直に従う保証はない。
   * 実際 build_final_prompt は「白い領域だけ編集、それ以外は 1 ピクセルも変更しない」
   * と文章で頼んでいるにすぎない。ここで止めると「範囲を選んだのに全体が変わる」
   * という、押せるのに効かない機能になる。
   *
   * applyRedlineFix はその先を持っている:
   *   1. 正規化 bbox → 元画像の実寸マスク PNG (buildFullSizeMaskFromNormalizedBbox)
   *   2. 生成 (マスク付き)
   *   3. buildDiffPatch(..., limitToBbox=true) で、**bbox の外の画素の alpha を 0 に
   *      叩き落とした透過パッチ**を作り、元画像の上に同じ座標で重ねる
   * つまりモデルが範囲外を描き変えてしまっても、その画素は透明にされて捨てられ、
   * 下の元画像がそのまま見える。非改変は文章のお願いではなく合成で担保される。
   */
  const runRegion = async () => {
    const prompt = instruction.trim();
    if (!sourceImagePath || !prompt || !region || busy) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await applyRedlineFix(sourceImagePath, region, prompt);
      if (applied) {
        useToasts.getState().push({
          kind: "success",
          text: "囲んだところだけ直しました。外側の画素は変えていません。⌘Zで戻せます。",
          ttlMs: 5200,
        });
        setInstruction("");
      } else {
        // applyRedlineFix は失敗理由を editor store の error に入れる。
        // キャンバス下部のエラーカードに出るので、ここで二重に出さない。
        setError("直せませんでした。キャンバス下のメッセージを確認してください。");
      }
    } catch (err) {
      setError(`直せませんでした: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (region) {
      await runRegion();
      return;
    }
    const prompt = instruction.trim();
    if (!sourceImagePath || !prompt || busy) return;

    const threads = useThreads.getState();
    const tempId = `ai-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setBusy(true);
    setError(null);

    // 右上の生成状況パネルに出す (フリーズに見えないようにする)。
    const track = beginDirectRun("aiEdit", 1, tempId);
    track.markStarted();
    useBatches.getState().startBatch({
      batchId: tempId,
      prompt,
      references: [{ path: sourceImagePath, name: basename(sourceImagePath) }],
      count: 1,
    });

    try {
      const result = await imagesIpc.generateBatch({
        prompt,
        count: 1,
        cwd: threads.cwd,
        refImagePaths: [sourceImagePath],
        model: threads.selectedModel,
        effort: threads.selectedEffort,
      });
      if (result.failedCount > 0) {
        // 失敗理由を握りつぶさない。errors[0] があればそのまま出す
        // (「失敗しました」だけだと原因が分からず問い合わせになる)。
        const detail = result.errors?.[0];
        setError(detail ? `直せませんでした: ${detail}` : "直せませんでした。");
        track.fail(detail ?? "編集に失敗しました");
      } else {
        track.markCompleted();
        // 結果は制作タブに届く。ここで何も起きないように見えると
        // 「動いていない」と誤解されるので、届いたことを明示する。
        useToasts.getState().push({
          kind: "success",
          text: "直した画像ができました。制作タブに届いています。",
          ttlMs: 3600,
        });
        setInstruction("");
      }
    } catch (err) {
      useBatches.getState().removeBatch(tempId);
      setError(`直せませんでした: ${String(err)}`);
      track.fail(String(err));
    } finally {
      // 成否にかかわらず状況パネルを閉じる (開いたままだと「まだ動いている」
      // ように見えてフリーズと区別できない)。
      track.done();
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#1e1e1e]">
      {/* 上部バー: 画像名と、画像の入れ替え・書き出しだけ。 */}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[#2a2a2a] bg-[#252525] px-3">
        <span
          className="min-w-0 flex-1 truncate text-xs font-bold text-neutral-300"
          title={sourceImagePath ?? undefined}
        >
          {sourceImagePath ? basename(sourceImagePath) : "画像未選択"}
        </span>
        {sourceImagePath ? (
          <>
            <button
              type="button"
              onClick={() => void exportPng()}
              disabled={busyTool !== null || busy}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              書き出し
            </button>
            <button
              type="button"
              onClick={() => void chooseImage()}
              disabled={busyTool !== null || busy}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              別の画像にする
            </button>
          </>
        ) : null}
      </header>

      {/* 本体: キャンバス (主役) + 右に指示欄だけ。左レールは廃止。 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {sourceImagePath ? (
          <>
            <EditorCanvas
              regionSelect={{
                value: region,
                onChange: setRegion,
                disabled: busy || busyTool !== null,
              }}
            />
            <aside className="flex min-h-0 w-[320px] shrink-0 flex-col border-l border-[#2a2a2a] bg-[#252525]">
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
                <h3 className="text-xs font-black text-white">ことばで直す</h3>
                <p className="mt-1 text-[10px] font-bold leading-4 text-neutral-500">
                  直したいところを、ふつうの日本語で書いてください。
                </p>

                {/*
                  どこが対象なのかを、押す前に必ず1行で見せる。
                  「全体に効いたつもりが一部だった」の取り違えが一番こわい。
                */}
                <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-[#343434] bg-[#1c1c1c] px-2.5 py-2">
                  <span className={region ? "text-pink-300" : "text-neutral-500"}>
                    {region ? <FrameIcon /> : <FullImageIcon />}
                  </span>
                  <span className="min-w-0 flex-1 text-[10px] font-bold leading-4 text-neutral-300">
                    {region ? "囲んだところだけ直す" : "画像ぜんぶを直す"}
                  </span>
                  {region ? (
                    <button
                      type="button"
                      onClick={() => setRegion(null)}
                      disabled={busy}
                      className="shrink-0 rounded border border-[#3a3a3a] px-1.5 py-0.5 text-[10px] font-bold text-neutral-400 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      範囲をやめる
                    </button>
                  ) : null}
                </div>
                <p className="mt-1 text-[10px] font-bold leading-4 text-neutral-500">
                  {region
                    ? "囲み直すには、もう一度ドラッグしてください。"
                    : "画像の上をドラッグで囲むと、そこだけ直せます。"}
                </p>

                <textarea
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  rows={5}
                  placeholder="例: 背景を夕暮れの海辺にする&#10;例: 服の色を白に変える&#10;例: 表情をもう少し笑顔にする"
                  className="mt-2.5 w-full resize-none rounded-lg border border-[#343434] bg-[#101010] px-2.5 py-2 text-xs leading-5 text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400"
                />

                <button
                  type="button"
                  onClick={() => void run()}
                  disabled={!canRun}
                  className="mt-2.5 h-10 w-full rounded-lg bg-pink-500 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
                >
                  {busy ? "AIが直しています…" : "AIで直す"}
                </button>

                {/*
                  行き先は範囲の有無で本当に変わる (全体=制作タブ / 範囲=この場で重なる)。
                  同じ文言を出すと「制作タブに無い」という問い合わせになるので出し分ける。
                */}
                <p className="mt-1.5 text-[10px] font-bold leading-4 text-neutral-500">
                  {region
                    ? "囲んだところだけを描き直し、この画面に重ねます。外側は変わりません。"
                    : "画像全体に対して実行します。結果は制作タブに届きます。"}
                </p>

                {error ? (
                  <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] font-bold leading-4 text-red-200">
                    {error}
                  </p>
                ) : null}

                <div className="mt-4 rounded-lg border border-[#333] bg-[#1c1c1c] p-2.5">
                  <p className="text-[10px] font-black text-neutral-400">コツ</p>
                  <ul className="mt-1.5 space-y-1 text-[10px] font-bold leading-4 text-neutral-500">
                    <li>・一度に1つずつ直すと、思ったとおりになりやすい</li>
                    <li>・「何を」「どうする」の形で書く</li>
                    <li>・気に入らなければ、そのまま書き直してもう一度</li>
                  </ul>
                </div>
              </div>
            </aside>
          </>
        ) : (
          /* 画像未選択: 迷わせない。やることは1つだけ置く。 */
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="w-full max-w-sm text-center">
              <h2 className="text-base font-black text-white">画像をことばで直す</h2>
              <p className="mt-2 text-xs font-bold leading-5 text-neutral-400">
                直したい画像を選んで、「背景を夕暮れにする」のように
                <br />
                ふつうの日本語で指示するだけです。
              </p>
              <button
                type="button"
                onClick={() => void chooseImage()}
                disabled={busyTool !== null}
                className="mt-5 h-11 w-full rounded-lg bg-pink-500 text-sm font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                {busyTool ? "処理中…" : "画像を選ぶ"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 範囲あり: 破線の枠 (囲んだ状態)。絵文字は使わない方針。 */
function FrameIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M9 12h6" />
    </svg>
  );
}

/** 範囲なし: 画像ぜんぶ。 */
function FullImageIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 15l4.5-4.5 4 4 3-3L21 16" />
      <circle cx="9" cy="9" r="1.4" />
    </svg>
  );
}

export default EditWorkspace;
