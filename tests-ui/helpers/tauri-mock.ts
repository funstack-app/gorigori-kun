import type { Page } from "@playwright/test";

/**
 * Inject a stub for `window.__TAURI_INTERNALS__` before the Vite bundle
 * loads. Tests can install a per-test invoke handler synchronously by
 * calling `installHandler(page, "INITIAL_HANDLER_FN")` *before*
 * `page.goto("/")` so React's bootstrap effects see the real responses
 * on the first invoke.
 *
 * Tests can also dispatch events at runtime via
 *   `page.evaluate(() => (window as any).__TEST_TAURI__.emit(name, payload))`
 */
export type InvokeHandler = (cmd: string, args: unknown) => unknown | Promise<unknown>;

export async function injectTauriMock(page: Page) {
  await page.addInitScript(() => {
    type Listener = (payload: any) => void;
    const listeners = new Map<string, Set<Listener>>();
    const cbMap = new Map<number, (envelope: any) => void>();

    const dispatch = async (cmd: string, args: any): Promise<unknown> => {
      // Tauri 2 event plugin commands — handled inside the mock so tests
      // don't have to repeat them.
      if (cmd === "plugin:event|listen") {
        const ev = args.event as string;
        const handlerId = args.handler as number;
        const listener: Listener = (payload) => {
          const cb = cbMap.get(handlerId);
          cb?.({ event: ev, id: handlerId, payload });
        };
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(listener);
        return handlerId;
      }
      if (cmd === "plugin:event|unlisten") {
        return null;
      }

      // Fallback: defer to whatever the test installed.
      const handler =
        (window as any).__INVOKE_HANDLER__ ??
        ((c: string) => {
          console.warn("[tauri-mock] unhandled invoke:", c);
          return null;
        });
      return await handler(cmd, args);
    };

    const internals = {
      invoke: dispatch,
      transformCallback: (cb: any, _once: boolean) => {
        const id = Math.floor(Math.random() * 0x7fffffff);
        cbMap.set(id, cb);
        return id;
      },
      // convertFileSrc passes through data: / http: URLs so screenshots can
      // render the placeholder images we feed in.
      convertFileSrc: (filePath: string, _protocol = "asset") => {
        if (filePath.startsWith("data:") || filePath.startsWith("http")) {
          return filePath;
        }
        return `asset://localhost/${encodeURIComponent(filePath)}`;
      },
      // Tauri's listen() returns an unlisten that calls
      // __TAURI_INTERNALS__.unregisterListener — keep it a no-op so the
      // teardown path doesn't crash.
      unregisterListener: () => {},
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      plugins: {},
    };
    (window as any).__TAURI_INTERNALS__ = internals;

    (window as any).__TEST_TAURI__ = {
      setInvokeHandler(handler: InvokeHandler) {
        (window as any).__INVOKE_HANDLER__ = handler;
      },
      emit(event: string, payload: unknown) {
        const set = listeners.get(event);
        if (!set) return 0;
        for (const l of set) l(payload);
        return set.size;
      },
      countListeners(event: string) {
        return listeners.get(event)?.size ?? 0;
      },
    };
  });
}

/**
 * Install an invoke handler that's active before the React bundle runs.
 * `handlerSource` is a function literal serialized with Function.prototype
 * .toString — it is evaluated in the page context, so it must not capture
 * test-side variables.
 */
export async function installHandler(
  page: Page,
  handlerSource: string,
): Promise<void> {
  await page.addInitScript({
    content: `(() => {
      window.__INVOKE_HANDLER__ = ${handlerSource};
    })();`,
  });
}
