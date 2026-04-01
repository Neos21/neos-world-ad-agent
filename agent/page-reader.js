/**
 * page-reader.js
 * src/pages/ 配下のページファイルを再帰的にスキャンして読み込む。
 * - FrontMatter を解析してメタ情報を分離する
 * - 既存広告 div の有無を検出する
 * - 本文を MAX_CHARS 文字に切り詰める
 */

import fs from 'fs/promises';
import path from 'path';

const SUPPORTED_EXTENSIONS = new Set(['.html', '.md', '.njk']);

// 既存広告クラスの定義
const AD_CLASS_PATTERNS = ['ad-amazon', 'ad-rakuten', 'ad-banner', 'ad-general'];

/** 再帰的にファイル一覧を取得 */
const walkDir = async (dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkDir(fullPath));
    } else if (entry.isFile()) {
      if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }
  return files;
};

/**
 * FrontMatter を解析する。
 * --- で囲まれた YAML ブロックをパースし、title / created / last-modified / path を抽出。
 * @returns {{ meta: object, body: string }}
 */
const parseFrontMatter = (raw) => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw };
  }

  const yamlBlock = match[1];
  const body = match[2];
  const meta = {};

  // シンプルな key: value パース (ネストは無視、path の配列だけ対応)
  let currentKey = null;
  const pathLines = [];
  for (const line of yamlBlock.split('\n')) {
    // path: の配列要素
    if (currentKey === 'path' && line.match(/^\s+- /)) {
      pathLines.push(line.replace(/^\s+- /, '').trim());
      continue;
    }
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)/);
    if (kv) {
      currentKey = kv[1].trim();
      const val = kv[2].trim();
      if (val) {
        meta[currentKey] = val;
      }
    }
  }
  if (pathLines.length > 0) {
    meta['path'] = pathLines;
  }

  return { meta, body };
};

/**
 * 既存広告クラスを検出する。
 * @returns {string[]} 見つかったクラス名の配列
 */
const detectExistingAds = (content) =>
  AD_CLASS_PATTERNS.filter(cls => content.includes(`class="${cls}"`) || content.includes(`class='${cls}'`));

/**
 * ファイルを読み込んで構造化情報を返す。
 * @param {string} filePath
 * @param {number} maxBodyChars - 本文の最大文字数
 * @returns {Promise<PageInfo>}
 *
 * @typedef {object} PageInfo
 * @property {string} path
 * @property {object} meta         - FrontMatter から抽出したメタ情報
 * @property {string} body         - 本文 (トランケート済み)
 * @property {boolean} truncated   - 本文がトランケートされたか
 * @property {string[]} existingAds - 既存の広告クラス名
 */
const readPageFile = async (filePath, maxBodyChars = 4000) => {
  const raw = await fs.readFile(filePath, 'utf-8');
  const { meta, body } = parseFrontMatter(raw);
  const existingAds = detectExistingAds(raw);

  const truncated = body.length > maxBodyChars;
  return {
    path: filePath,
    meta,
    body: truncated ? body.slice(0, maxBodyChars) + '\n... [以降トランケート]' : body,
    truncated,
    existingAds,
  };
};

export const createPageReader = (pagesDir) => ({
  getAllFiles: () => walkDir(pagesDir),
  readFile: (filePath, maxBodyChars) => readPageFile(filePath, maxBodyChars),
});
