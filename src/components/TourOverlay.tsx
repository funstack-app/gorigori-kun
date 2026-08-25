import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  findAvailableStepIndex,
  type TourDefinition,
  type TourPlacement,
  type TourStep,
} from "../lib/tour";
import { useWorkspace } from "../lib/store/workspace";
import { ModalPortal } from "./ModalPortal";

type HighlightRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

function resolveVisibleTarget(selector: string): HTMLElement | null {
  try {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
    return (
      candidates.find((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      }) ?? null
    );
  } catch {
    return null;
  }
}

function runBeforeStepAction(step: TourStep): void {
  if (step.beforeAction?.type === "settings-tab") {
    useWorkspace.getState().requestSettingsTab(step.beforeAction.tab);
  }
}

function measureTarget(target: HTMLElement): HighlightRect {
  const rect = target.getBoundingClientRect();
  const padding = 8;
  const top = Math.max(8, rect.top - padding);
  const left = Math.max(8, rect.left - padding);
  const right = Math.min(window.innerWidth - 8, rect.right + padding);
  const bottom = Math.min(window.innerHeight - 8, rect.bottom + padding);
  return {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function popoverStyle(rect: HighlightRect, placement: TourPlacement): CSSProperties {
  const gap = 16;
  const margin = 16;
  const width = Math.min(340, window.innerWidth - margin * 2);
  const estimatedHeight = 230;
  const fitsBelow = window.innerHeight - (rect.top + rect.height) >= estimatedHeight + gap;
  const fitsAbove = rect.top >= estimatedHeight + gap;
  const fitsRight = window.innerWidth - (rect.left + rect.width) >= width + gap;
  const fitsLeft = rect.left >= width + gap;
  const resolved =
    placement === "auto"
      ? fitsBelow
        ? "bottom"
        : fitsRight
          ? "right"
          : fitsAbove
            ? "top"
            : "left"
      : placement === "bottom" && !fitsBelow && fitsAbove
        ? "top"
        : placement === "top" && !fitsAbove && fitsBelow
          ? "bottom"
          : placement === "right" && !fitsRight && fitsLeft
            ? "left"
            : placement === "left" && !fitsLeft && fitsRight
              ? "right"
              : placement;

  let top = rect.top + rect.height + gap;
  let left = rect.left;
  if (resolved === "top") top = rect.top - estimatedHeight - gap;
  if (resolved === "right") {
    top = rect.top;
    left = rect.left + rect.width + gap;
  }
  if (resolved === "left") {
    top = rect.top;
    left = rect.left - width - gap;
  }

  return {
    top: Math.max(margin, Math.min(top, window.innerHeight - estimatedHeight - margin)),
    left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
    width,
  };
}

export function TourOverlay({
  tour,
  onClose,
}: {
  tour: TourDefinition;
  onClose: () => void;
}) {
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [rect, setRect] = useState<HighlightRect | null>(null);
  const closeRef = useRef(onClose);
  const navigationRunRef = useRef(0);
  const pendingFrameRef = useRef<number | null>(null);
  closeRef.current = onClose;

  const activateStep = useCallback((startIndex: number, direction: 1 | -1) => {
    const runId = navigationRunRef.current + 1;
    navigationRunRef.current = runId;
    if (pendingFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
    setRect(null);

    const tryCandidate = (candidateIndex: number) => {
      if (navigationRunRef.current !== runId) return;
      if (candidateIndex < 0 || candidateIndex >= tour.steps.length) {
        closeRef.current();
        return;
      }

      const candidate = tour.steps[candidateIndex];
      runBeforeStepAction(candidate);
      const resolveCandidate = () => {
        if (navigationRunRef.current !== runId) return;
        const available = findAvailableStepIndex(
          [candidate],
          0,
          1,
          resolveVisibleTarget,
        );
        if (available === 0) {
          pendingFrameRef.current = null;
          setStepIndex(candidateIndex);
          return;
        }
        tryCandidate(candidateIndex + direction);
      };

      if (!candidate.beforeAction) {
        resolveCandidate();
        return;
      }
      // タブ要求が React の画面へ反映されてから、切替後の対象を探す。
      pendingFrameRef.current = window.requestAnimationFrame(() => {
        pendingFrameRef.current = window.requestAnimationFrame(resolveCandidate);
      });
    };

    tryCandidate(startIndex);
  }, [tour.steps]);

  useEffect(() => {
    activateStep(0, 1);
    return () => {
      navigationRunRef.current += 1;
      if (pendingFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
    };
  }, [activateStep]);

  const currentStep = stepIndex === null ? null : tour.steps[stepIndex];
  const currentTarget = useMemo(
    () => (currentStep ? resolveVisibleTarget(currentStep.target) : null),
    [currentStep],
  );

  useLayoutEffect(() => {
    if (stepIndex === null || !currentStep) return;
    const target = resolveVisibleTarget(currentStep.target);
    if (!target) {
      activateStep(stepIndex + 1, 1);
      return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    const update = () => setRect(measureTarget(target));
    update();
    const frame = window.requestAnimationFrame(update);
    const delayed = window.setTimeout(update, 220);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(delayed);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [activateStep, currentStep, stepIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!currentStep || !currentTarget || !rect || stepIndex === null) return null;

  const hasPreviousStep = stepIndex > 0;
  const hasNextStep = stepIndex < tour.steps.length - 1;

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-[200]" role="presentation">
      <div
        className="pointer-events-none fixed rounded-xl border-2 border-pink-400"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.72)",
          transition:
            "top 180ms ease, left 180ms ease, width 180ms ease, height 180ms ease",
        }}
        aria-hidden
      />

      <section
        className="fixed rounded-xl border border-[#3a3a3a] bg-[#181818] p-4 text-neutral-100 shadow-2xl"
        style={{
          ...popoverStyle(rect, currentStep.placement),
          transition: "top 180ms ease, left 180ms ease",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold tracking-wide text-pink-300">
              {stepIndex + 1} / {tour.steps.length}
            </p>
            <h2 id="tour-step-title" className="mt-1 text-sm font-black text-white">
              {currentStep.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[11px] font-bold text-neutral-500 hover:bg-[#242424] hover:text-white"
          >
            スキップ
          </button>
        </div>
        <p className="mt-2 text-xs leading-6 text-neutral-300">{currentStep.body}</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={!hasPreviousStep}
            onClick={() => {
              if (hasPreviousStep) activateStep(stepIndex - 1, -1);
            }}
            className="h-8 rounded-md border border-[#343434] px-3 text-xs font-bold text-neutral-300 hover:border-[#555] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
          >
            戻る
          </button>
          <button
            type="button"
            onClick={() => {
              if (!hasNextStep) onClose();
              else activateStep(stepIndex + 1, 1);
            }}
            className="h-8 rounded-md bg-pink-500 px-4 text-xs font-bold text-white hover:bg-pink-400"
          >
            {hasNextStep ? "次へ" : "終了"}
          </button>
        </div>
      </section>
    </div>
    </ModalPortal>
  );
}
