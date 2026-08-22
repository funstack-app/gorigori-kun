import {
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
} from "../lib/tour";

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
  closeRef.current = onClose;

  useEffect(() => {
    const first = findAvailableStepIndex(tour.steps, 0, 1, resolveVisibleTarget);
    if (first === null) {
      closeRef.current();
      return;
    }
    setStepIndex(first);
  }, [tour]);

  const currentStep = stepIndex === null ? null : tour.steps[stepIndex];
  const currentTarget = useMemo(
    () => (currentStep ? resolveVisibleTarget(currentStep.target) : null),
    [currentStep],
  );

  useLayoutEffect(() => {
    if (stepIndex === null || !currentStep) return;
    const target = resolveVisibleTarget(currentStep.target);
    if (!target) {
      const next = findAvailableStepIndex(
        tour.steps,
        stepIndex + 1,
        1,
        resolveVisibleTarget,
      );
      if (next === null) closeRef.current();
      else setStepIndex(next);
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
  }, [currentStep, stepIndex, tour.steps]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!currentStep || !currentTarget || !rect || stepIndex === null) return null;

  const previousIndex = findAvailableStepIndex(
    tour.steps,
    stepIndex - 1,
    -1,
    resolveVisibleTarget,
  );
  const nextIndex = findAvailableStepIndex(
    tour.steps,
    stepIndex + 1,
    1,
    resolveVisibleTarget,
  );

  return (
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
            disabled={previousIndex === null}
            onClick={() => {
              if (previousIndex !== null) setStepIndex(previousIndex);
            }}
            className="h-8 rounded-md border border-[#343434] px-3 text-xs font-bold text-neutral-300 hover:border-[#555] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
          >
            戻る
          </button>
          <button
            type="button"
            onClick={() => {
              if (nextIndex === null) onClose();
              else setStepIndex(nextIndex);
            }}
            className="h-8 rounded-md bg-pink-500 px-4 text-xs font-bold text-white hover:bg-pink-400"
          >
            {nextIndex === null ? "終了" : "次へ"}
          </button>
        </div>
      </section>
    </div>
  );
}
