type AICommandBarProps = {
  prompt: string;
  selectedLayerName: string | null;
  loading: boolean;
  onPromptChange: (prompt: string) => void;
  onRun: (harmonize: boolean) => void;
};

export function AICommandBar({
  prompt,
  selectedLayerName,
  loading,
  onPromptChange,
  onRun,
}: AICommandBarProps) {
  const canRun = Boolean(selectedLayerName && prompt.trim()) && !loading;

  return (
    <div className="grid h-20 shrink-0 grid-cols-[minmax(0,1fr)_220px_160px] items-center gap-3 border-t border-[#242424] bg-[#181818] px-4 py-3">
      <textarea
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        rows={2}
        placeholder={
          selectedLayerName
            ? `${selectedLayerName} に加える変更を入力`
            : "レイヤーを選択してください"
        }
        className="h-14 resize-none rounded-lg border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400"
      />

      <div className="grid gap-2">
        <select
          value="selected"
          onChange={() => undefined}
          className="h-8 rounded-md border border-[#343434] bg-[#101010] px-2 text-xs font-bold text-neutral-100 outline-none focus:border-pink-400"
        >
          <option value="selected">選択中のレイヤーを再生成</option>
          <option value="new" disabled>
            新規レイヤーとして追加
          </option>
          <option value="whole" disabled>
            全体に適用
          </option>
        </select>
      </div>

      <RunButton
        canRun={canRun}
        loading={loading}
        onRun={onRun}
      />
    </div>
  );
}

function RunButton({
  canRun,
  loading,
  onRun,
}: {
  canRun: boolean;
  loading: boolean;
  onRun: (harmonize: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onRun(false)}
      disabled={!canRun}
      className="h-11 rounded-lg bg-pink-500 px-4 text-sm font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
    >
      {loading ? "実行中..." : "実行"}
    </button>
  );
}
