import { useState } from "react";

import { NO_SELECT } from "../../lib/scene/catalog";
import { useSceneStore } from "../../lib/store/scene";
import { CameraSection } from "./CameraSection";
import { LightingMoodSection } from "./LightingMoodSection";
import { SceneCompactCard } from "./SceneCompactCard";
import { SceneSectionModal } from "./SceneSectionModal";
import { StyleSection } from "./StyleSection";
import { SubjectFramingSection } from "./SubjectFramingSection";

function show(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === NO_SELECT) return fallback;
  return trimmed;
}

function compact(...values: string[]): string {
  const filtered = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== NO_SELECT);
  return filtered.length > 0 ? filtered.join(" / ") : "未設定";
}

type SectionId = "subject" | "lighting" | "camera" | "style";

/**
 * シーン構築 §01-§04 を 2x2 のコンパクトカードで提示。
 * 各カードは現在の選択サマリだけを表示し、クリックで編集モーダルを開く。
 *
 * Why: 旧アコーディオン UI はスクロール必須で全体把握が難しかった。
 * 2x2 なら 4 セクション全部が一画面に収まり、Magnific 流の
 * 「結果はコンパクト、編集はモーダル」が一貫する。
 */
export function SceneBuilder() {
  const subjectFraming = useSceneStore((state) => state.subjectFraming);
  const lightingMood = useSceneStore((state) => state.lightingMood);
  const camera = useSceneStore((state) => state.camera);
  const style = useSceneStore((state) => state.style);

  const [openSection, setOpenSection] = useState<SectionId | null>(null);
  const close = () => setOpenSection(null);

  const subjectSummary = compact(
    show(subjectFraming.subject, "主役未入力"),
    subjectFraming.composition,
    subjectFraming.aspectRatio,
  );
  const lightingSummary = compact(
    lightingMood.lightSource,
    show(lightingMood.mood, ""),
  );
  // ショット幅は focalLength 保存先を再利用
  const cameraSummary = compact(camera.equipment, camera.focalLength);
  const styleSummary = compact(style.cinematicLook);

  return (
    <>
      <div className="scene-builder-stack space-y-2">
        <SceneCompactCard
          number="01"
          title="主役と構図"
          summary={subjectSummary}
          onClick={() => setOpenSection("subject")}
        />
        <SceneCompactCard
          number="02"
          title="光と雰囲気"
          summary={lightingSummary}
          onClick={() => setOpenSection("lighting")}
        />
        <SceneCompactCard
          number="03"
          title="カメラ"
          summary={cameraSummary}
          onClick={() => setOpenSection("camera")}
        />
        <SceneCompactCard
          number="04"
          title="スタイル"
          summary={styleSummary}
          onClick={() => setOpenSection("style")}
        />
      </div>

      <SceneSectionModal
        open={openSection === "subject"}
        number="01"
        title="主役と構図"
        onClose={close}
      >
        <SubjectFramingSection />
      </SceneSectionModal>
      <SceneSectionModal
        open={openSection === "lighting"}
        number="02"
        title="光と雰囲気"
        onClose={close}
      >
        <LightingMoodSection />
      </SceneSectionModal>
      <SceneSectionModal
        open={openSection === "camera"}
        number="03"
        title="カメラ"
        onClose={close}
      >
        <CameraSection />
      </SceneSectionModal>
      <SceneSectionModal
        open={openSection === "style"}
        number="04"
        title="スタイル"
        onClose={close}
      >
        <StyleSection />
      </SceneSectionModal>
    </>
  );
}
