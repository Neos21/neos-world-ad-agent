/**
 * reporter.js
 * AI の分析結果を idea/ に Markdown ファイルとして出力し、
 * history/ に作業ログを追記する。
 *
 * 出力先:
 *   改善推奨ページ → idea/{src/pages と同じ相対パス}.md
 *   現状維持ページ → idea/done/{src/pages と同じ相対パス}.md
 *
 * idea/ のファイルに以下を先頭行に追記すると、次回実行時にステータスが反映される:
 *   status: applied   ← 広告を貼った
 *   status: done      ← 改善不要・現状維持と判断 (手動で上書きしたい場合)
 */

import fs from 'fs/promises';
import path from 'path';

export const createReporter = ({ ideaDir, historyDir, pagesBaseDir }) => {
  const saveIdea = async (pageFilePath, analysisResult, meta = {}) => {
    const { isDone = false, adNames = [], keywords = '' } = meta;
    const rel = path.relative(pagesBaseDir, pageFilePath);
    const relMd = rel.replace(/\.(html|njk|11ty\.js)$/, '.md');

    // 現状維持は idea/done/ 配下、改善推奨は idea/ 直下 (src/pages と同構造)
    const ideaFilePath = isDone
      ? path.join(ideaDir, 'done', relMd)
      : path.join(ideaDir, relMd);

    await fs.mkdir(path.dirname(ideaFilePath), { recursive: true });

    const content = isDone
      ? [
          `<!-- AI判定: 現状維持。変更したい場合は先頭付近に「status: applied」を追記 -->`,
          `# 現状維持: ${rel}`,
          '',
          `> 分析日時: ${new Date().toISOString()}`,
          `> AI判定: 現状維持でよい`,
          adNames.length ? `> 参考情報 (対応不要): ${adNames.join(', ')}` : null,
          keywords ? `> 検索キーワード: ${keywords}` : null,
          '',
          '---',
          '',
          analysisResult.trim(),
        ].filter(l => l != null).join('\n')
      : [
          `<!-- 広告を掲載したら先頭付近に「status: applied」、対応不要なら「status: done」を追記 -->`,
          `# 広告提案: ${rel}`,
          '',
          `> 分析日時: ${new Date().toISOString()}`,
          `> AI判定: 改善推奨`,
          adNames.length ? `> 推奨広告: ${adNames.join(', ')}` : null,
          keywords ? `> 検索キーワード: ${keywords}` : null,
          '',
          '---',
          '',
          analysisResult.trim(),
        ].filter(l => l != null).join('\n');

    await fs.writeFile(ideaFilePath, content, 'utf-8');
    return ideaFilePath;
  };

  const updateIndex = async (entries) => {
    const lines = [
      '# 広告提案インデックス (改善推奨ページのみ)',
      '',
      `最終更新: ${new Date().toISOString()}`,
      '',
      '| ページ | 推奨広告 |',
      '|--------|----------|',
    ];
    for (const e of entries) {
      const ideaRel = e.rel.replace(/\.(html|njk)$/, '.md');
      lines.push(`| [${e.rel}](${ideaRel}) | ${e.adNames?.join(', ') ?? '-'} |`);
    }
    await fs.mkdir(ideaDir, { recursive: true });
    await fs.writeFile(path.join(ideaDir, 'index.md'), lines.join('\n'), 'utf-8');
  };

  const appendHistory = async (message) => {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(historyDir, `${today}.md`);
    await fs.mkdir(historyDir, { recursive: true });
    await fs.appendFile(logFile, `[${new Date().toISOString()}] ${message}\n`, 'utf-8');
  };

  return { saveIdea, updateIndex, appendHistory };
};
