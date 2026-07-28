import manga01 from "../../../assets/comic-templates/manga01.png";
import manga02 from "../../../assets/comic-templates/manga02.png";
import manga03 from "../../../assets/comic-templates/manga03.png";
import manga04 from "../../../assets/comic-templates/manga04.png";
import manga05 from "../../../assets/comic-templates/manga05.png";
import manga06 from "../../../assets/comic-templates/manga06.png";
import manga07 from "../../../assets/comic-templates/manga07.png";
import manga08 from "../../../assets/comic-templates/manga08.png";
import manga09 from "../../../assets/comic-templates/manga09.png";
import manga10 from "../../../assets/comic-templates/manga10.png";
import manga11 from "../../../assets/comic-templates/manga11.png";
import manga12 from "../../../assets/comic-templates/manga12.png";

/**
 * マンガ01〜12 のテンプレ選択サムネイル（STΛCK 提供の参照画像を12分割・軽量化したもの）。
 *
 * CSS ミニプレビューでなく実画像を使うのは STΛCK 指示 (2026-07-28)。
 * Vite の import なのでバンドルに焼き込まれ、配布時のリソース解決漏れが起きない。
 * サムネが無い ID は TemplateMiniPreview 側の CSS ミニプレビューへフォールバックする。
 */
export const COMIC_TEMPLATE_THUMBNAILS: Record<string, string> = {
  manga01,
  manga02,
  manga03,
  manga04,
  manga05,
  manga06,
  manga07,
  manga08,
  manga09,
  manga10,
  manga11,
  manga12,
};
