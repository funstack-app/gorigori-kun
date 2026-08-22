import type { SettingsWorkspaceTab } from "../store/workspace";

export type TourPlacement = "top" | "right" | "bottom" | "left" | "auto";

export type TourStepAction = {
  type: "settings-tab";
  tab: SettingsWorkspaceTab;
};

export type TourStep = {
  target: string;
  title: string;
  body: string;
  placement: TourPlacement;
  beforeAction?: TourStepAction;
};

export type TourDefinition = {
  id: string;
  steps: TourStep[];
};
