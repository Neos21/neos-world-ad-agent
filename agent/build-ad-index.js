/**
 * build-ad-index.js
 * a8.net と バリューコマース の CSV から、
 * AI が広告マッチングに使う最小限の情報だけを抽出して JSON に変換する。
 *
 * 使い方 (一度だけ、または CSV を更新したとき実行する):
 *   node build-ad-index.js
 *
 * 入力:
 *   memo/available-ads/a8.csv
 *   memo/available-ads/valuecommerce.csv
 *
 * 出力:
 *   memo/available-ads/a8-index.json
 *   memo/available-ads/valuecommerce-index.json
 *   memo/available-ads/combined-index.txt  ← Ollama に渡す整形テキスト
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADS_DIR = path.resolve(__dirname, '../../memo/available-ads');

// PR文・プログラム内容の最大文字数 (コンテキスト節約)
const MAX_DESC_CHARS = 200;

const truncate = (str, max = MAX_DESC_CHARS) => {
  if (!str) return '';
  const cleaned = str
    .replace(/<[^>]+>/g, '')   // HTMLタグ除去
    .replace(/\r?\n/g, ' ')    // 改行をスペースに
    .replace(/\s+/g, ' ')      // 連続スペース圧縮
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned;
};

/**
 * シンプルな CSV パーサー。
 * RFC 4180 準拠: ダブルクォート囲み・フィールド内改行・クォートエスケープに対応。
 */
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
      } else if (ch === '\r') {
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  // 最終行
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

const csvToObjects = (text) => {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1)
    .filter(r => r.length >= headers.length / 2) // 極端に短い行は除外
    .map(r => Object.fromEntries(headers.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
};

// ---- a8.net ----
const buildA8Index = async () => {
  const csvPath = path.join(ADS_DIR, 'a8.csv');
  const raw = await fs.readFile(csvPath, 'utf-8');
  const records = csvToObjects(raw);

  const ads = records
    .filter(r => r['状態'] === '契約中')
    .map(r => ({
      source: 'a8.net',
      advertiserName: r['広告主名'] ?? '',
      category: r['カテゴリ'] ?? '',
      programId: r['プログラムID'] ?? '',
      programName: r['プログラム名'] ?? '',
      description: truncate(r['PR文']),
    }));

  console.log(`[a8] ${ads.length} 件の契約中プログラムを抽出`);
  return ads;
};

// ---- バリューコマース ----
const buildVcIndex = async () => {
  const csvPath = path.join(ADS_DIR, 'valuecommerce.csv');
  const raw = await fs.readFile(csvPath, 'utf-8');
  const records = csvToObjects(raw);

  const ads = records
    .filter(r => r['提携ステータス'] === '提携済み')
    .map(r => {
      const reward = [
        r['定率報酬'] ? `定率${r['定率報酬']}` : '',
        r['定額報酬'] ? `定額${r['定額報酬']}円` : '',
      ].filter(Boolean).join(' / ');

      const categories = [r['カテゴリー1'], r['カテゴリー2'], r['カテゴリー3'], r['カテゴリー4']]
        .filter(Boolean)
        .join(' > ');

      return {
        source: 'バリューコマース',
        advertiserName: r['広告主名'] ?? '',
        category: categories,
        programId: r['プログラムID'] ?? '',
        programName: r['プログラム名'] ?? '',
        reward,
        description: truncate(r['プログラム内容']),
      };
    });

  console.log(`[VC] ${ads.length} 件の提携済みプログラムを抽出`);
  return ads;
};

// ---- combined-index.txt の生成 ----
// Ollama に渡す1枚のテキスト。1広告あたり5行以内に収める。
const buildCombinedText = (allAds) => {
  const lines = [
    '# 利用可能な提携広告一覧',
    `(合計 ${allAds.length} 件)`,
    '',
  ];

  // カテゴリ別にグルーピングして可読性を上げる
  const byCategory = {};
  for (const ad of allAds) {
    const cat = ad.category || 'その他';
    (byCategory[cat] ??= []).push(ad);
  }

  for (const [cat, ads] of Object.entries(byCategory)) {
    lines.push(`## ${cat}`);
    for (const ad of ads) {
      lines.push(`- [${ad.source}] ${ad.programName}`);
      if (ad.reward) lines.push(`  報酬: ${ad.reward}`);
      if (ad.description) lines.push(`  概要: ${ad.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
};

// ---- main ----
const main = async () => {
  console.log('=== 広告インデックス生成 ===\n');

  let a8Ads = [];
  let vcAds = [];

  try {
    a8Ads = await buildA8Index();
    await fs.writeFile(
      path.join(ADS_DIR, 'a8-index.json'),
      JSON.stringify(a8Ads, null, 2),
      'utf-8'
    );
    console.log('  → a8-index.json を出力しました');
  } catch (err) {
    console.warn(`[a8] スキップ: ${err.message}`);
  }

  try {
    vcAds = await buildVcIndex();
    await fs.writeFile(
      path.join(ADS_DIR, 'valuecommerce-index.json'),
      JSON.stringify(vcAds, null, 2),
      'utf-8'
    );
    console.log('  → valuecommerce-index.json を出力しました');
  } catch (err) {
    console.warn(`[VC] スキップ: ${err.message}`);
  }

  const allAds = [...a8Ads, ...vcAds];
  if (allAds.length === 0) {
    console.error('広告データがありません。CSV ファイルを確認してください。');
    process.exit(1);
  }

  const combinedText = buildCombinedText(allAds);
  await fs.writeFile(
    path.join(ADS_DIR, 'combined-index.txt'),
    combinedText,
    'utf-8'
  );
  console.log(`  → combined-index.txt を出力しました (${combinedText.length} 文字)`);

  // ads-data.json: フィルタリング用のフル情報 (programName + description + category)
  await fs.writeFile(
    path.join(ADS_DIR, 'ads-data.json'),
    JSON.stringify(allAds, null, 2),
    'utf-8'
  );
  console.log(`  → ads-data.json を出力しました (${allAds.length} 件)`);

  console.log('\n完了。次回からは node index.js で本体エージェントを実行してください。');
};

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
