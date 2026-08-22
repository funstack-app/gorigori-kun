import { useEffect, useState } from "react";

import { images as imagesIpc } from "../lib/ipc";
import { useBatches } from "../lib/store/batches";
import { beginDirectRun } from "../lib/store/generationStatus";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { ReferenceLibraryModal } from "./ReferenceLibraryModal";
import { AdjustPanel } from "./edit/AdjustPanel";
import { CropPanel } from "./edit/CropPanel";
import { EditorCanvas } from "./edit/EditorCanvas";
import { ExportDialog } from "./edit/ExportDialog";
import { PlaceImagePanel } from "./edit/PlaceImagePanel";
import type { NormalizedBbox } from "./edit/RegionSelectOverlay";
import { TextOverlayPanel, type TextOverlayValues } from "./edit/TextOverlayPanel";
import {
  NEUTRAL_ADJUST,
  readAdjustFromCanvas,
  type AdjustValues,
} from "./edit/editor/adjustFilters";
import type { TransformKind } from "./edit/editor/canvasTransforms";
import { useEditor } from "./edit/editor/editorStore";
import type { ExportFormat, ExportSize } from "./edit/editor/exportImage";
import { readOverlayTextValues } from "./edit/editor/magicLayerToFabric";
import { useEditorActions } from "./edit/editor/useEditor";

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 「セリフ・文字を直す」の初期値。
 * 吹き出しの打ち替えが主用途なので、下地=白・文字=黒・縦書きから始める
 * (日本語の漫画・広告の既定)。フォントはヒラギノ角ゴ (mac 標準) を初期選択にし、
 * 一覧が取れたらユーザーが選び直せる。
 */
const DEFAULT_TEXT_VALUES: TextOverlayValues = {
  text: "",
  orientation: "vertical",
  fontSize: 32,
  color: "#000000",
  fontFamily: "Hiragino Sans",
  fillColor: "#ffffff",
};

/**
 * 編集タブの操作モード (2026-07-28 STΛCK 実機指摘で追加)。
 *
 * これまでは「ことばで直す」と「セリフ・文字を直す」の2択しかなく、どちらも
 * キャンバス全面に囲みオーバーレイを敷いていた。そのため**置いた文字を掴めない**
 * (オーバーレイがクリックを全部吸う) という詰みが起きていた。
 *
 * 素の状態 = "select" を既定に置き、囲みが要るモードのときだけオーバーレイを敷く。
 * これは画像編集ソフト共通の「矢印ツールが原点」に合わせた形でもある。
 *
 * 2026-07-28 追記: 「調整」「切り抜き」を追加した。どちらも **AI を一切通さない
 * 数学的処理だけ**で組んであり、Intel Mac / Apple Silicon / Windows で同じ結果になる
 * (待ち時間ゼロ・課金ゼロ)。中途半端に AI を混ぜると OS 差・待ち・課金が生えるため、
 * 決定論で出せる品質だけを入れる、という方針で選んでいる。
 *
 * 2026-07-28 追記2: 「素材を重ねる」("place") を追加した。これも AI を通さない。
 * 「背景を透過」はチップだが道具モードを持たない (押した瞬間に走り切るので、
 * 選び続ける状態が存在しない)。OS ごとに中の経路は違う (mac=Vision /
 * Windows=BiRefNet) が、ユーザーから見た操作は同じ1クリック。
 */
type EditTool = "select" | "ai" | "text" | "adjust" | "crop" | "place";

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
  const canUndo = useEditor((state) => state.canUndo);
  const canRedo = useEditor((state) => state.canRedo);
  const pendingOpenPath = useEditor((state) => state.pendingOpenPath);
  // 選択が変わるたびに右パネルを引き直すための購読。
  // selectedLayerId は EditorCanvas の selection:* イベントで更新される。
  const selectedLayerId = useEditor((state) => state.selectedLayerId);
  const canvas = useEditor((state) => state.canvas);
  const {
    chooseImage,
    performUndo,
    performRedo,
    exportImageAs,
    applyAdjust,
    cropToRegion,
    rotateOrFlip,
    addOverlayImage,
    removeBackgroundOnCanvas,
    saveAsArtwork,
    applyRedlineFix,
    applyTextOverlay,
    updateSelectedTextLayer,
    openImageForEditing,
  } = useEditorActions();

  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 「作品にする」の実行中フラグ (二重押しでギャラリーに2枚入るのを防ぐ)。 */
  const [savingArtwork, setSavingArtwork] = useState(false);
  /** 直す範囲 (0..1 の正規化 bbox)。null = 画像全体。 */
  const [region, setRegion] = useState<NormalizedBbox | null>(null);
  /**
   * いま選んでいる道具。既定は "select" (選択・移動) で、囲みオーバーレイを敷かない
   * 素の状態。"ai" と "text" のときだけキャンバスがドラッグで囲むモードになる。
   */
  const [tool, setTool] = useState<EditTool>("select");
  /** 下地の色を画像から拾う待機状態 (スポイト)。 */
  const [eyedropper, setEyedropper] = useState(false);
  const [textValues, setTextValues] = useState<TextOverlayValues>(DEFAULT_TEXT_VALUES);
  /**
   * 再編集の対象になっている文字レイヤーの id。
   * 「置いた直後」と「選択・移動で文字をクリックしたとき」の両方でここに入る。
   * null なら右パネルは「新しく置く」フォームのまま。
   */
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  /**
   * 「調整」の現在値 (明るさ・コントラスト・彩度・色合い・粒子)。
   * キャンバス側にも `adjust` として保存してあり、undo/redo と画像切替のあとは
   * そちらから読み戻す (見た目とつまみの位置がズレないようにする)。
   */
  const [adjust, setAdjust] = useState<AdjustValues>(NEUTRAL_ADJUST);
  /** 書き出しダイアログの開閉。 */
  const [exportOpen, setExportOpen] = useState(false);
  /** 「素材を重ねる」→「ライブラリから選ぶ」のモーダル開閉。 */
  const [libraryOpen, setLibraryOpen] = useState(false);
  /**
   * 「背景を透過」の実行中フラグ。
   * チップ自身にスピナーを出すために、道具モード (tool) とは別に持つ
   * (透過は道具ではなく1回きりの実行なので、押した状態が残らない)。
   */
  const [removingBg, setRemovingBg] = useState(false);

  const textMode = tool === "text";
  /** 囲みが要る道具かどうか (囲みオーバーレイを敷く判定を1箇所にまとめる)。 */
  const needsRegion = tool === "ai" || tool === "text" || tool === "crop";

  // 画像を差し替えたら選択は無効になる (前の画像の座標を持ち越さない)。
  // 道具も既定 (選択・移動) に戻す (前の画像に対する作業の続きに見えるのを防ぐ)。
  useEffect(() => {
    setRegion(null);
    setTool("select");
    setEyedropper(false);
    setEditingTextId(null);
    // 調整も画像ごとにやり直し。前の画像の補正値がつまみに残っていると
    // 「触っていないのに数値が入っている」状態になる。
    setAdjust(NEUTRAL_ADJUST);
  }, [sourceImagePath]);

  /**
   * 道具を切り替える。囲みの残骸・スポイト待ち・再編集対象を必ず一緒に落とす。
   *
   * ここを1本にまとめる理由: モード状態が複数あると、どれか1つ消し忘れた組み合わせ
   * (例: 囲み枠だけ残る) が必ず出る。切り替え口を1つにして、消す物を1箇所で数える。
   */
  const selectTool = (next: EditTool) => {
    setTool(next);
    setRegion(null);
    setEyedropper(false);
    setError(null);
    setEditingTextId(null);
    // 別の道具へ移るときは、キャンバス側の選択も外す。
    // 選択枠が残ったまま囲みモードに入ると「何が対象なのか」が二重になる。
    if (next !== "select") {
      const active = useEditor.getState().canvas as
        | { discardActiveObject?: () => void; requestRenderAll?: () => void }
        | null;
      active?.discardActiveObject?.();
      active?.requestRenderAll?.();
      useEditor.getState().setSelectedLayerId(null);
    }
  };

  /**
   * キャンバスで選ばれているオブジェクトが「置いた文字」なら、その値を右パネルへ引く。
   *
   * selectedLayerId は EditorCanvas の selection:created/updated/cleared で更新される
   * ので、クリックで選び直すたびにここが走る。文字以外 (下地の矩形・画像レイヤー) を
   * 選んだときは再編集フォームを出さない (直せる属性が無いのにフォームを出すと、
   * 打っても効かないように見える)。
   */
  useEffect(() => {
    if (!selectedLayerId) {
      setEditingTextId(null);
      return;
    }
    const active = (canvas as { getActiveObject?: () => unknown } | null)?.getActiveObject?.();
    const values = readOverlayTextValues(active);
    if (!values) {
      setEditingTextId(null);
      return;
    }
    setEditingTextId(selectedLayerId);
    // 選んだ文字の現在値をフォームへ流し込む。fillColor (下地) はこの文字の属性では
    // ないので触らず、直前の値をそのまま残す。
    setTextValues((current) => ({ ...current, ...values }));
  }, [selectedLayerId, canvas]);

  /**
   * 囲んだ範囲を塗りつぶして、その上に文字を置く (AI 不使用)。
   *
   * 置いたら**囲みモードを抜けて「選択・移動」に戻る**。理由は STΛCK 実機指摘:
   * 囲みオーバーレイはキャンバス全面を覆ってクリックを吸うため、敷いたままだと
   * 置いた文字を掴めない。置いた直後こそ位置を微調整したい瞬間なので、
   * そのまま掴める状態に落とす (applyTextOverlay 側が置いた文字を選択済みにして返す)。
   */
  const placeText = async () => {
    if (!region) return;
    setError(null);
    const placedId = await applyTextOverlay(region, {
      text: textValues.text,
      orientation: textValues.orientation,
      fontSize: textValues.fontSize,
      color: textValues.color,
      fontFamily: textValues.fontFamily,
      fillColor: textValues.fillColor,
    });
    if (placedId) {
      setRegion(null);
      setEyedropper(false);
      // 囲みオーバーレイを外す。これをしないと置いた文字をクリックできない。
      setTool("select");
      setEditingTextId(placedId);
    } else {
      setError("文字を置けませんでした。キャンバス下のメッセージを確認してください。");
    }
  };

  /** 再編集フォームの値を、選択中の文字レイヤーへ反映する。 */
  const editSelectedText = (patch: Partial<TextOverlayValues>, commit = false) => {
    setTextValues((current) => ({ ...current, ...patch }));
    if (!editingTextId) return;
    updateSelectedTextLayer(
      {
        text: patch.text,
        orientation: patch.orientation,
        fontSize: patch.fontSize,
        color: patch.color,
        fontFamily: patch.fontFamily,
      },
      commit,
    );
  };

  /** キャンバスの選択を外して「新しく置く」フォームへ戻す。 */
  const deselectText = () => {
    const active = useEditor.getState().canvas as
      | { discardActiveObject?: () => void; requestRenderAll?: () => void }
      | null;
    active?.discardActiveObject?.();
    active?.requestRenderAll?.();
    useEditor.getState().setSelectedLayerId(null);
    setEditingTextId(null);
  };

  /**
   * 調整のつまみを動かしている最中 (プレビューだけ更新・履歴は積まない)。
   * 離した時点で commitAdjust が履歴を1手だけ積む。
   */
  const changeAdjust = (patch: Partial<AdjustValues>) => {
    const next = { ...adjust, ...patch };
    setAdjust(next);
    void applyAdjust(next, false);
  };

  /** つまみを離した = 1操作の確定。ここで履歴を積む。 */
  const commitAdjust = () => {
    void applyAdjust(adjust, true);
  };

  /** プリセットを押した = 値の差し替え + 即確定 (1操作 = 1手)。 */
  const applyPreset = (values: AdjustValues) => {
    setAdjust(values);
    void applyAdjust(values, true);
  };

  /** 「リセット」= 調整を全部外す。これも1手として履歴に積む。 */
  const resetAdjust = () => {
    setAdjust(NEUTRAL_ADJUST);
    void applyAdjust(NEUTRAL_ADJUST, true);
  };

  /**
   * 囲んだ範囲で切り抜く。
   *
   * 切り抜きは「焼いて切る」ので、キャンバスは1枚に統合される。つまみの値は
   * 焼き込み済みなので、切ったあとの調整は無調整からのやり直しになる
   * (焼いた画素に対してさらに補正をかける形)。表示値もそれに合わせて戻す。
   * 終わったら囲みを外して「選択・移動」へ戻す (置いたら掴める、と同じ動線)。
   */
  const runCrop = async () => {
    if (!region) return;
    setError(null);
    const done = await cropToRegion(region);
    if (!done) {
      setError("切り抜けませんでした。キャンバス下のメッセージを確認してください。");
      return;
    }
    setRegion(null);
    setAdjust(NEUTRAL_ADJUST);
    setTool("select");
  };

  /** 90°回転・反転。即時に効き、『戻す』1手で戻る。 */
  const runTransform = async (kind: TransformKind) => {
    setError(null);
    const done = await rotateOrFlip(kind);
    if (!done) {
      setError("向きを変えられませんでした。キャンバス下のメッセージを確認してください。");
      return;
    }
    // 回転も焼き込みなので、調整値は焼かれた側に移る。つまみは無調整へ戻す。
    setAdjust(NEUTRAL_ADJUST);
  };

  /**
   * 素材を1枚重ねる (PC / ライブラリ 共通の着地点)。
   *
   * 置いたら**「選択・移動」へ戻す**。置いた直後こそ位置と大きさを触りたい瞬間で、
   * ここで道具モードに留まると「置いたのに掴めない」になる (文字を置いたときと
   * 同じ動線。addOverlayImage 側が置いた素材を選択済みにして返す)。
   */
  const placeImage = async (path: string) => {
    setError(null);
    const placedId = await addOverlayImage(path);
    if (placedId) {
      setTool("select");
    } else {
      setError("素材を置けませんでした。キャンバス下のメッセージを確認してください。");
    }
  };

  /** 「PCから選ぶ」: OS のファイル選択から1枚取り込む。 */
  const pickImageFromDisk = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [
        { name: "画像", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"] },
      ],
    });
    if (typeof selected !== "string") return;
    await placeImage(selected);
  };

  /**
   * 「背景を透過」: 1クリックで被写体を切り抜く。
   *
   * OS ごとの経路差 (mac=Vision / Windows=BiRefNet) は useEditor 側に閉じてあるので、
   * ここは「押す → 待つ → 結果を見る」だけを担う。失敗理由はキャンバス下の
   * エラーカードに出る (エラーログセンターにも流れる) ので、ここで二重に出さない。
   */
  const runRemoveBackground = async () => {
    if (removingBg) return;
    setRemovingBg(true);
    setError(null);
    try {
      const done = await removeBackgroundOnCanvas();
      if (done) {
        useToasts.getState().push({
          kind: "success",
          text: "背景を透過しました。『戻す』で元に戻せます。",
          ttlMs: 4000,
        });
        // 透過はベース画像そのものの入れ替え。焼き込み済みなので、
        // つまみは無調整からのやり直しになる (切り抜き・回転と同じ扱い)。
        setAdjust(NEUTRAL_ADJUST);
        setTool("select");
      } else {
        setError("背景を透過できませんでした。キャンバス下のメッセージを確認してください。");
      }
    } catch (err) {
      setError(`背景を透過できませんでした: ${String(err)}`);
    } finally {
      setRemovingBg(false);
    }
  };

  /** 書き出しダイアログからの実行。成功・キャンセルどちらでもダイアログは閉じる。 */
  const runExport = async (format: ExportFormat, size: ExportSize) => {
    setError(null);
    setExportOpen(false);
    await exportImageAs(format, size);
  };

  /*
   * ギャラリー右クリック / プレビューモーダルの「編集スタジオで開く」を受ける。
   *
   * あちら側は「予約 (setPendingOpenPath) + タブ切替」しかしない。編集タブは
   * 非アクティブ時にアンマウントされているので、開く処理はマウントされた
   * こちら側が担う。openImageForEditing は内部で waitForEditorCanvas (最大4秒)
   * を通るため、EditorCanvas の初期化前に来ても取りこぼさない。
   *
   * 予約は「消費する前に」消す。開く処理が失敗しても予約が残り続けると、
   * 以降マウントのたびに同じ画像を開き直してしまう。
   */
  useEffect(() => {
    if (!pendingOpenPath) return;
    const path = pendingOpenPath;
    useEditor.getState().setPendingOpenPath(null);
    void (async () => {
      // 作業中のキャンバスを黙って捨てない。既存レイヤーがあるときだけ確認する。
      const objects = (
        useEditor.getState().canvas as { getObjects?: () => unknown[] } | null
      )?.getObjects?.().length;
      if (objects) {
        const message = "既存レイヤーをクリアして、この画像を開きますか?";
        let ok = false;
        try {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          ok = await ask(message, { title: "レイヤーのクリア", kind: "warning" });
        } catch {
          ok = window.confirm(message);
        }
        if (!ok) return;
      }
      await openImageForEditing(path);
    })();
  }, [pendingOpenPath, openImageForEditing]);

  const canRun = Boolean(sourceImagePath && instruction.trim()) && !busy && busyTool === null;

  /**
   * 戻す / やり直したあとに、調整のつまみをキャンバスの実値へ引き直す。
   *
   * filters 自体は履歴に載っているので**見た目は勝手に戻る**が、右パネルの
   * つまみは React の state なので置いていかれる。見た目と数値がズレたままだと
   * 「表示は元に戻ったのに、つまみを触ると一気に元の補正へ飛ぶ」事故になる。
   */
  const syncAdjustFromCanvas = () => {
    setAdjust(readAdjustFromCanvas(useEditor.getState().canvas));
  };

  const undoWithSync = async () => {
    await performUndo();
    syncAdjustFromCanvas();
  };

  const redoWithSync = async () => {
    await performRedo();
    syncAdjustFromCanvas();
  };

  // Cmd/Ctrl+Z = 元に戻す / Cmd/Ctrl+Shift+Z = やり直す。
  // 編集タブ表示中だけ有効 (このコンポーネントがマウントされている間だけ listener を張る)。
  // input / textarea / contentEditable にフォーカスがあるときは発火しない
  // (テキスト入力の標準 Undo を奪わないため)。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean(target?.isContentEditable);

      // Esc = いつでも「選択・移動」へ戻る非常口。
      // 囲みかけ・スポイト待ち・文字入力中のどこで詰まっても、ここから抜けられる。
      // 入力欄にいるときはフォーカスを外すだけにして、打っている途中の値を消さない。
      if (event.key === "Escape") {
        if (typing) {
          target?.blur();
          return;
        }
        event.preventDefault();
        selectTool("select");
        return;
      }

      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      if (typing) return;
      event.preventDefault();
      // ショートカット経由でも、戻したあとに調整のつまみを実値へ引き直す
      // (ヘッダーのボタン経由と挙動を揃える)。setAdjust は setter なので
      // 依存配列に足す必要がなく、listener を張り替えずに済む。
      const run = event.shiftKey ? performRedo : performUndo;
      void Promise.resolve(run()).then(() => {
        setAdjust(readAdjustFromCanvas(useEditor.getState().canvas));
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // selectTool は毎レンダー作り直されるが、中で読むのは state setter と
    // useEditor.getState() だけ (古い値を掴まない) ので依存に入れない。
    // 入れると keydown listener が毎レンダー張り替わる。
  }, [performUndo, performRedo]);

  /**
   * 編集結果を「作品」にする (ギャラリーへ合流)。保存先は聞かない。
   * 書き出し (OS の保存ダイアログ) とは役割が違う: こちらはアプリの中の
   * 資産管理 (ギャラリー・履歴・プロジェクト保存) に載せるための1クリック。
   */
  const saveArtwork = async () => {
    if (savingArtwork) return;
    setSavingArtwork(true);
    setError(null);
    try {
      const saved = await saveAsArtwork();
      if (saved) {
        useToasts.getState().push({
          kind: "success",
          text: "作品にしました。制作タブのギャラリーに入っています。",
          ttlMs: 4000,
        });
      } else {
        // saveAsArtwork は失敗理由を editor store の error に入れる
        // (キャンバス下のエラーカードに出る)。ここで二重に出さない。
        setError("作品にできませんでした。キャンバス下のメッセージを確認してください。");
      }
    } catch (err) {
      setError(`作品にできませんでした: ${String(err)}`);
    } finally {
      setSavingArtwork(false);
    }
  };

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
          text: "囲んだところだけ直しました。外側は変えていません。『戻す』で戻せます。",
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
    <div
      data-tour="editing-workspace"
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#1e1e1e]"
    >
      {/* 上部バー: 画像名と、画像の入れ替え・書き出しだけ。 */}
      <header
        data-tour="editing-toolbar"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-[#2a2a2a] bg-[#252525] px-3"
      >
        <span
          className="min-w-0 flex-1 truncate text-xs font-bold text-neutral-300"
          title={sourceImagePath ?? undefined}
        >
          {sourceImagePath ? basename(sourceImagePath) : "画像未選択"}
        </span>
        {sourceImagePath ? (
          <>
            {/*
              ⌘Z を知らない人・Windows の人でも戻せるようにする。
              キーボードショートカット (下の useEffect) はそのまま併存する。
            */}
            <button
              type="button"
              onClick={() => void undoWithSync()}
              disabled={!canUndo || busyTool !== null || busy}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              戻す
            </button>
            <button
              type="button"
              onClick={() => void redoWithSync()}
              disabled={!canRedo || busyTool !== null || busy}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              やり直す
            </button>
            <button
              type="button"
              onClick={() => void saveArtwork()}
              disabled={busyTool !== null || busy || savingArtwork}
              className="rounded-md border border-pink-400/50 bg-pink-500/15 px-3 py-1.5 text-[11px] font-black text-pink-100 hover:border-pink-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              作品にする
            </button>
            <button
              type="button"
              onClick={() => setExportOpen(true)}
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

      {/*
        タスクチップ列。「なにをしたい?」を先に選ばせる。道具名 (インペイント等) は出さない。
      */}
      {sourceImagePath ? (
        <div
          data-tour="editing-tools"
          className="flex h-9 shrink-0 items-center gap-2 border-b border-[#2a2a2a] bg-[#1e1e1e] px-3"
        >
          <span className="shrink-0 text-[10px] font-black text-neutral-500">なにをしたい?</span>
          {/*
            先頭は素の状態 (選択・移動)。囲みオーバーレイを敷かないので、置いた文字を
            クリックして掴める。ここが原点で、他は「囲んでから何かする」道具。
          */}
          {([
            { id: "select", label: "選択・移動" },
            { id: "ai", label: "ことばで直す" },
            { id: "text", label: "セリフ・文字を直す" },
            { id: "place", label: "素材を重ねる" },
            { id: "adjust", label: "調整" },
            { id: "crop", label: "切り抜き" },
          ] as const).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectTool(item.id)}
              className={[
                "shrink-0 rounded-full border px-3 py-1 text-[11px] font-bold",
                tool === item.id
                  ? "border-pink-400 bg-pink-500/20 text-pink-100"
                  : "border-[#3a3a3a] bg-[#1a1a1a] text-neutral-300 hover:border-pink-400 hover:text-white",
              ].join(" ")}
            >
              {item.label}
            </button>
          ))}
          {/*
            「背景を透過」だけは道具モードを持たない。押した瞬間に走り切って終わるので、
            選び続ける状態 (押されたまま) が存在しない。だから上のモード群とは別に置き、
            実行中はチップ自身にスピナーを出す。
          */}
          <button
            type="button"
            onClick={() => void runRemoveBackground()}
            disabled={removingBg || busy || busyTool !== null}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1 text-[11px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {removingBg ? <ChipSpinner /> : null}
            {removingBg ? "背景を透過しています…" : "背景を透過"}
          </button>
          <span className="ml-auto shrink-0 text-[10px] font-bold text-neutral-600">
            Esc で「選択・移動」に戻ります
          </span>
        </div>
      ) : null}

      {/* 本体: キャンバス (主役) + 右に指示欄だけ。左レールは廃止。 */}
      <div
        data-tour="editing-canvas"
        className="flex min-h-0 flex-1 overflow-hidden"
      >
        {sourceImagePath ? (
          <>
            {/*
              囲みオーバーレイは「囲んでから何かする」道具のときだけ渡す。
              選択・移動のときに渡すと、オーバーレイがキャンバス全面のクリックを
              吸ってしまい、置いた文字を掴めなくなる (STΛCK 実機指摘の詰み)。
            */}
            <EditorCanvas
              regionSelect={
                needsRegion
                  ? {
                      value: region,
                      onChange: setRegion,
                      disabled: busy || busyTool !== null || eyedropper,
                      hint: textMode
                        ? "直したいセリフをドラッグで囲む"
                        : tool === "crop"
                          ? "残したいところをドラッグで囲む"
                          : "直したいところをドラッグで囲む",
                    }
                  : undefined
              }
              eyedropper={{
                active: eyedropper,
                onPick: (hex) => {
                  setTextValues((current) => ({ ...current, fillColor: hex }));
                  setEyedropper(false);
                },
              }}
            />
            <aside
              data-tour="editing-options"
              className="flex min-h-0 w-[320px] shrink-0 flex-col border-l border-[#2a2a2a] bg-[#252525]"
            >
              {/*
                右パネルの出し分け:
                  - 「素材を重ねる」    → 画像の選び先2つ (AI 不使用)
                  - 文字を選んでいる → その文字の再編集フォーム (道具は問わない)
                  - 「セリフ・文字を直す」 → 新しく置くフォーム
                  - 「調整」            → 明るさ・色のパネル (AI 不使用)
                  - 「切り抜き」        → 囲んで切るパネル (AI 不使用)
                  - 「選択・移動」      → 何ができるかの案内
                  - 「ことばで直す」    → AI 指示欄

                「素材を重ねる」を先頭に置く理由: 素材を置いた直後は選択が発生するので、
                editingTextId の分岐より先に評価しないと、直前に文字を触っていた場合に
                文字フォームへ吸われる。
              */}
              {tool === "place" ? (
                <PlaceImagePanel
                  onPickFromDisk={() => void pickImageFromDisk()}
                  onPickFromLibrary={() => setLibraryOpen(true)}
                  busy={busy || busyTool !== null}
                />
              ) : tool === "adjust" ? (
                <AdjustPanel
                  values={adjust}
                  onChange={changeAdjust}
                  onCommit={commitAdjust}
                  onPreset={applyPreset}
                  onReset={resetAdjust}
                  onTransform={(kind) => void runTransform(kind)}
                  busy={busy || busyTool !== null}
                />
              ) : tool === "crop" ? (
                <CropPanel
                  region={region}
                  onApply={() => void runCrop()}
                  onClear={() => setRegion(null)}
                  busy={busy || busyTool !== null}
                />
              ) : editingTextId ? (
                <TextOverlayPanel
                  region={region}
                  values={textValues}
                  onChange={(patch) => editSelectedText(patch)}
                  onApply={() => void placeText()}
                  // 再編集中の「やめる」= この文字の編集をやめる (選択を外す)。
                  // 道具の切り替えではない (もともと選択・移動にいることが多い)。
                  onExit={deselectText}
                  eyedropperActive={eyedropper}
                  onToggleEyedropper={() => setEyedropper((on) => !on)}
                  busy={busy || busyTool !== null}
                  editingExisting
                  onCommit={() => updateSelectedTextLayer({}, true)}
                />
              ) : textMode ? (
                <TextOverlayPanel
                  region={region}
                  values={textValues}
                  onChange={(patch) => setTextValues((current) => ({ ...current, ...patch }))}
                  onApply={() => void placeText()}
                  onExit={() => selectTool("select")}
                  eyedropperActive={eyedropper}
                  onToggleEyedropper={() => setEyedropper((on) => !on)}
                  busy={busy || busyTool !== null}
                />
              ) : tool === "select" ? (
                <SelectToolPanel />
              ) : (
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
              )}
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

      {/*
        書き出しダイアログ。編集タブの中に閉じたオーバーレイにする (別ウィンドウにしない)。
        親に relative があるので inset-0 がこのタブの領域にちょうど収まる。
      */}
      {exportOpen && sourceImagePath ? (
        <ExportDialog
          onExport={(format, size) => void runExport(format, size)}
          onClose={() => setExportOpen(false)}
          busy={busy || busyTool !== null}
        />
      ) : null}

      {/*
        「素材を重ねる」→「ライブラリから選ぶ」。漫画のキャラ画像追加と同じ部品を
        そのまま使う (onPick を渡すと Composer へは足さず、こちらへ path だけ返る)。
        選ぶ画面を作り直さないので、探し方・見え方がアプリ内で1つに揃う。
      */}
      <ReferenceLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onPick={(path) => void placeImage(path)}
      />
    </div>
  );
}

/** チップ内に出す小さなスピナー (背景を透過の実行中)。 */
function ChipSpinner() {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      className="animate-spin"
      aria-hidden
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

/**
 * 「選択・移動」を選んでいて、まだ何も選んでいないときの右パネル。
 *
 * ここは道具ではなく素の状態なので、設定するものが無い。代わりに
 * 「この状態で何ができるか」だけを短く置く。空パネルにすると
 * 「壊れている / 読み込み中」に見える。
 */
function SelectToolPanel() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <h3 className="text-xs font-black text-white">選択・移動</h3>
      <p className="mt-1 text-[10px] font-bold leading-4 text-neutral-500">
        置いたものをクリックすると選べます。
      </p>
      <ul className="mt-3 space-y-1.5 rounded-lg border border-[#333] bg-[#1c1c1c] p-2.5 text-[10px] font-bold leading-4 text-neutral-400">
        <li>・ドラッグで動かす</li>
        <li>・四隅をつまんで大きさを変える</li>
        <li>・上のつまみで回す</li>
        <li>・置いた文字を選ぶと、ここで内容や色を直せます</li>
      </ul>
      <p className="mt-3 text-[10px] font-bold leading-4 text-neutral-500">
        画像そのものを直すときは、上の「ことばで直す」か「セリフ・文字を直す」を選んでください。
      </p>
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
