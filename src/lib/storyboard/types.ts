export type ScoreBundle = {
  identity: number;
  outfit: number;
  prop: number;
  face: number;
  hand: number;
  background: number;
};

export type SceneGroup = { id: string; cutIds: string[] };

export type StoryboardEvent =
  | { kind: "started"; runId: string; totalCuts: number; sceneGroups: SceneGroup[] }
  | { kind: "cutStarted"; cutId: string; sceneGroupId: string; takeCount: number }
  | { kind: "takeCompleted"; cutId: string; takeId: string; imagePath: string; scores: ScoreBundle }
  | { kind: "cutCheckpoint"; cutId: string; reason: string }
  | { kind: "cutConfirmed"; cutId: string; selectedTakeId: string }
  | { kind: "cutFailed"; cutId: string; reason: string }
  | { kind: "completed"; runId: string; manifestPath: string };

export type StoryboardAspectRatio = "9:16" | "1:1" | "16:9" | "4:5";
export type StoryboardTempo = "fast" | "standard" | "slow";

export type StoryboardParams = {
  duration_seconds: number;
  aspect_ratio: StoryboardAspectRatio;
  tempo: StoryboardTempo;
  character_reference_path: string;
  style_reference_path?: string;
};

export type SceneConstruction = {
  total_cuts: number;
  cuts: Array<{
    cut_id: string;
    description: string;
    duration_seconds: number;
  }>;
};

export type StoryboardRunParams = {
  storyPrompt: string;
  characterReferenceImage: string;
  styleReferenceImage?: string;
  aspectRatio: StoryboardAspectRatio;
  durationSeconds: number;
  tempo: StoryboardTempo;
  candidatesPerCut: 1 | 3;
  cwd?: string;
  sceneConstruction?: SceneConstruction;
};

export type StoryboardEditMagicLayerStep = {
  kind: "edit_magic_layer";
  imagePath: string;
  autoRun?: boolean;
};

export type StoryboardSkillStep = StoryboardEditMagicLayerStep;

export type StoryboardCompletedResult = {
  cuts: Array<{
    cutId: string;
    selectedTake: {
      imagePath: string;
    };
  }>;
};
