import { EDIT_MODES, type EditModeId } from "../../lib/edit/modes";

type Props = {
  activeMode: EditModeId;
  onSelectMode: (mode: EditModeId) => void;
  disabled?: boolean;
};

/**
 * 上部バー用のコンパクトなモード切替 (Photoshop 風 UI 再構成 2026-07-02)。
 *
 * 以前は編集タブ上部にカード型の巨大なモード選択 (説明文・必要スペック・DLボタン付き)
 * が居座り「上の項目がでかすぎる」状態だった。上部バーには select 1つだけを置き、
 * 必要スペック表示とモデル追加DLは右パネルの折りたたみセクション (フル版 EditModeSelector)
 * に格下げする。
 */
export function EditModeSelectorCompact({ activeMode, onSelectMode, disabled }: Props) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] font-bold text-neutral-500">分解</span>
      <select
        value={activeMode}
        disabled={disabled}
        onChange={(e) => onSelectMode(e.target.value as EditModeId)}
        className="h-7 rounded-md border border-[#343434] bg-[#101010] px-2 text-[11px] font-bold text-neutral-100 outline-none focus:border-pink-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {EDIT_MODES.map((mode) => (
          <option key={mode.id} value={mode.id}>
            {mode.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default EditModeSelectorCompact;
