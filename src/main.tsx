import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initFontScale } from "./lib/store/fontScale";

// 文字サイズ倍率を最初のペイント前に適用する。
// React のマウントを待つと一瞬だけ既定サイズで描画され、画面全体がちらつく。
initFontScale();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
