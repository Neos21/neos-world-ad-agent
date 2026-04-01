/**
 * crawl-priority.js
 * クロール優先順位の設定。
 *
 * DIR_PRIORITY の数値が小さいほど先にクロールされる。
 * ここに書いていないディレクトリには DEFAULT_PRIORITY が適用される。
 *
 * blog/ は特別扱い: 年月日を逆順ソート (新しい記事を先に処理する)。
 */

export const DIR_PRIORITY = {
  'mario':   1,  // 特集ページ・最優先
  'pokemon': 1,  // 特集ページ・最優先
  'etc':     2,  // ページ数少なめ・先に見る
  'gallery': 2,  // ページ数少なめ・先に見る
  'games':   3,  // ブログより先
  'music':   3,  // ブログより先
  'tech':    3,  // ブログより先
  'blog':    4,  // 新しい記事から古い記事の順
  'about':   99, // 広告不要・最後
};

export const DEFAULT_PRIORITY = 10;

/**
 * blog/YYYY/MM/DD-NN.md からソート用の数値を抽出する。
 * 例: blog/2026/01/15-01.md → 20260115
 * 解析できなければ 0 を返す。
 */
const extractBlogDate = (rel) => {
  const m = rel.match(/^blog\/(\d{4})\/(\d{2})\/(\d{2})-/);
  if (!m) return 0;
  return parseInt(`${m[1]}${m[2]}${m[3]}`, 10);
};

/**
 * ファイルパスのリストを優先順位に従ってソートして返す。
 * @param {string[]} filePaths - 絶対パスのリスト
 * @param {string} pagesBaseDir - src/pages/ の絶対パス (末尾スラッシュなし)
 * @returns {string[]}
 */
export const sortByPriority = (filePaths, pagesBaseDir) =>
  [...filePaths].sort((a, b) => {
    const relA = a.slice(pagesBaseDir.length + 1); // 例: blog/2026/01/01-01.md
    const relB = b.slice(pagesBaseDir.length + 1);

    const topA = relA.split('/')[0];
    const topB = relB.split('/')[0];

    const prioA = DIR_PRIORITY[topA] ?? DEFAULT_PRIORITY;
    const prioB = DIR_PRIORITY[topB] ?? DEFAULT_PRIORITY;

    // 異なるディレクトリ間は優先度数値で比較
    if (prioA !== prioB) return prioA - prioB;

    // blog 同士: 年月日の降順 (新しい記事を先に)
    if (topA === 'blog' && topB === 'blog') {
      const dateA = extractBlogDate(relA);
      const dateB = extractBlogDate(relB);
      if (dateA !== dateB) return dateB - dateA;
    }

    // それ以外は辞書順
    return relA < relB ? -1 : relA > relB ? 1 : 0;
  });
