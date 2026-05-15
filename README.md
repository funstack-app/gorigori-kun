<div align="center">

# GORI GORI KUN

**ChatGPT サブスクで動くクリエイター向けの画像・ストーリーカット生成デスクトップアプリ**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform: macOS / Windows](https://img.shields.io/badge/Platform-macOS%20%2F%20Windows-lightgrey)](#動作要件)
[![Tauri 2](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)

</div>

---

## 概要

GORI GORI KUN は、ChatGPT サブスクリプション (Plus 以上) と OpenAI Codex CLI を使って、ターミナル無しで画像生成・ストーリーカット生成を行うデスクトップアプリです。

**主な機能:**

- ✏️ 企画タブで AI と対話しながら画像生成プロンプトを詰める
- 🎬 連続カット生成スキル (ストーリーカット) でキャラ一貫性のある動画用カットを量産
- 🖼 生成タイムラインで採用・参照・編集の流れを一画面で管理
- ⚡ Higgsfield 等の外部 AI 生成サービス連携 (BYO)
- 💾 ローカル保存 + クラウドストレージ (Supabase BYO) で容量管理

---

## 動作要件

| プラットフォーム | 状態 |
|---|---|
| macOS (Apple Silicon) | ✅ 公式サポート |
| Windows (x86_64) | ✅ 公式サポート |
| Linux | ❌ 未対応 |

**必要なもの:**

- ChatGPT Plus / Pro / Team / Enterprise いずれかのサブスクリプション
- (Higgsfield 連携を使う場合) Higgsfield アカウント

---

## インストール

配布版 (DMG / EXE) をダウンロード → 起動 → 画面の指示に従って ChatGPT でログインしてください。

初回起動時の認証フローは画面の指示通り進めるだけで完了します。Codex CLI や Node.js の手動インストールは不要です (アプリにバンドル済み)。

---

## ライセンス

[MIT](LICENSE) — STΛCK によるクリエイティブ向け改変版。

オリジナルフレームワークの著作権者にもリスペクトを込めて MIT License を継承しています。詳細は [LICENSE](LICENSE) を参照してください。
