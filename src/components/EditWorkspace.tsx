import { useEffect, useRef, useState } from "react";

import { images as imagesIpc } from "../lib/ipc";
import { useBatches } from "../lib/store/batches";
import { beginDirectRun } from "../lib/store/generationStatus";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { createEditSession } from "../lib/store/editSession";
import { ReferenceLibraryModal } from "./ReferenceLibraryModal";
import { AdjustPanel } from "./edit/AdjustPanel";
import { CropPanel } from "./edit/CropPanel";
import { EditCandidateStrip } from "./edit/EditCandidateStrip";
import { EditChatBar } from "./edit/EditChatBar";
import { EditFloatingPanel } from "./edit/EditFloatingPanel";
import { EditHistoryRail } from "./edit/EditHistoryRail";
import { EditModeSelector } from "./edit/EditModeSelector";
import { EditToolRail, type EditToolId } from "./edit/EditToolRail";
import { EditorCanvas } from "./edit/EditorCanvas";
import { EditorLayerList } from "./edit/EditorLayerList";
import { EditorPropertyPanel } from "./edit/EditorPropertyPanel";
import { ExportDialog } from "./edit/ExportDialog";
import { PlaceImagePanel } from "./edit/PlaceImagePanel";
import type { NormalizedBbox } from "./edit/RegionSelectOverlay";
import { ShapeToolPanel } from "./edit/ShapeToolPanel";
import { TextOverlayPanel, type TextOverlayValues } from "./edit/TextOverlayPanel";
import { WordsToolPanel } from "./edit/WordsToolPanel";
import {
  NEUTRAL_ADJUST,
  readAdjustFromCanvas,
  type AdjustValues,
} from "./edit/editor/adjustFilters";
import type { TransformKind } from "./edit/editor/canvasTransforms";
import { useEditor } from "./edit/editor/editorStore";
import type { ExportFormat, ExportSize } from "./edit/editor/exportImage";
import {
  exportCanvasPngBase64,
  readOverlayTextValues,
} from "./edit/editor/magicLayerToFabric";
import {
  applyEditedVersion,
  applyRegionEditedVersion,
  EDITOR_RECOVERY_ERROR,
  runVersionOperation,
  setEditorRecoveryFailureHandler,
  useEditorActions,
} from "./edit/editor/useEditor";

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

/** Magnific 型ツール帯の選択状態。select は配置物を直接掴むための退避状態。 */
type EditTool = EditToolId | "select";

/**
 * 編集タブ本体。処理は既存 actions を再利用し、入口と配置だけを Magnific 型へまとめる。
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
  const editMode = useEditor((state) => state.editMode);
  const setEditMode = useEditor((state) => state.setEditMode);
  const {
    run: runEditorTool,
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
  /** 版画像の読み込み中。候補・履歴の連打とAI送信を同時に止める。 */
  const [versionInFlight, setVersionInFlight] = useState(false);
  const versionInFlightRef = useRef(false);
  /** 自動復元と版ファイル再読込の両方が失敗した状態。版を開き直すまで編集を止める。 */
  const [versionRecoveryRequired, setVersionRecoveryRequired] = useState(false);
  /** 「作品にする」の実行中フラグ (二重押しでギャラリーに2枚入るのを防ぐ)。 */
  const [savingArtwork, setSavingArtwork] = useState(false);
  /** 直す範囲 (0..1 の正規化 bbox)。null = 画像全体。 */
  const [region, setRegion] = useState<NormalizedBbox | null>(null);
  /** 既定は「ことばで直す」。select では囲みオーバーレイを敷かない。 */
  const [tool, setTool] = useState<EditTool>("ai");
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
  /** 元画像と、この画面で生まれた AI 編集版だけを持つ一時セッション。 */
  const [editSession, setEditSession] = useState(() => createEditSession(sourceImagePath));
  const editSessionRef = useRef(editSession);

  const textMode = tool === "text";
  /** 囲みが要る道具かどうか (囲みオーバーレイを敷く判定を1箇所にまとめる)。 */
  const needsRegion = tool === "region" || tool === "text" || tool === "crop";

  /** 外から別画像が開かれたときだけ、版履歴を新しい元画像へ切り替える。 */
  useEffect(() => {
    setEditSession((current) => {
      if (!sourceImagePath) {
        const next = createEditSession(null);
        editSessionRef.current = next;
        return next;
      }
      const belongsToCurrentSession =
        current.basePath === sourceImagePath ||
        current.versions.some((version) => version.path === sourceImagePath);
      const next = belongsToCurrentSession ? current : createEditSession(sourceImagePath);
      editSessionRef.current = next;
      return next;
    });
  }, [sourceImagePath]);

  // 画像を差し替えたら選択は無効になる (前の画像の座標を持ち越さない)。
  // 道具も既定の「ことばで直す」に戻す (前の画像の作業を持ち越さない)。
  useEffect(() => {
    setRegion(null);
    setTool("ai");
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
   * 囲み編集は透過パッチをキャンバスへ重ねる既存仕様で、結果 path を返さない。
   * 実行系は変えず、成功後の見えている1枚だけを既存 writeUpload で版として保存する。
   */
  const captureCanvasVersion = async (): Promise<string | null> => {
    const liveCanvas = useEditor.getState().canvas;
    const base64 = exportCanvasPngBase64(liveCanvas as Parameters<typeof exportCanvasPngBase64>[0]);
    if (!base64) return null;
    return imagesIpc.writeUpload(`edit-region-${Date.now()}.png`, base64ToBytes(base64));
  };

  /**
   * AI編集の追加と版切替を、読み込み成功後だけ確定する共通入口。
   * openImageForEditing がキャンバスを新版で開き、同時に Undo 履歴も新版基準へ戻す。
   */
  const handleVersionRecoveryFailure = (_caught: unknown) => {
    setVersionRecoveryRequired(true);
    setError(EDITOR_RECOVERY_ERROR);
    useToasts.getState().push({
      kind: "error",
      text: EDITOR_RECOVERY_ERROR,
      ttlMs: 7000,
    });
  };

  useEffect(() => {
    setEditorRecoveryFailureHandler(handleVersionRecoveryFailure);
    return () => setEditorRecoveryFailureHandler(null);
  }, [handleVersionRecoveryFailure]);

  const applyVersionWithoutLock = async (
    path: string,
    mode: "add" | "switch",
    label?: string,
    options: { showFailureToast?: boolean; forceReload?: boolean } = {},
  ): Promise<boolean> => {
    let recoveryFailed = false;
    const applied = await applyEditedVersion({
      session: editSessionRef.current,
      path,
      mode,
      label,
      openImageForEditing,
      forceReload: options.forceReload,
      onRecoveryFailure: (caught) => {
        recoveryFailed = true;
        handleVersionRecoveryFailure(caught);
      },
      commit: (nextSourcePath, nextSession) => {
        useEditor.getState().setSourceImagePath(nextSourcePath);
        editSessionRef.current = nextSession;
        setEditSession(nextSession);
      },
    });
    if (!applied && !recoveryFailed && options.showFailureToast !== false) {
      useToasts.getState().push({
        kind: "error",
        text: "画像を読み込めませんでした。前の版を表示したままにしています。",
        ttlMs: 4800,
      });
    }
    return applied;
  };

  const applyVersion = async (
    path: string,
    mode: "add" | "switch",
    label?: string,
    options: { showFailureToast?: boolean; forceReload?: boolean } = {},
  ): Promise<boolean> => {
    const applied = await runVersionOperation(
      versionInFlightRef,
      setVersionInFlight,
      () => applyVersionWithoutLock(path, mode, label, options),
    );
    // null は連打による後発操作。何も変えず、失敗通知も出さない。
    return applied ?? false;
  };

  /** 候補ストリップと履歴レールに共通の版切替。 */
  const selectSessionVersion = async (path: string) => {
    if (versionInFlightRef.current) return;
    const applied = await applyVersion(path, "switch", undefined, {
      forceReload: versionRecoveryRequired,
    });
    if (applied && versionRecoveryRequired) {
      setVersionRecoveryRequired(false);
      setError(null);
      useEditor.getState().setError(null);
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
    if (removingBg || versionInFlightRef.current || versionRecoveryRequired) return;
    setRemovingBg(true);
    setError(null);
    try {
      const resultPath = await removeBackgroundOnCanvas();
      if (!resultPath) {
        setError("背景を透過できませんでした。キャンバス下のメッセージを確認してください。");
      } else if (await applyVersion(resultPath, "add", "背景透過")) {
        useToasts.getState().push({
          kind: "success",
          text: "背景を透過しました。右の履歴から前の版に戻せます。",
          ttlMs: 4000,
        });
        // 透過はベース画像そのものの入れ替え。焼き込み済みなので、
        // つまみは無調整からのやり直しになる (切り抜き・回転と同じ扱い)。
        setAdjust(NEUTRAL_ADJUST);
        setTool("select");
      } else {
        setError("背景透過の結果を読み込めませんでした。前の版を表示しています。");
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

  const canRun =
    Boolean(sourceImagePath && instruction.trim()) &&
    !busy &&
    busyTool === null &&
    !versionInFlight &&
    !versionRecoveryRequired;

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
      if (versionRecoveryRequired) return;
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
  }, [performUndo, performRedo, versionRecoveryRequired]);

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
    if (
      !sourceImagePath ||
      !prompt ||
      !region ||
      busy ||
      versionInFlightRef.current ||
      versionRecoveryRequired
    ) return;
    setBusy(true);
    setError(null);
    try {
      const liveCanvas = useEditor.getState().canvas;
      const sessionBeforeEdit = editSessionRef.current;
      if (!liveCanvas) {
        setError("編集キャンバスを準備できませんでした。もう一度お試しください。");
        return;
      }
      const result = await runVersionOperation(
        versionInFlightRef,
        setVersionInFlight,
        () =>
          applyRegionEditedVersion({
            canvas: liveCanvas,
            applyPatch: () => applyRedlineFix(sourceImagePath, region, prompt),
            saveVersion: captureCanvasVersion,
            applyVersion: (path) =>
              applyVersionWithoutLock(path, "add", "囲んで直す", {
                showFailureToast: false,
              }),
            rollbackSession: () => {
              editSessionRef.current = sessionBeforeEdit;
              setEditSession(sessionBeforeEdit);
            },
            recoveryPath: sessionBeforeEdit.currentPath ?? sourceImagePath,
            reloadVersion: (path) =>
              openImageForEditing(path, {
                recoveryPath: null,
                onRecoveryFailure: () => {},
              }),
            onRecoveryFailure: handleVersionRecoveryFailure,
          }),
      );
      if (result === null) return;
      if (result === "applied") {
        useToasts.getState().push({
          kind: "success",
          text: "囲んだところだけ直しました。外側は変えていません。",
          ttlMs: 5200,
        });
        setInstruction("");
      } else if (result === "version-failed") {
        useToasts.getState().push({
          kind: "error",
          text: "編集結果を保存できなかったため、変更を取り消しました。もう一度お試しください。",
          ttlMs: 6000,
        });
      } else if (result === "patch-failed") {
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
    if (
      !sourceImagePath ||
      !prompt ||
      busy ||
      versionInFlightRef.current ||
      versionRecoveryRequired
    ) return;

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
        const resultPath = result.generatedPaths[0];
        if (resultPath && (await applyVersion(resultPath, "add", "ことばで直す"))) {
          // 生成だけでなく、キャンバスへの新版読み込みまで確定してから成功を知らせる。
          useToasts.getState().push({
            kind: "success",
            text: "直した画像ができました。制作タブに届いています。",
            ttlMs: 3600,
          });
          setInstruction("");
        } else if (!resultPath) {
          setError("直した画像の保存先を確認できませんでした。もう一度お試しください。");
        }
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

  const panelBusy = busy || busyTool !== null || versionInFlight || versionRecoveryRequired;
  const displayedError = versionRecoveryRequired ? EDITOR_RECOVERY_ERROR : error;

  return (
    <div
      data-tour="editing-workspace"
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#121212]"
    >
      {/* GORI 共通の編集ヘッダーは残し、編集タブ内のアクセントだけ indigo に揃える。 */}
      <header
        data-tour="editing-toolbar"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-[#2a2a2a] bg-[#1b1b1b] px-3"
      >
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
              onClick={() => void undoWithSync()}
              disabled={!canUndo || busyTool !== null || busy || versionInFlight || versionRecoveryRequired}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              戻す
            </button>
            <button
              type="button"
              onClick={() => void redoWithSync()}
              disabled={!canRedo || busyTool !== null || busy || versionInFlight || versionRecoveryRequired}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              やり直す
            </button>
            <button
              type="button"
              onClick={() => void saveArtwork()}
              disabled={busyTool !== null || busy || savingArtwork || versionInFlight || versionRecoveryRequired}
              className="rounded-md border border-indigo-400/50 bg-indigo-500/15 px-3 py-1.5 text-[11px] font-black text-indigo-100 hover:border-indigo-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              作品にする
            </button>
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              disabled={busyTool !== null || busy || versionInFlight || versionRecoveryRequired}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              書き出し
            </button>
            <button
              type="button"
              onClick={() => void chooseImage()}
              disabled={busyTool !== null || busy || versionInFlight || versionRecoveryRequired}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              別の画像にする
            </button>
          </>
        ) : null}
      </header>

      <div
        data-tour="editing-canvas"
        aria-disabled={versionRecoveryRequired}
        onKeyDownCapture={(event) => {
          if (!versionRecoveryRequired) return;
          const target = event.target as HTMLElement;
          if (target.closest("[data-edit-version-select]")) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        className={`relative flex min-h-0 flex-1 overflow-hidden bg-[#121212] [&>main]:!bg-[#121212] [&_.bg-pink-500]:!bg-indigo-500 [&_.border-pink-400\/50]:!border-indigo-400\/50 [&_.text-pink-300]:!text-indigo-300 ${
          versionRecoveryRequired ? "pointer-events-none" : ""
        }`}
      >
        <EditorCanvas
          panOnEmpty={tool === "ai" || tool === "select"}
          regionSelect={
            sourceImagePath && needsRegion
              ? {
                  value: region,
                  onChange: setRegion,
                  disabled:
                    busy ||
                    busyTool !== null ||
                    versionInFlight ||
                    versionRecoveryRequired ||
                    eyedropper,
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

        {sourceImagePath ? (
          <>
            {/*
              囲みオーバーレイは region / 文字 / 切り抜きだけに渡す。
              素の選択時に渡すと全面でクリックを吸い、置いた文字を掴めなくなる。
            */}
            {tool === "place" ? (
              <EditFloatingPanel title="画像を置く" onClose={() => selectTool("select")}>
                <PlaceImagePanel
                  onPickFromDisk={() => void pickImageFromDisk()}
                  onPickFromLibrary={() => setLibraryOpen(true)}
                  busy={panelBusy}
                />
              </EditFloatingPanel>
            ) : tool === "adjust" ? (
              <EditFloatingPanel title="調整" onClose={() => selectTool("select")}>
                <AdjustPanel
                  values={adjust}
                  onChange={changeAdjust}
                  onCommit={commitAdjust}
                  onPreset={applyPreset}
                  onReset={resetAdjust}
                  onTransform={(kind) => void runTransform(kind)}
                  busy={panelBusy}
                />
              </EditFloatingPanel>
            ) : tool === "crop" ? (
              <EditFloatingPanel title="切り抜き" onClose={() => selectTool("select")}>
                <CropPanel
                  region={region}
                  onApply={() => void runCrop()}
                  onClear={() => setRegion(null)}
                  busy={panelBusy}
                />
              </EditFloatingPanel>
            ) : tool === "shape" ? (
              <EditFloatingPanel title="図形" onClose={() => selectTool("select")}>
                <ShapeToolPanel />
              </EditFloatingPanel>
            ) : tool === "words" ? (
              <EditFloatingPanel title="ことばで分離" onClose={() => selectTool("select")}>
                <WordsToolPanel />
              </EditFloatingPanel>
            ) : tool === "layers" ? (
              <EditFloatingPanel title="レイヤー分解" onClose={() => selectTool("select")}>
                <div className="flex min-h-0 flex-col">
                  <div className="border-b border-[#2a2a2a] p-3">
                    <button
                      type="button"
                      onClick={() => void runEditorTool("magic")}
                      disabled={panelBusy}
                      className="w-full rounded-xl bg-indigo-500 px-4 py-3 text-sm font-black text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
                    >
                      {busyTool === "magic" ? "レイヤーに分解しています…" : "レイヤーに分解する"}
                    </button>
                    <p className="mt-2 text-center text-[11px] font-bold leading-4 text-neutral-400">
                      人物・小物・背景・文字に自動で切り分けます
                    </p>
                    <div className="mt-3 border-t border-[#2a2a2a] pt-3">
                      <EditModeSelector activeMode={editMode} onSelectMode={setEditMode} />
                    </div>
                  </div>
                  <EditorLayerList />
                  <EditorPropertyPanel />
                </div>
              </EditFloatingPanel>
            ) : editingTextId ? (
              <EditFloatingPanel title="文字" onClose={deselectText}>
                <TextOverlayPanel
                  region={region}
                  values={textValues}
                  onChange={(patch) => editSelectedText(patch)}
                  onApply={() => void placeText()}
                  onExit={deselectText}
                  eyedropperActive={eyedropper}
                  onToggleEyedropper={() => setEyedropper((on) => !on)}
                  busy={panelBusy}
                  editingExisting
                  onCommit={() => updateSelectedTextLayer({}, true)}
                />
              </EditFloatingPanel>
            ) : textMode ? (
              <EditFloatingPanel title="文字" onClose={() => selectTool("select")}>
                <TextOverlayPanel
                  region={region}
                  values={textValues}
                  onChange={(patch) => setTextValues((current) => ({ ...current, ...patch }))}
                  onApply={() => void placeText()}
                  onExit={() => selectTool("select")}
                  eyedropperActive={eyedropper}
                  onToggleEyedropper={() => setEyedropper((on) => !on)}
                  busy={panelBusy}
                />
              </EditFloatingPanel>
            ) : null}

            {editSession.basePath && editSession.currentPath ? (
              <>
                <EditCandidateStrip
                  basePath={editSession.basePath}
                  candidates={editSession.candidates}
                  currentPath={editSession.currentPath}
                  disabled={versionInFlight}
                  onSelect={(path) => void selectSessionVersion(path)}
                  onDownload={() => setExportOpen(true)}
                />
                <EditHistoryRail
                  basePath={editSession.basePath}
                  versions={editSession.versions}
                  currentPath={editSession.currentPath}
                  disabled={versionInFlight}
                  onSelect={(path) => void selectSessionVersion(path)}
                />
              </>
            ) : null}

            <div className="absolute bottom-6 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
              {displayedError ? (
                <p className="w-[min(560px,calc(100vw-2rem))] rounded-lg border border-red-500/40 bg-[#1b1111]/95 px-3 py-2 text-[11px] font-bold leading-4 text-red-200 shadow-xl">
                  {displayedError}
                </p>
              ) : null}
              <EditChatBar
                value={instruction}
                activeTool={tool}
                hasRegion={region !== null}
                busy={busy || versionInFlight}
                interactionDisabled={versionRecoveryRequired}
                disabled={
                  !canRun ||
                  (tool !== "ai" && tool !== "region") ||
                  (tool === "region" && region === null)
                }
                onChange={setInstruction}
                onSubmit={() => void run()}
                onSelectWhole={() => selectTool("ai")}
                onSelectRegion={() => {
                  if (!region) return;
                  setTool("region");
                  setEyedropper(false);
                  setError(null);
                }}
              />
              <EditToolRail
                activeTool={tool}
                disabled={busy || busyTool !== null || versionInFlight || versionRecoveryRequired}
                recognizingText={busyTool === "text-detect"}
                removingBackground={removingBg}
                onSelect={selectTool}
                onDetectText={() => void runEditorTool("text-detect")}
                onRemoveBackground={() => void runRemoveBackground()}
              />
            </div>
          </>
        ) : null}
      </div>

      {exportOpen && sourceImagePath ? (
        <ExportDialog
          onExport={(format, size) => void runExport(format, size)}
          onClose={() => setExportOpen(false)}
          busy={busy || busyTool !== null || versionInFlight || versionRecoveryRequired}
        />
      ) : null}

      <ReferenceLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onPick={(path) => void placeImage(path)}
      />
    </div>
  );

}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export default EditWorkspace;
