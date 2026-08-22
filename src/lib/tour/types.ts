export type TourPlacement = "top" | "right" | "bottom" | "left" | "auto";

export type TourStep = {
  target: string;
  title: string;
  body: string;
  placement: TourPlacement;
};

export type TourDefinition = {
  id: string;
  steps: TourStep[];
};
