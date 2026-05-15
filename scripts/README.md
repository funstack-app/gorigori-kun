# Scene Thumbnail Scripts

Generate cinematic 16:9 thumbnails for the scene-building picker.

The prompt catalog lives in `scene-thumbnails-prompts.json`. The generator reads that catalog, starts up to four independent `codex exec` workers, and copies each generated PNG into:

```text
public/scene-thumbnails/<CATEGORY>/<SLUG>.png
```

## Dry Run

```bash
scripts/generate-scene-thumbnails.sh --dry-run --category composition
scripts/generate-scene-thumbnails.sh --dry-run --all
```

## Generate

```bash
scripts/generate-scene-thumbnails.sh --category composition
scripts/generate-scene-thumbnails.sh --all
```

Each worker uses a temporary `CODEX_HOME`. It symlinks the existing Codex settings and auth files, but gives the worker its own `generated_images` directory. After `codex exec` finishes, the script finds the newest PNG in that worker directory and copies it to the public thumbnail path.

Failed jobs are logged to a temporary failure log and do not stop the remaining jobs. Set `KEEP_FAILED_WORKERS=1` to keep per-worker stdout and stderr logs for debugging.

## Cost Estimate

The catalog contains 55 thumbnails. At medium quality, the planning estimate is:

```text
55 * $0.053 = $2.915
```

Generation is expected to be run manually after review because `codex exec` may require a logged-in Codex account.
