import { useComposer } from "../lib/store/composer";
import { useImages } from "../lib/store/images";
import {
  useWorkflow,
  type ImageMode,
  type LayerKind,
  type VideoMode,
} from "../lib/store/workflow";
import { useToasts } from "../lib/store/toasts";
import { SegmentedTabs } from "./ui";

export function StudioSidebar({ onEdit }: { onEdit?: (path: string) => void }) {
  const primaryMode = useWorkflow((s) => s.primaryMode);
  void onEdit;

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-neutral-200 bg-[#fbfbfc]">
      {primaryMode === "video" ? <VideoModePanel /> : <ImageModePanel />}
    </aside>
  );
}

function VideoModePanel() {
  const videoMode = useWorkflow((s) => s.videoMode);
  const setVideoMode = useWorkflow((s) => s.setVideoMode);
  const lockedReference = useWorkflow((s) => s.lockedReference);
  const lockReference = useWorkflow((s) => s.lockReference);
  const clearReference = useWorkflow((s) => s.clearReference);
  const selected = useSelectedGalleryItem();
  const addReference = useComposer((s) => s.addReference);
  const push = useToasts((s) => s.push);

  return (
    <section className="border-b border-neutral-200 bg-white p-4 text-xs">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-700">
            Inspector
          </p>
          <h2 className="mt-1 text-lg font-black tracking-normal text-neutral-950">
            動画モード
          </h2>
        </div>
        <span className="rounded border border-neutral-300 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-700">
          一貫性
        </span>
      </div>

      <SegmentedTabs<VideoMode>
        value={videoMode}
        options={[
          ["story", "ストーリーカット"],
          ["multiAngle", "マルチアングル"],
        ]}
        onChange={setVideoMode}
      />

      <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
        <p className="mb-1 text-sm font-bold text-neutral-900">基準リファレンス</p>
        {lockedReference ? (
          <>
            <p className="truncate font-mono text-[11px] text-blue-700" title={lockedReference.path}>
              {lockedReference.name}
            </p>
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() =>
                  addReference({
                    path: lockedReference.path,
                    name: lockedReference.name,
                    source: "gallery",
                    role: "subject",
                  })
                }
                className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 font-medium text-neutral-700 hover:border-neutral-500 hover:text-neutral-950"
              >
                入力欄へ
              </button>
              <button
                type="button"
                onClick={clearReference}
                className="rounded border border-neutral-300 bg-white px-2 py-1 text-neutral-500 hover:border-rose-500 hover:text-rose-600"
              >
                解除
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[11px] leading-relaxed text-neutral-600">
              左の生成履歴で好きな1枚を選び、人物・環境・ルックの基準に固定します。
            </p>
            <button
              type="button"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                lockReference({ path: selected.path, name: selected.name });
                addReference({
                  path: selected.path,
                  name: selected.name,
                  source: "gallery",
                  role: "subject",
                });
                push({
                  kind: "success",
                  text: "基準リファレンスに固定しました",
                  ttlMs: 2500,
                });
              }}
              className="mt-2 w-full rounded bg-neutral-950 px-2 py-1.5 font-semibold text-white hover:bg-neutral-800 disabled:opacity-40"
            >
              選択中の画像を基準にする
            </button>
          </>
        )}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
        {videoMode === "story"
          ? "参照画像を素材の軸にしながら、広告・サムネ・キービジュアルなど指示に合わせた制作カットを1枚ずつ作ります。"
          : "Look分析と被写体固定を内部で行い、位置関係と環境を保ったままカメラだけを動かします。グリッドではなく1枚ずつ生成します。"}
      </p>

      <div className="mt-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
        <p className="text-sm font-bold text-neutral-900">生成の考え方</p>
        <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-neutral-600">
          <li>・入力欄の参照チップで「被写体固定」「ルック参照」などを指定</li>
          <li>・ユーザー指示を最優先し、参照は必要な要素だけ引き継ぐ</li>
          <li>・履歴画像は左から入力欄へドラッグして再利用</li>
        </ul>
      </div>
    </section>
  );
}

function ImageModePanel() {
  const imageMode = useWorkflow((s) => s.imageMode);
  const setImageMode = useWorkflow((s) => s.setImageMode);

  return (
    <section className="border-b border-neutral-200 bg-white p-4 text-xs">
      <div className="mb-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-700">
          Inspector
        </p>
        <h2 className="mt-1 text-lg font-black tracking-normal text-neutral-950">
          画像モード
        </h2>
      </div>
      <SegmentedTabs<ImageMode>
        value={imageMode}
        options={[
          ["generate", "生成"],
          ["edit", "編集"],
          ["layers", "レイヤー"],
        ]}
        onChange={setImageMode}
      />
      {imageMode === "layers" ? <LayerPanel /> : <ImageModeHelp mode={imageMode} />}
    </section>
  );
}

function ImageModeHelp({ mode }: { mode: ImageMode }) {
  const selected = useSelectedGalleryItem();
  const addReference = useComposer((s) => s.addReference);
  const prompt =
    mode === "generate"
      ? "単発ビジュアル、広告素材、サムネ、LPパーツを作る入口です。"
      : "生成済みカットを参照画像として添付し、マスク編集や全体修正に回します。";
  return (
    <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
      <p className="text-[11px] leading-relaxed text-neutral-600">{prompt}</p>
      {mode === "edit" && (
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            addReference({
              path: selected.path,
              name: selected.name,
              source: "gallery",
              role: "subject",
            });
          }}
          className="mt-2 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 font-semibold text-neutral-800 hover:border-neutral-500 hover:bg-neutral-50 disabled:opacity-40"
        >
          選択中の画像を編集素材にする
        </button>
      )}
    </div>
  );
}

function LayerPanel() {
  const layers = useWorkflow((s) => s.layers);
  const addLayer = useWorkflow((s) => s.addLayer);
  const toggleLayer = useWorkflow((s) => s.toggleLayer);
  const setLayerOpacity = useWorkflow((s) => s.setLayerOpacity);
  const removeLayer = useWorkflow((s) => s.removeLayer);

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-1">
        {(["text", "person", "background", "object", "adjustment"] as LayerKind[]).map(
          (kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => addLayer(kind)}
              className="rounded border border-neutral-300 bg-white px-1.5 py-1 text-[10px] font-medium text-neutral-700 hover:border-neutral-500 hover:text-neutral-950"
            >
              + {layerKindLabel(kind)}
            </button>
          ),
        )}
      </div>
      <div className="space-y-1.5">
        {layers.map((layer) => (
          <div
            key={layer.id}
            className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggleLayer(layer.id)}
                className="w-5 text-left text-neutral-600"
                title={layer.visible ? "非表示にする" : "表示する"}
              >
                {layer.visible ? "On" : "Off"}
              </button>
              <span className="flex-1 text-neutral-800">{layer.name}</span>
              <button
                type="button"
                onClick={() => removeLayer(layer.id)}
                className="text-neutral-400 hover:text-rose-600"
              >
                X
              </button>
            </div>
            <label className="mt-1 flex items-center gap-2 text-[10px] text-neutral-500">
              不透明度
              <input
                type="range"
                min={0}
                max={100}
                value={layer.opacity}
                onChange={(e) => setLayerOpacity(layer.id, Number(e.target.value))}
                className="flex-1"
              />
              <span className="w-8 text-right tabular-nums">{layer.opacity}</span>
            </label>
          </div>
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-neutral-500">
        現段階はレイヤー設計パネルです。次に背景分離・人物分離・テキストレイヤー編集を実画像処理に接続します。
      </p>
    </div>
  );
}

function useSelectedGalleryItem() {
  return useImages((s) => s.items.find((item) => item.path === s.selectedPath));
}

function layerKindLabel(kind: LayerKind) {
  switch (kind) {
    case "text":
      return "文字";
    case "person":
      return "人物";
    case "background":
      return "背景";
    case "object":
      return "素材";
    case "adjustment":
      return "色調";
  }
}
