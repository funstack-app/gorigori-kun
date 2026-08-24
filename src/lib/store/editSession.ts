export type EditVersion = {
  path: string;
  at: number;
  label?: string;
};

export type EditSession = {
  basePath: string | null;
  versions: EditVersion[];
  currentPath: string | null;
  candidates: string[];
};

/** 画像を開くたびに作り直す、メモリ内だけの編集セッション。 */
export function createEditSession(basePath: string | null): EditSession {
  return {
    basePath,
    versions: [],
    currentPath: basePath,
    candidates: [],
  };
}

/** AI 編集の成功版を追加する。同じ path は履歴へ二重に積まない。 */
export function addEditVersion(
  session: EditSession,
  path: string,
  options: { at?: number; label?: string } = {},
): EditSession {
  const normalizedPath = path.trim();
  if (
    !normalizedPath ||
    normalizedPath === session.basePath ||
    session.versions.some((version) => version.path === normalizedPath)
  ) {
    return session;
  }

  const version: EditVersion = {
    path: normalizedPath,
    at: options.at ?? Date.now(),
    ...(options.label ? { label: options.label } : {}),
  };

  return {
    ...session,
    versions: [...session.versions, version],
    currentPath: normalizedPath,
  };
}

/** 候補ストリップへ成功版を確定する。同じ path は一度だけ載せる。 */
export function confirmEditCandidate(session: EditSession, path: string): EditSession {
  const normalizedPath = path.trim();
  const known = session.versions.some((version) => version.path === normalizedPath);
  if (!normalizedPath || !known || session.candidates.includes(normalizedPath)) return session;

  return {
    ...session,
    candidates: [...session.candidates, normalizedPath],
  };
}

/** 元画像または存在する成功版だけへ表示を切り替える。 */
export function switchEditVersion(session: EditSession, path: string): EditSession {
  const normalizedPath = path.trim();
  const known =
    normalizedPath === session.basePath ||
    session.versions.some((version) => version.path === normalizedPath);
  if (!normalizedPath || !known || normalizedPath === session.currentPath) return session;

  return { ...session, currentPath: normalizedPath };
}
