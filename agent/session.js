/**
 * session.js
 * セッション状態の永続化。
 *
 * state の構造:
 * {
 *   startedAt: string,
 *   lastUpdatedAt: string,
 *   fileIndex: {
 *     [absolutePath]: {
 *       lastModified: string,  ← FrontMatter の last-modified 値 (更新検知用)
 *       mtime: number,         ← ファイルの mtime ms (last-modified がない場合のフォールバック)
 *     }
 *   },
 *   queue: string[],       ← 今回処理すべきファイルのキュー
 *   currentFile: string | null,
 * }
 *
 * 「完了済みかどうか」は fileIndex ではなく idea/done/{rel}.md の存在で判断する。
 */

import fs from 'fs/promises';
import path from 'path';

export const createSessionManager = (stateFilePath) => {
  const defaultState = () => ({
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    fileIndex: {},
    queue: [],
    currentFile: null,
  });

  const load = async () => {
    try {
      const raw = await fs.readFile(stateFilePath, 'utf-8');
      const state = JSON.parse(raw);
      const total = Object.keys(state.fileIndex ?? {}).length;
      console.log(`[Session] 状態を読み込みました: 既知ファイル ${total} 件`);
      return state;
    } catch {
      console.log('[Session] セッション状態が見つかりません。新規開始します。');
      return defaultState();
    }
  };

  const save = async (state) => {
    state.lastUpdatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
    await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
  };

  const reset = async () => {
    try { await fs.unlink(stateFilePath); } catch {}
    console.log('[Session] セッション状態をリセットしました。');
    return defaultState();
  };

  return { load, save, reset };
};
