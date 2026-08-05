#!/usr/bin/env python3
"""同梱 codex CLI が、アプリの既定モデルを実行できるかを検査する。

## なぜこの検査が必要か（2026-07-26 の実害）

2026-07-17 に MODEL_WHITELIST を 5.6 世代へ更新したとき、配布版に同梱する
codex CLI（CI の codexVer）の更新を忘れた。その結果:

    400 invalid_request_error
    "The 'gpt-5.6-sol' model requires a newer version of Codex."

で画像生成が 100% 失敗する状態を v2.0.0 / v2.1.0 として出荷した。
発覚はユーザー報告まで9日かかった。

見つからなかった理由は3つとも「気をつける」では防げないもの:

  1. 開発環境は PATH の新しい CLI を拾うので、手元では一度も再現しない
     （壊れるのは配布版だけ = dev で気づけない構造）
  2. 選択モデルは端末に保存されるので、既存ユーザーは動き続ける
     （「動く人と動かない人がいる」という切り分けにくい形で出る）
  3. 整合を取るべき2つの値が別ファイル（src/lib/store/threads.ts と
     .github/workflows/release.yml）にあり、片方だけ直しても何も起きない

だからコードで検査する。この検査は release-checklist から呼ばれ、
不整合があればリリースを止める。

## 何を検査するか

  A. フロントの MODEL_MIN_CLI（モデル→必要CLI版）を読む
  B. MODEL_WHITELIST の先頭（= アプリの既定モデル）を読む
  C. CI の codexVer（= 同梱するCLI版）を読む
  D. C >= (B が要求する版) か。満たさなければ FAIL

さらに:
  E. macOS 側と Windows 側の codexVer が一致しているか
     （片方だけ更新する事故を防ぐ。今回も2箇所あった）
  F. MODEL_WHITELIST の全モデルが MODEL_MIN_CLI に載っているか
     （表に書き忘れたモデルは判定をすり抜けるため）
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THREADS_TS = ROOT / "src/lib/store/threads.ts"
RELEASE_YML = ROOT / ".github/workflows/release.yml"


def fail(msg: str) -> None:
    print(f"❌ {msg}")


def ok(msg: str) -> None:
    print(f"✅ {msg}")


def parse_version(raw: str) -> list[int]:
    """"rust-v0.145.0" / "0.146.0-alpha.3.1" → [0, 145, 0]（接尾は無視）。"""
    core = raw.strip().removeprefix("rust-").removeprefix("v").split("-")[0]
    return [int(p) if p.isdigit() else 0 for p in core.split(".")]


def version_at_least(actual: str, required: str) -> bool:
    a, b = parse_version(actual), parse_version(required)
    for i in range(max(len(a), len(b))):
        av = a[i] if i < len(a) else 0
        bv = b[i] if i < len(b) else 0
        if av != bv:
            return av > bv
    return True


def read_whitelist(src: str) -> list[str]:
    m = re.search(r"const MODEL_WHITELIST\s*=\s*\[(.*?)\]", src, re.S)
    if not m:
        return []
    return re.findall(r'"([^"]+)"', m.group(1))


def read_min_cli(src: str) -> dict[str, str]:
    m = re.search(r"const MODEL_MIN_CLI[^=]*=\s*\{(.*?)\n\}", src, re.S)
    if not m:
        return {}
    return dict(re.findall(r'"([^"]+)"\s*:\s*"([^"]+)"', m.group(1)))


def read_codex_versions(src: str) -> list[str]:
    """CI 内の codexVer 代入をすべて拾う（macOS/Windows の2箇所）。"""
    return re.findall(r'codexVer\s*=\s*"([^"]+)"', src)


def read_codex_auth_versions(src: str) -> list[str]:
    """CI 内の codexAuthVer 代入をすべて拾う（macos/windows/windows-compat の3箇所）。

    codexAuthVer は MCP 認可専用の補助バイナリ（codex-auth）の版。日常実行の
    codexVer とは別物で、3ジョブのうち1つだけ版がズレる/追記漏れするのを防ぐ。
    変数名が "codexVer" を部分文字列として含まないのは意図的（含めると
    read_codex_versions が誤検出して検査 E が偽陽性で落ちる）。
    """
    return re.findall(r'codexAuthVer\s*=\s*"([^"]+)"', src)


def main() -> int:
    problems = 0

    if not THREADS_TS.is_file() or not RELEASE_YML.is_file():
        fail("threads.ts / release.yml が見つかりません（パス構成が変わった?）")
        return 1

    ts = THREADS_TS.read_text(encoding="utf-8")
    yml = RELEASE_YML.read_text(encoding="utf-8")

    whitelist = read_whitelist(ts)
    min_cli = read_min_cli(ts)
    codex_vers = read_codex_versions(yml)

    # 読み取り自体に失敗したら「合格」にしてはいけない。
    # 検査が空振りしているのに ✅ を出すのが一番危ない（今回の grep 誤検知と同型）。
    if not whitelist:
        fail("MODEL_WHITELIST を読み取れません")
        problems += 1
    if not min_cli:
        fail("MODEL_MIN_CLI を読み取れません")
        problems += 1
    if not codex_vers:
        fail("release.yml の codexVer を読み取れません")
        problems += 1
    if problems:
        return 1

    # E. macOS / Windows で同梱版が揃っているか
    uniq = sorted(set(codex_vers))
    if len(uniq) != 1:
        fail(f"同梱 codex CLI の版が platform 間で不一致: {', '.join(uniq)}")
        print("   → macOS 側と Windows 側の codexVer を同じ値にしてください")
        problems += 1
    else:
        ok(f"同梱 codex CLI: {uniq[0]}（{len(codex_vers)}箇所すべて一致）")

    bundled = uniq[0]

    # G. MCP 認可用の補助バイナリ（codex-auth）の版が3ジョブで揃っているか。
    #    0件は「0.147.0 安定版に一本化して撤去済み」の正常状態なので合格にする
    #    （撤去後にこの検査が偽陽性で落ちてはならない）。
    auth_vers = read_codex_auth_versions(yml)
    if not auth_vers:
        ok("MCP 認可用 codex-auth: 未同梱（0.147 一本化済みとみなす）")
    elif len(set(auth_vers)) != 1:
        fail(f"codex-auth の版がジョブ間で不一致: {', '.join(sorted(set(auth_vers)))}")
        print("   → macos / windows / windows-compat の codexAuthVer を同じ値にしてください")
        problems += 1
    elif len(auth_vers) != 3:
        fail(f"codexAuthVer の記載が {len(auth_vers)} 箇所です（macos / windows / windows-compat の3箇所必要）")
        print("   → 追記漏れのジョブでは認可が古い CLI で走り、Magnific 接続が失敗します")
        problems += 1
    else:
        ok(f"MCP 認可用 codex-auth: {auth_vers[0]}（3箇所すべて一致）")

    # F. ホワイトリストの全モデルが表に載っているか
    missing = [m for m in whitelist if m not in min_cli]
    if missing:
        fail(f"MODEL_MIN_CLI に必要CLI版が未記載: {', '.join(missing)}")
        print("   → モデルを足したら MODEL_MIN_CLI にも必要CLI版を書いてください")
        print("     (未記載は判定をすり抜け、古いCLIで 400 になります)")
        problems += 1
    else:
        ok(f"MODEL_MIN_CLI: whitelist {len(whitelist)}件すべて記載済み")

    # D. 既定モデル（whitelist 先頭）を同梱CLIで実行できるか ← 今回の事故の本体
    default_model = whitelist[0]
    required = min_cli.get(default_model)
    if required is None:
        fail(f"既定モデル {default_model} の必要CLI版が不明")
        problems += 1
    elif not version_at_least(bundled, required):
        fail(
            f"既定モデル {default_model} は CLI {required} 以上を要求しますが、"
            f"同梱は {bundled} です"
        )
        print("   → このまま配布すると、新規ユーザーの画像生成が 400 で全件失敗します")
        print(f"   → release.yml の codexVer を {required} 以上に上げてください")
        problems += 1
    else:
        ok(f"既定モデル {default_model} は同梱CLI {bundled} で実行可能（要 {required} 以上）")

    # 参考表示: 同梱CLIで使えないモデルがあれば知らせる（FAIL にはしない）。
    # 意図的に「新しいCLIを入れた人だけ使える」枠を作ることはありうるため。
    unusable = [
        m for m in whitelist
        if m in min_cli and not version_at_least(bundled, min_cli[m])
    ]
    if unusable:
        print(
            f"ℹ️  同梱CLIでは使えないモデル（ピッカーから自動で外れます）: "
            f"{', '.join(unusable)}"
        )

    if problems:
        print(f"\n❌ {problems} 件の問題: 修正してください")
        return 1
    print("\n🎉 モデルと同梱CLIの整合OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
