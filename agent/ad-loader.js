/**
 * ad-loader.js
 * available-ads/ の広告インデックスを読み込む。
 *
 * 優先順位:
 *   1. combined-index.txt  ← build-ad-index.js で生成した整形済みテキスト (推奨)
 *   2. a8-index.json + valuecommerce-index.json ← JSON を直接結合
 *   3. a8.csv / valuecommerce.csv ← 生 CSV (フォールバック、コンテキスト消費大)
 *
 * 通常のフローとしては、CSV を更新したときに
 *   node build-ad-index.js
 * を手動実行して combined-index.txt を再生成しておく。
 */

import fs from 'fs/promises';
import path from 'path';

export const createAdLoader = (adsDir) => {
  const loadAllAds = async () => {
    // 1. combined-index.txt が存在すればそれを返す (最も効率的)
    try {
      const txt = await fs.readFile(path.join(adsDir, 'combined-index.txt'), 'utf-8');
      console.log('[AdLoader] combined-index.txt を読み込みました');
      return txt;
    } catch {
      // なければ次へ
    }

    // 2. JSON インデックスが存在する場合は結合して返す
    const sections = [];
    for (const { file, label } of [
      { file: 'a8-index.json', label: 'a8.net' },
      { file: 'valuecommerce-index.json', label: 'バリューコマース' },
    ]) {
      try {
        const raw = await fs.readFile(path.join(adsDir, file), 'utf-8');
        const ads = JSON.parse(raw);
        const lines = [`## ${label}`];
        for (const ad of ads) {
          lines.push(`- ${ad.programName}`);
          if (ad.reward) lines.push(`  報酬: ${ad.reward}`);
          if (ad.description) lines.push(`  概要: ${ad.description}`);
        }
        sections.push(lines.join('\n'));
        console.log(`[AdLoader] ${file} を読み込みました (${ads.length} 件)`);
      } catch {
        // なければスキップ
      }
    }

    if (sections.length > 0) {
      return `# 利用可能な提携広告\n\n${sections.join('\n\n')}`;
    }

    // 3. 生 CSV のフォールバック (各 3000 文字に切り詰め)
    console.warn('[AdLoader] インデックスファイルが見つかりません。build-ad-index.js を先に実行することを推奨します。');
    const rawSections = [];
    for (const file of ['a8.csv', 'valuecommerce.csv']) {
      try {
        const raw = await fs.readFile(path.join(adsDir, file), 'utf-8');
        const truncated = raw.length > 3000 ? raw.slice(0, 3000) + '\n...[省略]' : raw;
        rawSections.push(`=== ${file} ===\n${truncated}`);
      } catch {
        // なければスキップ
      }
    }

    if (rawSections.length === 0) {
      return '(広告ファイルが見つかりません。available-ads/ に CSV を置いて build-ad-index.js を実行してください)';
    }
    return rawSections.join('\n\n');
  };

  /**
   * ジャンルリストのキーワードで広告をフィルタリングし、
   * マッチした広告のタイトルのみのリストを返す。
   *
   * マッチング戦略:
   * 1. ジャンル名のトークン（単語）を広告のプログラム名・概要・カテゴリと照合
   * 2. 1件もマッチしなかった場合はすべての広告タイトルを返す（フォールバック）
   *
   * @param {string[]} genres - Step1 で抽出したジャンルリスト
   * @returns {Promise<string>} マッチした広告タイトルの箇条書きテキスト
   */
  const filterAdsByGenres = async (genres) => {
    // ads-data.json が存在すればそれを使う
    let allAds;
    try {
      const raw = await fs.readFile(path.join(adsDir, 'ads-data.json'), 'utf-8');
      allAds = JSON.parse(raw);
    } catch {
      // なければ combined-index.txt をそのまま返す (フォールバック)
      console.warn('[AdLoader] ads-data.json が見つかりません。build-ad-index.js を実行してください。');
      return loadAllAds();
    }

    if (genres.length === 0) {
      return buildTitleList(allAds);
    }

    // ジャンル名を単語に分解してマッチングトークンを作る
    // 例: "ポケモンカードゲーム" → ["ポケモン", "カード", "ゲーム"]
    const tokens = genres
      .flatMap(g => g.split(/[\s,，・\/]+/))
      .map(t => t.toLowerCase().trim())
      .filter(t => t.length >= 2);
    const tokenSet = [...new Set(tokens)];

    const matched = allAds.filter(ad => {
      const haystack = [
        ad.programName ?? '',
        ad.description ?? '',
        ad.category ?? '',
        ad.advertiserName ?? '',
      ].join(' ').toLowerCase();

      // 方向1: ジャンルトークンが広告テキストに含まれる
      const forwardMatch = tokenSet.some(token => haystack.includes(token));
      if (forwardMatch) return true;

      // 方向2: 広告テキストの単語がジャンル文字列に含まれる (日本語複合語対策)
      const adWords = haystack
        .split(/\s+/)
        .map(w => w.replace(/[\[\]【】（）()]/g, ''))
        .filter(w => w.length >= 2);
      const genreText = genres.join(' ').toLowerCase();
      return adWords.some(w => genreText.includes(w));
    });

    // マッチ件数をログ
    console.log(`[AdLoader] フィルタ: ${allAds.length} 件 → ${matched.length} 件 (トークン: ${tokenSet.slice(0, 5).join(', ')}...)`);

    // 1件もマッチしなかった場合は空配列 (無関係な広告を無理に返さない)
    return matched;
  };

  /** 広告タイトルのみの箇条書きテキストを生成 */
  const buildTitleList = (ads) => {
    const byCategory = {};
    for (const ad of ads) {
      const cat = ad.category || 'その他';
      (byCategory[cat] ??= []).push(ad);
    }
    const lines = [`# 関連提携広告 (${ads.length} 件)`];
    for (const [cat, catAds] of Object.entries(byCategory)) {
      lines.push(`## ${cat}`);
      for (const ad of catAds) {
        const reward = ad.reward ? ` [${ad.reward}]` : '';
        lines.push(`- [${ad.source}] ${ad.programName}${reward}`);
      }
    }
    return lines.join('\n');
  };

  return { loadAllAds, filterAdsByGenres };
};
