import {
  cameraEquipmentOptions,
  shotOptions,
} from "../../lib/scene/catalog";
import { useSceneStore } from "../../lib/store/scene";
import { OptionPickerButton } from "./OptionPickerButton";

/**
 * カメラ §03。「機材」と「ショット幅」の 2 要素に簡素化。
 *
 * 旧仕様の問題:
 * - 焦点距離（8mm 等の数値）と レンズ（Fisheye 等の効果名）が同義語で重複
 * - フィルム種類（Cinestill / Kodak 等）はスタイル軸と重複
 *
 * 整理後:
 * - 機材: 5 個（シネマ/デジタル一眼/フィルム/スマホ/VHS）→ 質感を決める
 * - ショット幅: 8 個（焦点距離 + 特殊レンズを統合）→ フレーミングを決める
 *
 * store 互換性: equipment はそのまま、focalLength を「ショット幅」の保存先に再利用。
 * lens / film フィールドは store に残るが UI からは非表示、buildPrompt も無視。
 */
export function CameraSection() {
  const camera = useSceneStore((state) => state.camera);
  const setCameraField = useSceneStore((state) => state.setCameraField);

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="カメラ機材"
        options={cameraEquipmentOptions}
        value={camera.equipment}
        onPick={(value) => setCameraField("equipment", value)}
        modalTitle="カメラ機材を選ぶ"
      />
      <OptionPickerButton
        label="ショット幅"
        options={shotOptions}
        value={camera.focalLength}
        onPick={(value) => setCameraField("focalLength", value)}
        modalTitle="ショット幅を選ぶ"
      />
    </div>
  );
}
