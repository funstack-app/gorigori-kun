import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("設定ツアーは各ステップ前に対象タブを開くと7件すべてへ到達できる", () => {
    const steps = PAGE_TOURS.settingsConnections.steps;
    let activeTab = "basic";
    const reached = steps.map((step, index) => {
      if (step.beforeAction?.type === "settings-tab") {
        activeTab = step.beforeAction.tab;
      }
      return findAvailableStepIndex(steps, index, 1, (selector) => {
        if (selector === '[data-tour="settings-tabs"]') return {};
        return selector === `[data-tour="settings-panel-${activeTab}"]` ? {} : null;
      });
    });

    expect(steps).toHaveLength(7);
    expect(reached).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(steps.slice(1).map((step) => step.beforeAction?.tab)).toEqual([
      "basic",
      "storage",
      "storage",
      "accounts",
      "connections",
      "diagnostics",
    ]);
  });

  it("has a real target for the image-generation scene builder step", () => {
    const target = '[data-tour="generation-scene-builder"]';
    const step = PAGE_TOURS.artworkGeneration.steps.find((item) => item.target === target);
    const source = readFileSync(resolve("src/components/GenerationWorkspace.tsx"), "utf8");

    expect(step).toBeDefined();
    expect(source).toContain('data-tour="generation-scene-builder"');
  });
});
