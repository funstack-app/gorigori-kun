export type AgentStatus = "mock" | "ready";

export type AgentResult<TData> = {
  status: AgentStatus;
  data: TData;
  rawText: string;
};

export type AgentRunArgs<TInput> = {
  input: TInput;
  signal?: AbortSignal;
};

export type AgentRunner<TInput, TData> = (
  args: AgentRunArgs<TInput>,
) => Promise<AgentResult<TData>>;

export type ProductSceneInput = {
  subject?: string;
  composition?: string;
  aspectRatio?: string;
  environment?: string;
  lighting?: string;
  mood?: string;
  camera?: string;
  focalLength?: string;
  lens?: string;
  film?: string;
  strictness?: number;
  photographerStyle?: string;
  cinematicLook?: string;
  filter?: string;
  references?: string[];
};

export type ProductPromptResult = {
  prompt: string;
  sections: {
    subjectAndComposition: string;
    lightAndMood: string;
    camera: string;
    style: string;
    references: string;
  };
};

export type AdTargetInput = {
  age?: string;
  gender?: string;
  attribute?: string;
  pain?: string;
};

export type AppealAxis =
  | "functional"
  | "emotional"
  | "comparative"
  | "empathy";

export type AdPitchInput = {
  product: string;
  target: AdTargetInput;
  appealAxis?: AppealAxis;
};

export type AdPitch = {
  id: string;
  axis: AppealAxis;
  title: string;
  angle: string;
  reason: string;
};

export type AdPitchResult = {
  pitches: AdPitch[];
};

export type AdCopyInput = {
  pitch: AdPitch | string;
  target: AdTargetInput;
};

export type AdCopyResult = {
  mainCopy: string;
  subCopy: string;
};

export type VideoDuration = "15s" | "30s" | "60s" | "custom";

export type VideoStoryInput = {
  core: string;
  duration: VideoDuration;
};

export type StoryboardCut = {
  cutNumber: number;
  role: "起" | "承" | "転" | "結";
  composition: string;
  cameraWork: string;
  durationSeconds: number;
};

export type StoryboardResult = {
  cuts: StoryboardCut[];
  totalDurationSeconds: number;
};
