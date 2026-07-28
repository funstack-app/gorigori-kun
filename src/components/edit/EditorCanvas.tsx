import { useEffect, useRef } from "react";

import { listenEditMagicProgress } from "../../lib/edit/events";
import { extractDropped, fileToUploadReference, isImageDrop } from "../../lib/dragRef";
import { useEditMagic } from "../../lib/store/editMagic";
import { useEditor } from "./editor/editorStore";
import { useEditorActions } from "./editor/useEditor";
import {
  convertTextImageToTextbox,
  fitCanvasToImage,
  pickCanvasColorAt,
} from "./editor/magicLayerToFabric";
import { objectId } from "./editor/layerHelpers";
import {
  applyBrandCanvasSelection,
  applyBrandSelectionDefaults,
} from "./editor/selectionStyle";
import { RegionSelectOverlay, type NormalizedBbox } from "./RegionSelectOverlay";

type EditorCanvasProps = {
  /**
   * 範囲選択オーバーレイの状態。渡されたときだけ「ドラッグで囲む」モードになる。
   * 未指定なら従来どおり素のキャンバス (赤入れ等、他の呼び出し元を壊さない)。
   */
  regionSelect?: {
    value: NormalizedBbox | null;
    onChange: (bbox: NormalizedBbox | null) => void;
    disabled?: boolean;
    /** 未選択時の案内文 (AI に直させる範囲か、塗りつぶす範囲かで意味が変わる)。 */
    hint?: string;
  };
  /**
   * スポイト (「セリフ・文字を直す」の下地色を画像から拾う)。active の間だけ
   * キャンバス上のクリックを色拾いに使い、拾ったら onPick で返す。
   */
  eyedropper?: {
    active: boolean;
    onPick: (hex: string) => void;
  };
};

export function EditorCanvas({ regionSelect, eyedropper }: EditorCanvasProps = {}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<any>(null);
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  // store 経由で読む (ref だと fabric 初期化完了で再描画されず、オーバーレイが
  // canvas=null のまま固まる)。setCanvas が呼ばれた時点で再描画が走る。
  const liveCanvas = useEditor((state) => state.canvas);
  const activeTool = useEditor((state) => state.activeTool);
  const message = useEditor((state) => state.message);
  const error = useEditor((state) => state.error);
  const setCanvas = useEditor((state) => state.setCanvas);
  const setSelectedLayerId = useEditor((state) => state.setSelectedLayerId);
  const bumpRevision = useEditor((state) => state.bumpRevision);
  const progress = useEditMagic((state) => state.progress);
  const grabPreview = useEditor((state) => state.grabPreview);
  const busyTool = useEditor((state) => state.busyTool);
  const actions = useEditorActions();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    // @ts-ignore fabric is installed at runtime via package dependency
    void import("fabric").then((fabric) => {
      if (disposed || !canvasRef.current || !hostRef.current) return;
      // 選択枠をブランド色 (ピンク) にする。オブジェクトを作る前に基底クラスの
      // 既定値を書き換えるので、以後どこで作られたレイヤーにも効く
      // (生成箇所ごとの指定は書き忘れるので1点に集約する)。
      applyBrandSelectionDefaults(fabric as any);
      const canvas = new (fabric as any).Canvas(canvasRef.current, {
        backgroundColor: "#1a1a1a",
        preserveObjectStacking: true,
        selection: true,
      });
      applyBrandCanvasSelection(canvas);
      fabricCanvasRef.current = canvas;
      setCanvas(canvas);

      const resize = () => {
        const rect = hostRef.current?.getBoundingClientRect();
        if (!rect) return;
        canvas.setDimensions({ width: Math.max(320, rect.width), height: Math.max(320, rect.height) });
        const objects = canvas.getObjects?.() ?? [];
        const maxWidth = Math.max(...objects.map((object: any) => object.left + (object.width ?? 0)), 0);
        const maxHeight = Math.max(...objects.map((object: any) => object.top + (object.height ?? 0)), 0);
        if (maxWidth > 0 && maxHeight > 0) fitCanvasToImage(canvas, maxWidth, maxHeight);
        canvas.requestRenderAll?.();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(hostRef.current);

      canvas.on("selection:created", (event: any) => {
        const object = event.selected?.[0];
        setSelectedLayerId(object ? objectId(object) : null);
        bumpRevision();
      });
      canvas.on("selection:updated", (event: any) => {
        const object = event.selected?.[0];
        setSelectedLayerId(object ? objectId(object) : null);
        bumpRevision();
      });
      canvas.on("selection:cleared", () => {
        setSelectedLayerId(null);
        bumpRevision();
      });
      // object:modified は移動/拡縮/回転が「確定した」ときだけ発火する
      // (moving/scaling/rotating の連打中は発火しない)。ここでだけ履歴を積む。
      canvas.on("object:modified", () => {
        bumpRevision();
        useEditor.getState().pushHistory();
      });
      // 以下は連打イベント。プレビュー再描画のため revision は上げるが、履歴は積まない
      // (moving 連打で 1 ドラッグが数十スナップショットになるのを防ぐ)。確定は
      // object:modified が拾う。
      canvas.on("object:moving", bumpRevision);
      canvas.on("object:scaling", bumpRevision);
      canvas.on("object:rotating", bumpRevision);
      // 文字レイヤー (元画素そのまま) はダブルクリックで打ち替え可能なテキストへ変換する。
      // 世界標準の「文字はダブルクリックで編集」に合わせる (2026-07-03 STΛCK指摘
      // 「文字が画像になってるけどテキスト情報にならんかな」)。
      canvas.on("mouse:dblclick", (event: any) => {
        const target = event?.target;
        if (!target?.get?.("textSpec")) return;
        void convertTextImageToTextbox(canvas, target).then((converted) => {
          if (!converted) return;
          bumpRevision();
          useEditor.getState().pushHistory();
          useEditor
            .getState()
            .setMessage(
              "編集できるテキストに変換しました。もう一度クリックで打ち替え、右のプロパティでフォント・色を変更できます。認識できなかった文字は打ち直してください。",
            );
        });
      });
      canvas.on("mouse:down", (event: any) => {
        const tool = useEditor.getState().activeTool;
        if (tool !== "clickseg" && tool !== "grab") return;
        const pointer = canvas.getPointer(event.e);
        const objects = canvas.getObjects?.() ?? [];
        const imageWidth = Math.max(...objects.map((object: any) => object.left + (object.width ?? 0)), canvas.getWidth?.() ?? 1);
        const imageHeight = Math.max(...objects.map((object: any) => object.top + (object.height ?? 0)), canvas.getHeight?.() ?? 1);
        const x = Math.min(1, Math.max(0, pointer.x / Math.max(1, imageWidth)));
        const y = Math.min(1, Math.max(0, pointer.y / Math.max(1, imageHeight)));
        void actionsRef.current.handleCanvasClickForTool(x, y);
      });

      cleanup = () => {
        observer.disconnect();
        canvas.dispose?.();
        fabricCanvasRef.current = null;
        setCanvas(null);
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [bumpRevision, setCanvas, setSelectedLayerId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const store = useEditMagic.getState();
    void listenEditMagicProgress((payload) => store.setProgress(payload)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // 外部 OS ファイル / 別モニタからの Tauri ネイティブ D&D は window 全体イベント
  // として attachWindowDragDrop が受ける。編集タブがアクティブな間だけ、path 取り込み
  // ハンドラを store に登録して橋渡しする (非 React の attachWindowDragDrop から呼べる)。
  const setPathIngestor = useEditor((state) => state.setPathIngestor);
  useEffect(() => {
    setPathIngestor((path) => {
      void actionsRef.current.saveDroppedPathAndRunMagic(path);
    });
    return () => setPathIngestor(null);
  }, [setPathIngestor]);

  const drop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isImageDrop(event.dataTransfer)) return;
    event.preventDefault();
    // アプリ内部の参照ドラッグ (gallery / preset) は path をそのまま取り込む。
    // 外部 OS ファイルは File 経由で writeUpload してから取り込む。
    const { refs, files } = extractDropped(event.dataTransfer);
    const internalPath = refs[0]?.path;
    if (internalPath) {
      void actionsRef.current.saveDroppedPathAndRunMagic(internalPath);
      return;
    }
    const file = files[0];
    if (file) {
      void fileToUploadReference(file).then((ref) => {
        void actionsRef.current.saveDroppedPathAndRunMagic(ref.path);
      });
    }
  };

  const statusText = progress ? progressLabel(progress.kind) : message;

  return (
    <main
      ref={hostRef}
      onDrop={drop}
      onDragOver={(event) => event.preventDefault()}
      className="relative min-w-0 flex-1 overflow-hidden bg-[#1a1a1a]"
    >
      <canvas ref={canvasRef} id="editor-canvas" className="block" />

      {/*
        範囲選択オーバーレイ。画像を開いている間だけ、キャンバスの上に重ねる。
        fabric のオブジェクトではないので、書き出した PNG に選択枠は入らない。
      */}
      {regionSelect && sourceImagePath && liveCanvas ? (
        <RegionSelectOverlay
          canvas={liveCanvas}
          value={regionSelect.value}
          onChange={regionSelect.onChange}
          disabled={regionSelect.disabled}
          hint={regionSelect.hint}
        />
      ) : null}

      {/*
        スポイト。範囲選択オーバーレイ (z-10) より上に置き、拾う間だけクリックを奪う。
        fabric の座標変換は RegionSelectOverlay と同じ式 (画面 → scene) を使う。
        pickCanvasColorAt はキャンバスの実ピクセルを読むので、下地の元画像でも
        既に置いた塗りでも「見えている色」がそのまま拾える。
      */}
      {eyedropper?.active && sourceImagePath && liveCanvas ? (
        <div
          className="absolute inset-0 z-20 cursor-crosshair"
          role="presentation"
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const vpt = (liveCanvas as { viewportTransform?: number[] }).viewportTransform;
            const zoom = vpt?.[0] ?? 1;
            const x = (event.clientX - rect.left - (vpt?.[4] ?? 0)) / zoom;
            const y = (event.clientY - rect.top - (vpt?.[5] ?? 0)) / zoom;
            const hex = pickCanvasColorAt(liveCanvas, { x, y });
            if (hex) eyedropper.onPick(hex);
          }}
        >
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-pink-400/60 bg-[#101010]/95 px-3 py-1.5 text-[11px] font-bold text-pink-100 shadow-xl">
            下地にしたい色をクリック
          </div>
        </div>
      ) : null}

      {!sourceImagePath ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-dashed border-pink-400/50 bg-[#101010]/90 p-6 text-center shadow-2xl">
            <div className="flex justify-center text-pink-300">
              <DropLayersIcon />
            </div>
            <h3 className="mt-3 text-sm font-black text-white">画像をドロップ</h3>
            <p className="mt-2 text-xs font-bold leading-5 text-neutral-400">
              開いたら右の「ことばで直す」に指示を書くだけ。
              直したい場所をドラッグで囲めば、そこだけ直せます。
            </p>
            <button
              type="button"
              onClick={() => void actions.chooseImage()}
              className="mt-4 rounded-lg bg-pink-500 px-4 py-2 text-xs font-black text-white hover:bg-pink-600"
            >
              画像を選ぶ
            </button>
          </div>
        </div>
      ) : null}

      {activeTool === "clickseg" ? (
        <div className="absolute left-4 top-4 rounded-full border border-amber-300/60 bg-amber-300/15 px-3 py-1 text-xs font-black text-amber-100">
          対象をクリック
        </div>
      ) : null}

      {activeTool === "grab" && !grabPreview ? (
        <div className="absolute left-4 top-4 rounded-full border border-pink-400/60 bg-pink-500/15 px-3 py-1 text-xs font-black text-pink-100">
          掴みたい対象をクリック
        </div>
      ) : null}

      {activeTool === "grab" && grabPreview ? (
        <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full border border-pink-400/60 bg-[#101010]/95 px-3 py-1.5 shadow-xl">
          <span className="text-xs font-bold text-neutral-200">この範囲を掴みますか?</span>
          <button
            type="button"
            onClick={() => void actions.confirmGrab()}
            disabled={busyTool === "grab"}
            className="rounded-full bg-pink-500 px-3 py-1 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {busyTool === "grab" ? "処理中…" : "掴む"}
          </button>
          <button
            type="button"
            onClick={() => actions.cancelGrab()}
            disabled={busyTool === "grab"}
            className="rounded-full border border-[#343434] px-3 py-1 text-xs font-bold text-neutral-300 hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-40"
          >
            やり直す
          </button>
        </div>
      ) : null}

      {/*
        エラー/ステータスのオーバーレイ。
        以前は error 文字列をそのまま full-width で描画していたため、ツールが返す
        Python traceback 全文がキャンバスを覆う事故が起きていた (2026-07-02 修正)。
        エラーは固定サイズのカード (最大3行 + コピー) に必ず収め、どれだけ長い
        traceback でもキャンバスへ流れ込まないようにする。ステータス (短文) だけ pill 表示。
      */}
      {error ? (
        <div className="absolute bottom-4 left-1/2 w-[min(24rem,calc(100%-2rem))] -translate-x-1/2">
          <CanvasErrorCard message={error} onDismiss={() => useEditor.getState().setError(null)} />
        </div>
      ) : statusText ? (
        <div className="absolute bottom-4 left-4 right-4 flex justify-center">
          <div className="max-w-2xl truncate rounded-full border border-[#343434] bg-[#101010]/90 px-4 py-2 text-xs font-bold text-neutral-200 shadow-xl">
            {statusText}
          </div>
        </div>
      ) : null}
    </main>
  );
}

/**
 * キャンバス上のエラーカード。長い traceback でもレイアウトを壊さないよう最大3行に抑え、
 * 全文はコピーで取り出す。閉じるとオーバーレイが消えてキャンバスが再び主役になる。
 */
function CanvasErrorCard({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const copy = () => {
    void navigator.clipboard?.writeText(message).catch(() => undefined);
  };
  return (
    <div className="rounded-lg border border-red-500/50 bg-[#160d0d]/95 px-3 py-2 shadow-2xl">
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-[11px] font-bold leading-4 text-red-100">
          {message}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="閉じる"
          className="shrink-0 rounded p-0.5 text-red-200/70 hover:text-red-100"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        onClick={copy}
        className="mt-1.5 rounded border border-red-400/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-200 hover:bg-red-500/20"
      >
        詳細をコピー
      </button>
    </div>
  );
}

function progressLabel(kind: string): string {
  const labels: Record<string, string> = {
    started: "レイヤー分解を開始…",
    detectingText: "テキストを検出中…",
    removingText: "テキストを除去中…",
    segmenting: "人物を切り抜き中…",
    segmentingObjects: "物体を検出中…",
    inpaintingBackground: "背景を補完中…",
    buildingTextLayers: "レイヤーを構築中…",
    completed: "完了しました",
    failed: "失敗しました",
  };
  return labels[kind] ?? kind;
}

function DropLayersIcon() {
  return (
    <svg
      width={40}
      height={40}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </svg>
  );
}
