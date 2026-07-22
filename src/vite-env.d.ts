/// <reference types="vite/client" />

// onnxruntime-web の .wasm 公式exportを ?url 資産として取り込む(poseLifter.ts)
declare module "onnxruntime-web/ort-wasm-simd-threaded.wasm?url" {
  const url: string;
  export default url;
}
