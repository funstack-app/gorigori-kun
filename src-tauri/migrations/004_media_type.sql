-- images に動画対応カラムを追加する (P0-3, 2026-05-28 動画タブ準備)。
-- 既存の kind カラム ("initial" | "created") とは別に、メディア種別を持つ。
-- 既存行は media_type = 'image' として扱う。
ALTER TABLE images ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE images ADD COLUMN duration_seconds INTEGER;
ALTER TABLE images ADD COLUMN thumbnail_path TEXT;
