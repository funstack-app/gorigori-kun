import { describe, expect, it } from "vitest";

import {
  findAvailableStepIndex,
  PAGE_TOURS,
  WELCOME_TOUR,
  type TourStep,
} from "../src/lib/tour";

describe("tour definitions", () => {
  it("has unique ids, non-empty steps, and tours for every guided page", () => {
    const pageTours = Object.values(PAGE_TOURS);
    const tours = [...pageTours, WELCOME_TOUR];
    const ids = tours.map((tour) => tour.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "planning",
        "artwork-generation",
        "video-generation",
        "editing",
        "library",
        "projects",
        "presets",
        "chat-history",
        "error-log",
        "skills",
        "film",
        "storyboard",
        "comic",
        "sticker",
        "multi-angle",
        "product-set",
        "character-register",
        "expression-set",
        "scene-3d",
        "scene-recreate",
        "redline",
        "regulation-check",
        "settings-connections",
      ]),
    );
    expect(pageTours.length).toBeGreaterThanOrEqual(23);
    for (const tour of pageTours) {
      expect(tour.steps.length).toBeGreaterThanOrEqual(3);
      expect(tour.steps.length).toBeLessThanOrEqual(7);
    }
    for (const tour of tours) {
      expect(tour.steps.length).toBeGreaterThan(0);
      for (const step of tour.steps) {
        expect(step.target.trim()).not.toBe("");
        expect(step.title.trim()).not.toBe("");
        expect(step.body.trim()).not.toBe("");
      }
    }
  });

  it("skips missing targets and returns the next available step", () => {
    const steps: TourStep[] = [
      { target: "#missing-a", title: "A", body: "A", placement: "bottom" },
      { target: "#found", title: "B", body: "B", placement: "bottom" },
      { target: "#missing-c", title: "C", body: "C", placement: "bottom" },
    ];
    const resolve = (selector: string) => (selector === "#found" ? {} : null);

    expect(findAvailableStepIndex(steps, 0, 1, resolve)).toBe(1);
    expect(findAvailableStepIndex(steps, 2, -1, resolve)).toBe(1);
    expect(findAvailableStepIndex(steps, 2, 1, resolve)).toBeNull();
  });
});
