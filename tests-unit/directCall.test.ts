import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { friendlyRemoteMcpError } from "../src/lib/store/remoteMcpGen";

describe("直接呼び生成の画面契約", () => {
  it("サービスの error.message だけを短く表示し、生JSONを出さない", () => {
    const message = friendlyRemoteMcpError(
      new Error(
        JSON.stringify({
          status: "failed",
          error: {
            message: "Quota exhausted",
            schema: { properties: { prompt: { type: "string" } } },
          },
        }),
      ),
    );

    expect(message).toBe("Quota exhausted");
    expect(message).not.toContain("schema");
    expect(message).not.toContain("{");
    expect(message.length).toBeLessThanOrEqual(320);
  });

  it("スキーマしかない失敗は生JSONを捨てる", () => {
    const message = friendlyRemoteMcpError(
      'Invalid params: {"schema":{"properties":{"prompt":{"type":"string"}}}}',
    );

    expect(message).toBe("Invalid params:");
    expect(message).not.toContain("schema");
    expect(message).not.toContain("{");
  });

  it("error.message 内に残った schema も再度取り除く", () => {
    const message = friendlyRemoteMcpError(
      JSON.stringify({
        status: "failed",
        error: { message: "Invalid params: {schema: {prompt: string}}" },
      }),
    );

    expect(message).toBe("Invalid params:");
    expect(message).not.toContain("schema");
  });

  it("従来経路の長文はJSONより前の先頭120文字だけに丸める", () => {
    const message = friendlyRemoteMcpError(
      `生成に失敗しました: ${"長いAI報告 ".repeat(40)}[schema detail]`,
      120,
    );

    expect(Array.from(message).length).toBeLessThanOrEqual(120);
    expect(message).not.toContain("schema");
    expect(message).not.toContain("[");
  });

  it("error.message が無い場合は status だけを表示する", () => {
    expect(
      friendlyRemoteMcpError('{"status":"cancelled","schema":{"type":"object"}}'),
    ).toBe("cancelled");
  });

  it("動画の尺・比率・解像度は各チップ直上の小プルダウンで選ぶ", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/VideoConstructedPromptPanel.tsx"),
      "utf8",
    );

    expect(source).toContain("data-video-setting-popover");
    expect(source).toContain("absolute bottom-full");
    expect(source).toContain('label="尺"');
    expect(source).toContain('label="比率"');
    expect(source).toContain('label="解像度"');
    expect(source).not.toContain("VideoSettingsModal");
    expect(source).not.toContain("動画の設定");
  });

  it("画像・動画とも生成ボタン下の長文エラー表示を持たない", () => {
    const imagePanel = readFileSync(
      resolve(process.cwd(), "src/components/ConstructedPromptPanel.tsx"),
      "utf8",
    );
    const videoPanel = readFileSync(
      resolve(process.cwd(), "src/components/VideoConstructedPromptPanel.tsx"),
      "utf8",
    );

    expect(imagePanel).not.toContain("latestRemoteJob?.phase === \"error\"");
    expect(imagePanel).not.toContain("status.message");
    expect(videoPanel).not.toContain("data-remote-job-count");
    expect(videoPanel).not.toContain("status.message");
  });
});
