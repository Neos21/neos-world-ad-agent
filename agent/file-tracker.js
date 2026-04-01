/**
 * file-tracker.js
 * ページファイルの追加・変更を追跡する。
 *
 * 「処理済みかどうか」の判定は idea/done/{rel}.md の存在有無だけで行う。
 * - idea/done/{rel}.md が存在する → 完了済み (現状維持確定)
 * - それ以外 → 処理対象 (未処理 or 改善推奨待ち)
 *
 * session-state.json の fileIndex には last-modified と mtime だけ記録する。
 * ページが更新されたら idea/done/ の対応ファイルを削除して再処理対象に戻す。
 */

import fs from 'fs/promises';
import path from 'path';
import { sortByPriority } from './crawl-priority.js';

/** idea/done/{rel}.md のパスを計算する */
const getDoneFilePath = (pageFilePath, pagesBaseDir, ideaDir) => {
  const rel = path.relative(pagesBaseDir, pageFilePath);
  const relMd = rel.replace(/\.(html|njk|11ty\.js)$/, '.md');
  return path.join(ideaDir, 'done', relMd);
};

/** idea/done/{rel}.md が存在するか確認する */
export const isDoneFile = async (pageFilePath, pagesBaseDir, ideaDir) => {
  try {
    await fs.access(getDoneFilePath(pageFilePath, pagesBaseDir, ideaDir));
    return true;
  } catch {
    return false;
  }
};

/**
 * src/pages/ のファイル一覧をスキャンしてキューを構築する。
 * - 新規ファイル or idea/done/ にない → 処理対象
 * - last-modified が変わったファイル → idea/done/ の対応ファイルを削除して処理対象に戻す
 *
 * @returns {{ toProcess: string[], newFiles: string[], updatedFiles: string[] }}
 */
export const syncFileIndex = async ({
  allPageFiles,
  fileIndex,
  pagesBaseDir,
  ideaDir,
  parseFrontMatter,
  readFileMtime,
}) => {
  const newFiles = [];
  const updatedFiles = [];
  const toProcess = [];

  for (const filePath of allPageFiles) {
    const raw = await fs.readFile(filePath, 'utf-8').catch(() => '');
    const { meta } = parseFrontMatter(raw);
    const lastModified = meta['last-modified'] ?? meta['created'] ?? '';
    const mtime = await readFileMtime(filePath);

    const existing = fileIndex[filePath];

    if (!existing) {
      // 新規ファイル: fileIndex に登録し、done でなければキューに積む
      fileIndex[filePath] = { lastModified, mtime };
      newFiles.push(filePath);
      if (!await isDoneFile(filePath, pagesBaseDir, ideaDir)) {
        toProcess.push(filePath);
      }
      continue;
    }

    // last-modified または mtime が変わっていたら更新とみなす
    const isModified = lastModified && lastModified !== existing.lastModified;
    const isMtimeChanged = !lastModified && mtime > existing.mtime + 1000;

    if (isModified || isMtimeChanged) {
      existing.lastModified = lastModified;
      existing.mtime = mtime;
      // idea/done/ の対応ファイルを削除して再処理対象に戻す
      const doneFile = getDoneFilePath(filePath, pagesBaseDir, ideaDir);
      await fs.unlink(doneFile).catch(() => {});
      updatedFiles.push(filePath);
      toProcess.push(filePath);
      continue;
    }

    // idea/done/ にファイルがなければ処理対象
    if (!await isDoneFile(filePath, pagesBaseDir, ideaDir)) {
      toProcess.push(filePath);
    }
  }

  return { toProcess: sortByPriority(toProcess, pagesBaseDir), newFiles, updatedFiles };
};
