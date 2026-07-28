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

| プラットフォーム | 状態 | ダウンロードするファイル |
|---|---|---|
| macOS Apple Silicon (M1〜M4) | ✅ 公式サポート | `..._aarch64.dmg` |
| macOS Intel | ✅ 公式サポート | `..._x64.dmg` |
| Windows 10 / 11 (64bit) | ✅ 公式サポート | `..._x64-setup.exe` |
| Linux | ❌ 未対応 | — |

macOS は **12 (Monterey) 以降**が必要です。

お使いの Mac がどちらか分からない場合: 画面左上の アップルマーク → 「このMacについて」 →
「チップ」に **Apple M1 / M2 / M3 / M4** と書いてあれば Apple Silicon、
**Intel Core** と書いてあれば Intel です。

> **Intel Mac について**
> v2.0.0〜v2.2.x では、編集タブの画像解析機能が使っている AI 実行エンジン (ONNX Runtime)
> が Intel Mac 向けの提供を終了したため、Intel Mac 版を配布していませんでした。
> v2.3.0 でこのエンジンを **Windows 版専用**に切り離したことで、Intel Mac 版の配布を
> 再開しました。画像生成・絵コンテ・背景透過など主要機能はすべて使えます。
> 編集タブの一部機能 (領域選択・文字認識・ことばで分離) は現在 Windows 版のみです。

**必要なもの:**

- ChatGPT Plus / Pro / Team / Enterprise いずれかのサブスクリプション
- (Higgsfield 連携を使う場合) Higgsfield アカウント

---

## インストール

上の表を見て、お使いの環境に合ったファイルをダウンロードしてください。

Codex CLI や Node.js の手動インストールは不要です (アプリに同梱済み)。

### 初回起動だけ、OS の確認画面が出ます

このアプリは開発元の登録をしていないため、**初回だけ** OS が「知らないアプリだよ」と
確認してきます。**故障ではありません。** 下の手順で開けば、2回目以降は普通に起動します。

<details open>
<summary><b>Mac の場合</b></summary>

**macOS 15 (Sequoia) 以降**

1. アプリをダブルクリックする（「開けません」と出ます。ここで一度閉じてOK）
2. アップルマーク → **システム設定** → **プライバシーとセキュリティ**
3. 下にスクロールすると「"GORI GORI" は開発元を確認できないため…」という行があります
4. その横の **「このまま開く」** を押す
5. もう一度パスワードを入れると起動します

**macOS 12〜14**

1. アプリを **右クリック**（または control + クリック）
2. メニューから **「開く」** を選ぶ
3. 確認ダイアログでもう一度 **「開く」** を押す

> ダブルクリックだと開けません。**右クリックから開く**のがポイントです。

</details>

<details open>
<summary><b>Windows の場合</b></summary>

1. `..._x64-setup.exe` をダブルクリック
2. 「WindowsによってPCが保護されました」と青い画面が出ます
3. **「詳細情報」** を押す（小さい文字のリンクです）
4. 下に出てくる **「実行」** を押す
5. あとはインストーラの指示どおり進めてください

管理者権限は不要です。あなたのユーザーフォルダにインストールされます。

</details>

### 起動したら

画面の指示に従って ChatGPT でログインしてください。認証はアプリ内で完結します。

### アップデート

アプリ内の **設定 → 基本 → アップデート** から「更新を確認」を押すと、
最新版があればその場でダウンロード・再起動まで行います。手動で入れ直す必要はありません。

うまくいかないときは、同じ画面に出る **「最新版をダウンロード」** から
[リリースページ](https://github.com/funstack-app/gorigori-kun/releases/latest)を開いて、
上の表のファイルを入れ直してください。作品データ・プリセット・設定は引き継がれます。

---

## ライセンス

[MIT](LICENSE) — STΛCK によるクリエイティブ向け改変版。

オリジナルフレームワークの著作権者にもリスペクトを込めて MIT License を継承しています。詳細は [LICENSE](LICENSE) を参照してください。

同梱している第三者ソフトウェアのライセンス表示は `src-tauri/resources/THIRD-PARTY-NOTICES.txt` にまとめています。

---

## 謝辞

本アプリは masao 氏の codex-image-editor (MIT License) を元に開発されました。

素晴らしいフレームワークを公開してくださった masao 氏に感謝します。
