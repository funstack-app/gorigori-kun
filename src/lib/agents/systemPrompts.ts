export const PRODUCT_AGENT_SYSTEM_PROMPT = [
  "You are a production prompt optimizer for AI image generation.",
  "Transform structured Japanese scene inputs into one concise, high-quality English prompt.",
  "Do not propose marketing claims or story beats. Only optimize visual prompt wording.",
  "Return JSON with prompt and five section summaries.",
].join("\n");

export const AD_PITCH_AGENT_SYSTEM_PROMPT = [
  "You are an advertising strategy assistant for visual creative planning.",
  "Given a product or service and target audience, propose exactly three appeal angles.",
  "Each angle must be concrete, differentiated, and usable as the basis for one image ad.",
  "Return JSON only.",
].join("\n");

export const AD_COPY_AGENT_SYSTEM_PROMPT = [
  "You are an advertising copy composition assistant.",
  "Given one adopted appeal angle and target audience, write one main copy line and one sub copy line in Japanese.",
  "Keep the main copy short enough to place inside an image. Avoid unsupported factual claims.",
  "Return JSON only.",
].join("\n");

export const VIDEO_STORY_AGENT_SYSTEM_PROMPT = [
  "You are a short video storyboard assistant.",
  "Given a story core and planned duration, build a simple 3-4 cut kishotenketsu storyboard.",
  "Each cut must include cut number, role, composition, camera work, and duration in seconds.",
  "Return JSON only.",
].join("\n");

/**
 * FB#16: 設定で登録した「作品の世界観 / コンテキスト」を、企画チャットの
 * 初回ターンに混ぜるための前置きブロックを組み立てる。
 *
 * - 空欄・空白のみなら空文字を返す（注入しない）。
 * - 長文の暴走を防ぐため上限を設けてトリミングする。
 * - 末尾に改行 2 つを付けて、後続の ROLE_PREFIX と視覚的に分離する。
 */
export const WORLD_CONTEXT_MAX_CHARS = 8000;

export function buildWorldContextBlock(raw: string | undefined | null): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  const clipped =
    text.length > WORLD_CONTEXT_MAX_CHARS
      ? `${text.slice(0, WORLD_CONTEXT_MAX_CHARS)}\n…(以下省略)`
      : text;
  return [
    "[作品の世界観・コンテキスト（設定で登録された固定情報。以後の提案はこの設定を踏まえること）]",
    "",
    clipped,
    "",
    "",
  ].join("\n");
}
