import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestModules = {
  React: typeof import("react");
  SkillErrorBoundary: typeof import("../src/components/SkillErrorBoundary").SkillErrorBoundary;
  useErrorLog: typeof import("../src/lib/store/errorLog").useErrorLog;
  useSkillMode: typeof import("../src/lib/store/skillMode").useSkillMode;
  useSkillUiMode: typeof import("../src/lib/store/skillUiMode").useSkillUiMode;
};

describe("SkillErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let modules: TestModules;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { SkillErrorBoundary } = await import(
      "../src/components/SkillErrorBoundary"
    );
    const { useErrorLog } = await import("../src/lib/store/errorLog");
    const { useSkillMode } = await import("../src/lib/store/skillMode");
    const { useSkillUiMode } = await import("../src/lib/store/skillUiMode");

    modules = {
      React,
      SkillErrorBoundary,
      useErrorLog,
      useSkillMode,
      useSkillUiMode,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await modules.React.act(async () => {
      root.unmount();
    });
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  function throwingChild(message = "描画失敗"): never {
    throw new Error(message);
  }

  function buttonWithText(label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === label,
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
  }

  it("throw したスロットだけフォールバックにし、境界の外側を残す", async () => {
    const { React, SkillErrorBoundary } = modules;

    await React.act(async () => {
      root.render(
        React.createElement(
          "div",
          null,
          React.createElement("p", null, "境界の外側"),
          React.createElement(SkillErrorBoundary, {
            mode: "storyboard",
            children: React.createElement(throwingChild),
          }),
        ),
      );
    });

    expect(container.textContent).toContain("画面の表示でエラーが起きました");
    expect(container.textContent).toContain("境界の外側");
  });

  const nonErrorThrows: Array<[label: string, thrown: unknown, detail: string]> = [
    ["文字列", "失敗", "失敗"],
    ["null", null, "(詳細なし)"],
    ["オブジェクト", { code: 1 }, '{"code":1}'],
  ];

  for (const [label, thrown, detail] of nonErrorThrows) {
    it(`非Errorのthrow（${label}）でもフォールバック見出しを描画する`, async () => {
      const { React, SkillErrorBoundary } = modules;
      const NonErrorChild = (): never => {
        throw thrown;
      };

      await React.act(async () => {
        root.render(
          React.createElement(SkillErrorBoundary, {
            mode: "storyboard",
            children: React.createElement(NonErrorChild),
          }),
        );
      });

      expect(container.querySelector("h2")?.textContent).toBe(
        "画面の表示でエラーが起きました",
      );
      expect(container.textContent).toContain(detail);
    });
  }

  it("スキルを閉じて戻ると作品モードへ復帰する", async () => {
    const { React, SkillErrorBoundary, useSkillMode, useSkillUiMode } = modules;
    let shouldThrow = true;
    const Child = () => {
      if (shouldThrow) throw new Error("描画失敗");
      return React.createElement("p", null, "復帰済み");
    };

    useSkillMode.getState().setSelectedSkillId("gori-storyboard");
    useSkillMode.getState().setEnabled(true);

    await React.act(async () => {
      root.render(
        React.createElement(SkillErrorBoundary, {
          mode: "storyboard",
          children: React.createElement(Child),
        }),
      );
    });

    shouldThrow = false;
    await React.act(async () => {
      buttonWithText("スキルを閉じて戻る").click();
    });

    expect(useSkillMode.getState().enabled).toBe(false);
    expect(useSkillUiMode.getState().activeUiMode).toBe("default");
  });

  it("この画面を再表示すると、throw しなくなった子を再描画する", async () => {
    const { React, SkillErrorBoundary } = modules;
    let shouldThrow = true;
    const Child = () => {
      if (shouldThrow) throw new Error("描画失敗");
      return React.createElement("p", null, "子の画面が戻りました");
    };

    await React.act(async () => {
      root.render(
        React.createElement(SkillErrorBoundary, {
          mode: "storyboard",
          children: React.createElement(Child),
        }),
      );
    });

    shouldThrow = false;
    await React.act(async () => {
      buttonWithText("この画面を再表示").click();
    });

    expect(container.textContent).toContain("子の画面が戻りました");
    expect(container.textContent).not.toContain("画面の表示でエラーが起きました");
  });

  it("スキル画面のエラーを1件記録する", async () => {
    const { React, SkillErrorBoundary, useErrorLog } = modules;

    await React.act(async () => {
      root.render(
        React.createElement(SkillErrorBoundary, {
          mode: "storyboard",
          children: React.createElement(throwingChild),
        }),
      );
    });

    const entries = useErrorLog.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("スキル画面");
  });
});
