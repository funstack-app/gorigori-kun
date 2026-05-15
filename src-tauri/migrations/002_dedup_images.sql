-- Dedup any pre-existing duplicate (turn_id, path) rows by keeping
-- only the lowest rowid of each group, then enforce uniqueness
-- going forward. Combined with `INSERT OR IGNORE` in image_record
-- this stops the watcher firing twice from accumulating phantom
-- gallery items.
DELETE FROM images
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM images GROUP BY turn_id, path
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_images_turn_path
  ON images(turn_id, path);
