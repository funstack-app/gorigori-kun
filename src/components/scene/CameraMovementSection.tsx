import {
  cameraMovementOptions,
  cameraSpeedOptions,
  cameraStartPositionOptions,
} from "../../lib/scene/video-catalog";
import { useVideoSceneStore } from "../../lib/store/videoScene";
import { OptionPickerButton } from "./OptionPickerButton";

export function CameraMovementSection() {
  const cameraMovement = useVideoSceneStore((state) => state.cameraMovement);
  const setCameraMovementField = useVideoSceneStore((state) => state.setCameraMovementField);

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="カメラの動き"
        options={cameraMovementOptions}
        value={cameraMovement.motion}
        onPick={(value) => setCameraMovementField("motion", value)}
        modalTitle="カメラの動きを選ぶ"
      />
      <OptionPickerButton
        label="カメラ速度"
        options={cameraSpeedOptions}
        value={cameraMovement.speed}
        onPick={(value) => setCameraMovementField("speed", value)}
        modalTitle="カメラ速度を選ぶ"
      />
      <OptionPickerButton
        label="カメラの開始位置"
        options={cameraStartPositionOptions}
        value={cameraMovement.startPosition}
        onPick={(value) => setCameraMovementField("startPosition", value)}
        modalTitle="開始位置を選ぶ"
      />
    </div>
  );
}
