-- turns に provider とモデル表示メタを追加する。
-- 既存の `model` カラムは Codex モデル名 (例: gpt-5) のため残す。
ALTER TABLE turns ADD COLUMN provider TEXT;
ALTER TABLE turns ADD COLUMN model_job_set_type TEXT;
ALTER TABLE turns ADD COLUMN model_display_name TEXT;
