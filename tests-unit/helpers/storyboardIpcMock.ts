/**
 * storyboardRun 用の invoke モック (mm2 2026-08-03)。
 *
 * 目的は 1 つだけ: **待機キューが発射されたかどうか**を観測すること。
 * 発射は `startProductionForCuts` → `storyboard.run(params)` →
 * `invoke("storyboard_run")` に落ちるので、この cmd の呼び出しログを取る。
 *
 * backend の挙動 (実際に生成が走るか) は再現しない。フロントの判定ロジック
 * だけを対象にする。未知の cmd (plugin:store|… 等) には undefined を返す —
 * storyboardLastRun は loadStore 失敗を catch して null を返す best-effort
 * 実装なので、これで落ちない。
 */
import { mockIPC } from "@tauri-apps/api/mocks";

export type IpcCall = { cmd: string; args: unknown };

export type StoryboardIpcMock = {
  /** 全 invoke 呼び出しの時系列。 */
  log: IpcCall[];
  /** 特定 cmd の呼び出しだけ取り出す。 */
  calls: (cmd: string) => IpcCall[];
};

export function installStoryboardIpcMock(): StoryboardIpcMock {
  const log: IpcCall[] = [];

  mockIPC(async (cmd, args) => {
    log.push({ cmd, args });
    if (cmd === "storyboard_run") {
      // run id 相当の文字列を返す (storyboard.run は invoke<string>)。
      return "ok";
    }
    return undefined;
  });

  return {
    log,
    calls: (cmd: string) => log.filter((c) => c.cmd === cmd),
  };
}
