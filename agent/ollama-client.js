/**
 * ollama-client.js
 * Ollama の /api/generate エンドポイントを叩くクライアント。
 * - Ollama サーバーが起動していなければ自動で `ollama serve` を起動する
 * - ストリーミング無効 (stream: false) で一括受信
 * - <think>...</think> ブロックを除去して本文だけ返す
 */

import { spawn, execSync } from 'child_process';

const DEFAULT_ENDPOINT = 'http://localhost:11434';

// ---- Ollama サーバー自動起動 ----

const isServerAlive = async (endpoint) => {
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
};

const isModelAvailable = async (endpoint, model) => {
  try {
    const res = await fetch(`${endpoint}/api/tags`);
    const data = await res.json();
    return (data.models ?? []).some(m => m.name === model || m.name.startsWith(model.split(':')[0]));
  } catch {
    return false;
  }
};

const startServer = async (endpoint) => {
  console.log('[Ollama] サーバーが起動していません。ollama serve を起動します...');
  const proc = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isServerAlive(endpoint)) {
      console.log(`[Ollama] サーバーが起動しました (${i + 1}秒)`);
      return;
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  throw new Error('Ollama サーバーの起動がタイムアウトしました。手動で `ollama serve` を実行してください。');
};

const warmupModel = async (endpoint, model) => {
  console.log(`[Ollama] モデル ${model} をロード中...`);
  const start = Date.now();
  await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false }),
  });
  console.log(`[Ollama] モデルのロード完了 (${((Date.now() - start) / 1000).toFixed(1)}秒)`);
};

export const ensureOllamaReady = async (endpoint = DEFAULT_ENDPOINT, model) => {
  if (!await isServerAlive(endpoint)) {
    await startServer(endpoint);
  } else {
    console.log('[Ollama] サーバーは起動済みです。');
  }
  if (!await isModelAvailable(endpoint, model)) {
    console.log(`[Ollama] モデル ${model} が見つかりません。ollama pull を実行します...`);
    execSync(`ollama pull ${model}`, { stdio: 'inherit' });
  }
  await warmupModel(endpoint, model);
};

// ---- クライアント ----

/**
 * <think>...</think> ブロックを除去して本文だけ返す。
 * 除去後に本文が空（または極端に短い）場合は think ブロックの内容自体を返す。
 * これは qwen3.5:9b が think だけ出して本文を出力しないケースへの対処。
 */
const removeThinkBlocks = (text) => {
  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (withoutThink.length >= 50) return withoutThink;

  // think ブロックの内容を抽出してフォールバック
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    const thinkContent = thinkMatch[1].trim();
    if (thinkContent.length >= 50) {
      console.log('  [警告] 本文が空のため think ブロックの内容を使用します');
      return thinkContent;
    }
  }
  return withoutThink;
};

export const createOllamaClient = ({
  endpoint = DEFAULT_ENDPOINT,
  model,
  numCtx = 16384,
} = {}) => {
  /**
   * Ollama に推論を投げて本文テキストを返す。
   * @param {string} prompt
   * @param {object} opts
   * @param {boolean} [opts.think=true] - false にすると Qwen3 の think ブロックを抑制する
   */
  const generate = async (prompt, { think = true } = {}) => {
    if (!model) throw new Error('[OllamaClient] model が指定されていません。index.js の MODEL を確認してください。');
    const startTime = Date.now();

    // think=false のとき: Ollama の thinking オプション + プロンプト末尾に /no_think を追加
    // (Ollama バージョンによってどちらかが効く)
    const actualPrompt = think ? prompt : prompt + '\n/no_think';
    const body = {
      model,
      prompt: actualPrompt,
      stream: false,
      options: { num_ctx: numCtx, temperature: 0.1 },
    };
    if (!think) body.think = false; // Ollama 0.7+ の公式オプション

    const res = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Ollama API エラー: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const evalCount = data.eval_count ?? '?';
    const evalDuration = data.eval_duration ? (data.eval_duration / 1e9).toFixed(1) : '?';
    const tps = data.eval_count && data.eval_duration
      ? (data.eval_count / (data.eval_duration / 1e9)).toFixed(1)
      : '?';
    console.log(`  [完了] ${evalCount} tokens | ${evalDuration}s | 平均 ${tps} t/s (合計 ${elapsed}s)`);

    return removeThinkBlocks(data.response ?? '');
  };

  return { generate };
};
