import { styleOptions } from "../../lib/scene/catalog";
import { useSceneStore } from "../../lib/store/scene";
import { OptionPickerButton } from "./OptionPickerButton";

/**
 * 統合スタイル軸。1 個選ぶだけで「ジャンル + 色味 + 質感」が決まる。
 * 旧 写真家スタイル / 映画ルック / フィルター / 自由度スライダーは廃止。
 * 微調整したい上級者は構築プロンプトを直接書き換えられる。
 */
export function StyleSection() {
  const style = useSceneStore((state) => state.style);
  const setStyleField = useSceneStore((state) => state.setStyleField);

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="スタイル"
        options={styleOptions}
        value={style.cinematicLook}
        onPick={(value) => setStyleField("cinematicLook", value)}
        modalTitle="スタイルを選ぶ"
      />
    </div>
  );
}
