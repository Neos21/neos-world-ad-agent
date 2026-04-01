/**
 * index.js
 * Neo's World 広告収益改善エージェント
 *
 * 使い方:
 *   node index.js             # 起動時にファイル差分をスキャンして処理
 *   node index.js --reset     # fileIndex をリセットして全ページ再処理
 *   node index.js --limit 10  # 今回は最大10ページだけ処理して停止
 *   node index.js --status    # 現在の進捗を表示して終了 (Ollama 不要)
 *   node index.js --clean     # history/ と idea/ の中身を全削除して .gitkeep だけ残す
 *   node index.js --debug pokemon/absol-data.html
 *                           # 指定ページの読み取り結果とプロンプトを標準出力して終了 (Ollama 不要)
 *   node index.js --run pokemon/absol-data.html
 *                           # 指定ページだけ Ollama を通して idea/ に保存する
 *
 * 完了済みの判定:
 *   idea/done/{rel}.md が存在する → 完了済み (現状維持確定)
 *   それ以外 → 処理対象
 *   ページの last-modified が変わった → idea/done/ の対応ファイルを自動削除して再処理
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { createSessionManager } from './session.js';
import { createPageReader } from './page-reader.js';
import { createAdLoader } from './ad-loader.js';
import { ensureOllamaReady, createOllamaClient } from './ollama-client.js';
import { createReporter } from './reporter.js';
import { buildPageAnalysisPrompt, extractGenres, extractKeywords } from './prompts.js';
import { syncFileIndex } from './file-tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');

const PATHS = {
  pages:        path.join(REPO_ROOT, 'src/pages'),
  availableAds: path.join(REPO_ROOT, 'memo/available-ads'),
  history:      path.join(REPO_ROOT, 'memo/history'),
  idea:         path.join(REPO_ROOT, 'memo/idea'),
  sessionState: path.join(REPO_ROOT, 'memo/history/session-state.json'),
};

const MODEL = 'gpt-oss:20b';  // 遅いが精度は良い
//const MODEL = 'qwen3.5:9b';  // 遅いが精度は良い
//const MODEL = 'qwen2.5:14b-instruct-q4_k_m';  // 速いが無関係なキーワードを取得していることが多い

const args = process.argv.slice(2);
const isReset  = args.includes('--reset');
const isStatus = args.includes('--status');
const isClean  = args.includes('--clean');
const isDebug  = args.includes('--debug');
const debugTarget = isDebug ? args[args.indexOf('--debug') + 1] : null;
const isRun    = args.includes('--run');
const runTarget  = isRun  ? args[args.indexOf('--run')  + 1] : null;
const limitIdx = args.indexOf('--limit');
const processLimit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

const hr = (w = 60) => '─'.repeat(w);
const printHeader = (text) => { console.log('\n' + hr()); console.log(` ${text}`); console.log(hr()); };

// ---- --status モード ----
const showStatus = async () => {
  printHeader('進捗確認');
  // idea/done/ のファイル数 = 現状維持確定
  const countFiles = async (dir) => {
    try {
      const entries = await fs.readdir(dir, { recursive: true });
      return entries.filter(e => e.endsWith('.md') && !e.endsWith('index.md')).length;
    } catch {
      return 0;
    }
  };
  const doneCount    = await countFiles(path.join(PATHS.idea, 'done'));
  const suggestCount = await countFiles(PATHS.idea); // done/ 配下を含む
  const improveCount = suggestCount - doneCount;
  console.log(`  idea/done/ (現状維持確定): ${doneCount} ページ`);
  console.log(`  idea/      (改善推奨):     ${improveCount} ページ`);
};

// ---- --clean モード ----
const cleanDirectories = async () => {
  printHeader('クリーン実行');
  for (const dir of [PATHS.history, PATHS.idea]) {
    const rel = path.relative(REPO_ROOT, dir);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.gitkeep'), '');
    console.log(`  ✓ ${rel}/ をクリア → .gitkeep のみ`);
  }
  console.log('\n  完了。次回 node index.js で最初から分析を開始します。');
};

// ---- --debug モード ----
const debugPage = async (target) => {
  if (!target) {
    console.error('使い方: node index.js --debug <ページの相対パス>');
    console.error('例:     node index.js --debug pokemon/absol-data.html');
    process.exit(1);
  }

  const reader  = createPageReader(PATHS.pages);
  const adLoader = createAdLoader(PATHS.availableAds);

  // 対象ファイルを特定 (部分一致でも可)
  const allFiles = await reader.getAllFiles();
  const matched = allFiles.filter(f => f.includes(target.replace(/\//g, path.sep)));
  if (matched.length === 0) {
    console.error(`ファイルが見つかりません: ${target}`);
    console.error(`src/pages/ 配下のパスを指定してください (例: pokemon/absol-data.html)`);
    process.exit(1);
  }
  if (matched.length > 1) {
    console.log(`複数のファイルがマッチしました。最初の1件を使います:`);
    matched.forEach(f => console.log('  ' + path.relative(PATHS.pages, f)));
  }

  const filePath = matched[0];
  const rel = path.relative(PATHS.pages, filePath);
  printHeader(`デバッグ: ${rel}`);

  // ---- ファイル読み取り結果 ----
  const pageInfo = await reader.readFile(filePath);
  console.log('\n[FrontMatter]');
  console.log(JSON.stringify(pageInfo.meta, null, 2));
  console.log('\n[既存広告クラス]', pageInfo.existingAds.length ? pageInfo.existingAds.join(', ') : 'なし');
  console.log('\n[本文] (先頭500文字)');
  console.log('─'.repeat(60));
  console.log(pageInfo.body.slice(0, 500));
  if (pageInfo.body.length > 500) console.log(`... (全${pageInfo.body.length}文字、${pageInfo.truncated ? 'トランケート済み' : 'トランケートなし'})`);
  console.log('─'.repeat(60));

  // ---- Step1 プロンプト ----
  const prompt1 = buildPageAnalysisPrompt({
    pageRelPath: rel,
    meta: pageInfo.meta,
    existingAds: pageInfo.existingAds,
    pageBody: pageInfo.body,
  });
  console.log(`\n[Step1 プロンプト全文] (${prompt1.length}文字) ※広告リストなし`);
  console.log('─'.repeat(60));
  console.log(prompt1);
  console.log('─'.repeat(60));

  // ---- Step2 プロンプト (広告リスト付き) ----
  const adsIndex = await adLoader.loadAllAds();
  const dummyAnalysis = '(Step1 の実際の出力がここに入ります)';
  const prompt2 = buildAdMatchPrompt({
    pageAnalysis: dummyAnalysis,
    adsIndex,
    existingAds: pageInfo.existingAds,
  });
  console.log(`\n[Step2 プロンプト全文] (${prompt2.length}文字) ※Step1結果 + 広告リスト`);
  console.log('─'.repeat(60));
  console.log(prompt2);
  console.log('─'.repeat(60));
  console.log('\n※ Ollama への送信はスキップしました。内容を確認してください。');
};

// ---- --run モード ----
const runPage = async (target) => {
  if (!target) {
    console.error('使い方: node index.js --run <ページの相対パス>');
    console.error('例:     node index.js --run pokemon/absol.html');
    process.exit(1);
  }

  const reader   = createPageReader(PATHS.pages);
  const adLoader = createAdLoader(PATHS.availableAds);
  const reporter = createReporter({
    ideaDir:      PATHS.idea,
    historyDir:   PATHS.history,
    pagesBaseDir: PATHS.pages,
  });

  const allFiles = await reader.getAllFiles();
  const matched = allFiles.filter(f => f.includes(target.replace(/\//g, path.sep)));
  if (matched.length === 0) {
    console.error(`ファイルが見つかりません: ${target}`);
    process.exit(1);
  }
  if (matched.length > 1) {
    console.log('複数のファイルがマッチしました。最初の1件を使います:');
    matched.forEach(f => console.log('  ' + path.relative(PATHS.pages, f)));
  }

  const filePath = matched[0];
  const rel = path.relative(PATHS.pages, filePath);
  printHeader(`単体実行: ${rel}`);

  // Ollama 起動確認
  printHeader('Ollama 起動確認');
  await ensureOllamaReady('http://localhost:11434', MODEL);
  const ollama = createOllamaClient({ model: MODEL, numCtx: 16384 });

  const adsIndex = await adLoader.loadAllAds();
  const pageInfo = await reader.readFile(filePath);

  if (pageInfo.meta.title) console.log(`タイトル: ${pageInfo.meta.title}`);
  if (pageInfo.existingAds.length > 0) console.log(`既存広告: ${pageInfo.existingAds.join(', ')}`);
  if (pageInfo.truncated) console.log('⚠ 本文トランケート');

  // Step1
  const prompt1 = buildPageAnalysisPrompt({
    pageRelPath: rel,
    meta: pageInfo.meta,
    existingAds: pageInfo.existingAds,
    pageBody: pageInfo.body,
  });
  console.log(`\nStep1 プロンプト: ${prompt1.length} 文字 → 送信中...`);
  const pageAnalysis = await ollama.generate(prompt1);
  console.log('\n--- Step1 結果 ---');
  console.log(pageAnalysis);

  // Step1 出力からジャンルリストとキーワードを抽出
  const genres   = extractGenres(pageAnalysis);
  const keywords = extractKeywords(pageAnalysis);
  console.log('\n--- 抽出ジャンル ---');
  console.log(genres.join(', ') || '(なし)');
  console.log('\n--- 抽出キーワード ---');
  console.log(keywords || '(なし)');

  // 広告照合 (JS側でキーワードマッチ)
  const matchedAds = await adLoader.filterAdsByGenres(genres);
  const adNames = matchedAds.slice(0, 5).map(ad => ad.programName);
  console.log('\n--- マッチした広告 ---');
  console.log(adNames.length > 0 ? adNames.join('\n') : '(該当なし)');

  const isDone = matchedAds.length === 0 && /コミュニティ|アーカイブ|同盟|リンク集|プロフィール|自己紹介|問い合わせ|404/.test(pageAnalysis);

  const ideaPath = await reporter.saveIdea(filePath, pageAnalysis, { isDone, adNames, keywords });
  await reporter.appendHistory(`単体実行: ${rel} | ${isDone ? '現状維持' : '改善推奨'}`);

  printHeader('完了');
  console.log(`判定: ${isDone ? '現状維持 → idea/done/' : `改善推奨 | 推奨: ${adNames.join(', ') || 'なし'}`}`);
  console.log(`保存: ${path.relative(path.resolve('../../'), ideaPath)}`);
};

// ---- FrontMatter パーサー (index.js 内で使う簡易版) ----
const parseFrontMatter = (raw) => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { meta: {} };
  const meta = {};
  let currentKey = null;
  for (const line of match[1].split('\n')) {
    if (currentKey === 'path' && line.match(/^\s+- /)) continue;
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)/);
    if (kv) { currentKey = kv[1].trim(); if (kv[2].trim()) meta[currentKey] = kv[2].trim(); }
  }
  return { meta };
};

// ---- メイン ----
const main = async () => {
  printHeader("Neo's World 広告収益改善エージェント");

  if (isClean) { await cleanDirectories(); return; }
  if (isStatus) { await showStatus(); return; }
  if (isDebug) { await debugPage(debugTarget); return; }
  if (isRun)   { await runPage(runTarget);     return; }

  const session  = createSessionManager(PATHS.sessionState);
  const reader   = createPageReader(PATHS.pages);
  const adLoader = createAdLoader(PATHS.availableAds);
  const reporter = createReporter({
    ideaDir:      PATHS.idea,
    historyDir:   PATHS.history,
    pagesBaseDir: PATHS.pages,
  });

  let state = isReset ? await session.reset() : await session.load();

  // ---- Ollama 起動確認 ----
  printHeader('Ollama 起動確認');
  await ensureOllamaReady('http://localhost:11434', MODEL);
  const ollama = createOllamaClient({ model: MODEL, numCtx: 16384 });

  // ---- 広告インデックス ----
  const adsIndex = await adLoader.loadAllAds();
  console.log(`[AdLoader] 広告インデックス: ${adsIndex.length} 文字`);

  // ---- ファイルスキャン・差分検出 ----
  printHeader('ファイルスキャン');
  console.log('[Scanner] src/pages/ をスキャン中...');
  const allFiles = await reader.getAllFiles();

  const { toProcess, newFiles, updatedFiles } = await syncFileIndex({
    allPageFiles: allFiles,
    fileIndex: state.fileIndex,
    pagesBaseDir: PATHS.pages,
    ideaDir: PATHS.idea,
    parseFrontMatter,
    readFileMtime: async (fp) => (await fs.stat(fp).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
  });

  if (newFiles.length > 0) {
    console.log(`[Scanner] 新規ファイル: ${newFiles.length} 件`);
    for (const f of newFiles) console.log(`  + ${path.relative(PATHS.pages, f)}`);
  }
  if (updatedFiles.length > 0) {
    console.log(`[Scanner] 更新検知 (再分析対象): ${updatedFiles.length} 件`);
    for (const f of updatedFiles) console.log(`  ~ ${path.relative(PATHS.pages, f)}`);
  }

  // キューを更新 (前回中断分 + 今回の新規・更新分を合わせて重複排除)
  const prevQueue = new Set(state.queue);
  state.queue = [...state.queue, ...toProcess.filter(f => !prevQueue.has(f))];
  await session.save(state);

  console.log(`\n[Queue] 処理対象: ${state.queue.length} ページ`);
  if (state.queue.length === 0) {
    console.log('  処理するページはありません。');
    await showStatus();
    return;
  }

  // ---- 処理ループ ----
  printHeader('ページ分析開始');
  const totalFiles = allFiles.length;

  let processedThisRun = 0;
  let interrupted = false;
  process.on('SIGINT', () => {
    process.stdout.write('\n');
    console.log('[Agent] 割り込みを受け付けました。このファイルの処理後に終了します...');
    interrupted = true;
  });

  const indexEntries = [];

  while (state.queue.length > 0 && !interrupted) {
    if (processedThisRun >= processLimit) {
      console.log(`[Agent] --limit ${processLimit} に達しました。`);
      break;
    }

    const filePath = state.queue[0];
    const rel = path.relative(PATHS.pages, filePath);
    console.log(`\n[${processedThisRun + 1}/${state.queue.length + processedThisRun}] ${rel}`);

    state.currentFile = filePath;
    await session.save(state);

    try {
      const pageInfo = await reader.readFile(filePath);
      if (pageInfo.truncated) console.log('  ⚠ 本文トランケート');
      if (pageInfo.existingAds.length > 0) console.log(`  既存広告: ${pageInfo.existingAds.join(', ')}`);
      if (pageInfo.meta.title) console.log(`  タイトル: ${pageInfo.meta.title}`);
      if (pageInfo.meta['last-modified']) console.log(`  最終更新: ${pageInfo.meta['last-modified']}`);

      // ---- Step1: ページ分析 (広告リストなし) ----
      const prompt1 = buildPageAnalysisPrompt({
        pageRelPath: rel,
        meta: pageInfo.meta,
        existingAds: pageInfo.existingAds,
        pageBody: pageInfo.body,
      });
      console.log(`  Step1 プロンプト: ${prompt1.length} 文字`);

      const callWithRetry = async (prompt, label, opts = {}) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (attempt > 1) {
            console.log(`  ↩ ${label} リトライ ${attempt - 1}/2 回目...`);
            await new Promise(r => setTimeout(r, 2000));
          }
          const r = await ollama.generate(prompt, opts);
          if (r.length >= 80) return r;
          console.log(`  ⚠ ${label} レスポンスが短すぎます (${r.length}文字、試行${attempt}/3)`);
        }
        return '';
      };

      const pageAnalysis = await callWithRetry(prompt1, 'Step1');
      if (!pageAnalysis) {
        console.log('  ✗ Step1 失敗。次回再試行します。');
        await reporter.appendHistory(`pending 差し戻し: ${rel} | Step1 3回試行失敗`);
        state.queue.shift();
        state.currentFile = null;
        await session.save(state);
        processedThisRun++;
        continue;
      }
      console.log(`  Step1 完了 (${pageAnalysis.length}文字)`);

      // Step1 出力からジャンルリストとキーワードを抽出
      const genres   = extractGenres(pageAnalysis);
      const keywords = extractKeywords(pageAnalysis);
      if (genres.length > 0) console.log(`  ジャンル: ${genres.slice(0, 3).join(', ')} ...`);

      // ---- 広告照合 (JS側でキーワードマッチ、Ollamaは不使用) ----
      const matchedAds = await adLoader.filterAdsByGenres(genres);
      const adNames = matchedAds.slice(0, 5).map(ad => ad.programName);
      if (adNames.length > 0) {
        console.log(`  マッチ広告: ${adNames.join(', ')}`);
      }

      // 「現状維持」判定: Step1の分析結果に現状維持系のキーワードがあるか、
      // またはマッチした広告が0件かつページが広告に向いていないと判断できる場合
      const isDone = matchedAds.length === 0 && /コミュニティ|アーカイブ|同盟|リンク集|プロフィール|自己紹介|問い合わせ|404/.test(pageAnalysis);

      await reporter.saveIdea(filePath, pageAnalysis, { isDone, adNames, keywords });
      console.log(`  判定: ${isDone ? '現状維持 → idea/done/' : `改善推奨 | 推奨: ${adNames.join(', ') || 'なし'}`}`);

      await reporter.appendHistory(
        `完了: ${rel} | ${isDone ? '現状維持' : '改善推奨'} | 広告: ${adNames.join(', ') || 'なし'}`
      );

      if (!isDone) indexEntries.push({ rel, adNames });
      state.queue.shift();
      state.currentFile = null;
      await session.save(state);

      processedThisRun++;

    } catch (err) {
      console.error(`  ✗ エラー: ${err.message}`);
      await reporter.appendHistory(`エラー: ${rel} | ${err.message}`);
      state.queue.shift();
      state.currentFile = null;
      await session.save(state);
    }
  }

  if (indexEntries.length > 0) {
    await reporter.updateIndex(indexEntries);
  }

  // ---- 完了サマリ ----
  printHeader('実行結果');
  console.log(`  今回処理: ${processedThisRun} ページ`);
  await showStatus();

  if (state.queue.length > 0) {
    console.log(`\n  残り ${state.queue.length} ページ。node index.js で再開できます。`);
    await reporter.appendHistory(`今回 ${processedThisRun} ページ処理。残り ${state.queue.length} ページ。`);
  } else {
    console.log('\n  ✅ キューが空になりました。');
    await reporter.appendHistory(`今回 ${processedThisRun} ページ処理。キュー完了。`);
  }
};

main().catch(err => { console.error('\n[Fatal]', err); process.exit(1); });
