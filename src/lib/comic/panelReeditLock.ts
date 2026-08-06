import { useCallback, useMemo, useRef, useState } from "react";
import type * as React from "react";

export type PanelReeditLockHandle = {
  page: number;
  token: number;
  release(): void;
};

/**
 * 漫画の1コマ再編集を1本だけに制限するロック。
 * token の更新と解除をここへ集め、古い処理が新しいロックを解除しないようにする。
 */
export function usePanelReeditLock(): {
  /** 取得。すでに保持中なら null（呼び出し側は理由をトーストする）。 */
  acquire(page: number): PanelReeditLockHandle | null;
  /** 飛行中 run の採用判定に使う（stillMine の代替）。 */
  isCurrent(handle: PanelReeditLockHandle): boolean;
  /** 保持中か（入口ガード用）。 */
  held: boolean;
  /** 同期判定用ミラー。 */
  heldRef: React.RefObject<boolean>;
  /** state。ロックから導出（別変数を持たない）。 */
  runningPage: number | null;
  /** 外部からの強制無効化（構成やり直し・アンマウント・directRun onCancel）。 */
  invalidateAll(): void;
} {
  const lockRef = useRef<{ token: number; page: number | null }>({
    token: 0,
    page: null,
  });
  const [runningPage, setRunningPage] = useState<number | null>(null);
  const heldRef = useMemo<React.RefObject<boolean>>(
    () => ({
      get current() {
        return lockRef.current.page !== null;
      },
    }),
    [],
  );

  const acquire = useCallback((page: number): PanelReeditLockHandle | null => {
    if (lockRef.current.page !== null) return null;

    const token = lockRef.current.token + 1;
    lockRef.current = { token, page };
    setRunningPage(page);

    let released = false;
    return {
      page,
      token,
      release() {
        if (released) return;
        released = true;

        const current = lockRef.current;
        if (current.token !== token || current.page !== page) return;
        lockRef.current = { token: current.token, page: null };
        setRunningPage(null);
      },
    };
  }, []);

  const isCurrent = useCallback(
    (handle: PanelReeditLockHandle): boolean =>
      lockRef.current.token === handle.token && lockRef.current.page === handle.page,
    [],
  );

  const invalidateAll = useCallback(() => {
    lockRef.current = {
      token: lockRef.current.token + 1,
      page: null,
    };
    setRunningPage(null);
  }, []);

  return {
    acquire,
    isCurrent,
    held: runningPage !== null,
    heldRef,
    runningPage,
    invalidateAll,
  };
}
