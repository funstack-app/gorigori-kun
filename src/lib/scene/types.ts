// GPT Image 2 が対応するアスペクト比 (2026-06-09 拡充: 5:4 / 3:4 追加で10種)。
// GPT Image 2 公式制約 (OpenAI docs): アスペクト比は 1:3〜3:1、両辺16の倍数、各辺<=3840px、
// 総ピクセル 655,360〜8,294,400。下記10種はすべてこの制約内 (例サイズ併記)。
// 横長: 21:9(2560x1088), 16:9(1536x864), 3:2(1536x1024), 4:3(1024x768), 5:4(1280x1024)
// 正方: 1:1(1024x1024)
// 縦長: 4:5(1024x1280), 3:4(768x1024), 2:3(1024x1536), 9:16(864x1536)
export type SceneAspectRatio =
  | "21:9"
  | "16:9"
  | "3:2"
  | "4:3"
  | "5:4"
  | "1:1"
  | "4:5"
  | "3:4"
  | "2:3"
  | "9:16";

export type ReferenceSlotId = "@img1" | "@img2" | "@img3" | "@img4" | "@img5";

export type SubjectFramingState = {
  subject: string;
  /**
   * どこまで写すか (被写体との距離)。極寄り→顔→胸上→腰上→膝上→全身→引き。
   *
   * 2026-07-27: 旧「構図」を役割で3つに割った1つ目。以前は distance / angle / framing が
   * 1つのフィールドを奪い合っており、「胸上まで寄って、下から見上げて、左に寄せる」という
   * 実際の撮影で普通に併用する指定が同時にできなかった (STΛCK 指摘)。
   * buildPrompt では3つとも別々の要素としてプロンプトに出す。
   */
  composition: string;
  /** どこから撮るか (カメラの高さ・角度・被写体の向き)。 */
  cameraAngle: string;
  /** どう見せるか (画面内の配置・遮蔽・反射などの演出)。 */
  framing: string;
  aspectRatio: SceneAspectRatio;
  environment: string;
};

export type LightingMoodState = {
  lightSource: string;
  mood: string;
};

export type CameraState = {
  equipment: string;
  focalLength: string;
  lens: string;
  film: string;
};

export type StyleState = {
  freedom: number;
  photographerStyle: string;
  cinematicLook: string;
  filter: string;
};

export type SceneReferenceSlot = {
  id: ReferenceSlotId;
  enabled: boolean;
  label: string;
  note: string;
};

export type ReferenceSectionState = {
  slots: SceneReferenceSlot[];
};

export type SceneState = {
  subjectFraming: SubjectFramingState;
  lightingMood: LightingMoodState;
  camera: CameraState;
  style: StyleState;
  reference: ReferenceSectionState;
};

export type SubjectFramingField = keyof SubjectFramingState;
export type LightingMoodField = keyof LightingMoodState;
export type CameraField = keyof CameraState;
export type StyleField = keyof StyleState;

