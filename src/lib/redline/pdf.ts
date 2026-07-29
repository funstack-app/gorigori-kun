/**
 * 赤入れスキルの PDF 入力サポート。
 *
 * クライアントの赤入れは PDF で届くことが多い。ここで PDF を PNG へ正規化し、
 * 以降のパイプライン（store.interpret / prompts / 編集タブ受け渡し）は
 * 従来どおり「画像パス」しか見ないようにする（合流点を既存のまま保つ）。
 *
 * 方式の決定（配布ゲート適合）:
 *   pdfjs-dist（Mozilla pdf.js）を WebView 内で実行する。外部バイナリ
 *   （pdfium / poppler / ImageMagick）や Rust 側 PDF クレートは
 *   ネイティブライブラリ同梱が必要になり配布ブロッカーへ直結するため採らない。
 *   Worker は Vite の `?url` インポートでバンドルへ同梱する。CDN 参照は禁止
 *   （オフライン配布アプリのため）。
 */

import * as pdfjs from "pdfjs-dist";
// Worker はバンドル同梱。CDN を参照しない（配布時にオフラインで動かなくなるため）。
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 本レンダリングの解像度（長辺 px）。手書き文字の判読性と localImage ペイロードの均衡点。 */
const RENDER_MAX_EDGE = 2048;
/** ページ選択モーダルのサムネイル解像度（長辺 px）。 */
const THUMBNAIL_MAX_EDGE = 240;

/** 拡張子・MIME から PDF かどうかを判定する。 */
export function isPdfFile(file: File): boolean {
  if (file.type === "application/pdf") return true;
  return file.name.toLowerCase().endsWith(".pdf");
}

/** 1 ページを指定の長辺に収める scale で canvas へ描き、PNG bytes にする。 */
async function renderPageToPngBytes(
  page: pdfjs.PDFPageProxy,
  maxEdge: number,
): Promise<Uint8Array> {
  const base = page.getViewport({ scale: 1 });
  const scale = maxEdge / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d context を取得できませんでした");

  await page.render({ canvas, canvasContext: context, viewport }).promise;

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("PNG への変換に失敗しました");
  return new Uint8Array(await blob.arrayBuffer());
}

/** 読み込み済み PDF のハンドル。使い終わったら destroy() を呼ぶ。 */
export type LoadedPdf = {
  pageCount: number;
  /** 指定ページ（1 始まり）を本解像度で PNG bytes にする。 */
  renderPage: (pageNumber: number) => Promise<Uint8Array>;
  /** 指定ページ（1 始まり）をサムネイル解像度で PNG bytes にする。 */
  renderThumbnail: (pageNumber: number) => Promise<Uint8Array>;
  /** 内部リソースを解放する。 */
  destroy: () => Promise<void>;
};

/**
 * PDF バイト列を読み込む。
 * 暗号化・破損で開けない場合は例外を投げる（呼び出し側でトースト表示。推測でリカバリしない）。
 */
export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  // pdf.js は渡した ArrayBuffer を transfer するため、コピーを渡して呼び出し側の
  // bytes が detach されないようにする。
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;

  const renderAt = async (pageNumber: number, maxEdge: number) => {
    const page = await doc.getPage(pageNumber);
    try {
      return await renderPageToPngBytes(page, maxEdge);
    } finally {
      page.cleanup();
    }
  };

  return {
    pageCount: doc.numPages,
    renderPage: (pageNumber) => renderAt(pageNumber, RENDER_MAX_EDGE),
    renderThumbnail: (pageNumber) => renderAt(pageNumber, THUMBNAIL_MAX_EDGE),
    destroy: () => doc.destroy(),
  };
}

/**
 * PDF の 1 ページだけを本解像度で PNG 化する簡易版（1 ページ PDF や選択確定後に使う）。
 */
export async function renderPdfPageToPng(
  bytes: Uint8Array,
  pageNumber: number,
): Promise<Uint8Array> {
  const pdf = await loadPdf(bytes);
  try {
    return await pdf.renderPage(pageNumber);
  } finally {
    await pdf.destroy();
  }
}
