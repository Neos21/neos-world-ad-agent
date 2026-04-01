/**
 * prompts.js
 * 2段階プロンプト:
 *   Step1: 広告リストを見せずにページだけ分析 → テーマ・ジャンル・キーワード確定
 *   Step2: Step1から抽出したジャンルリスト + 広告リストで照合
 *
 * Step1の出力からジャンルリストを正規表現で抽出してStep2に渡すことで、
 * 広告リストの偏りによる誤認識を防ぐ。
 */

/**
 * Step1: ページ分析プロンプト (広告リストなし)
 */
export const buildPageAnalysisPrompt = ({ pageRelPath, meta, existingAds, pageBody }) => {
  const metaLines = [
    meta.title            ? `タイトル: ${meta.title}` : '',
    meta.created          ? `作成日: ${meta.created}` : '',
    meta['last-modified'] ? `最終更新: ${meta['last-modified']}` : '',
    Array.isArray(meta.path) ? `パス階層: ${meta.path.join(' > ')}` : '',
  ].filter(Boolean).join('\n');

  const existingAdsText = existingAds.length > 0
    ? `既存の広告クラス: ${existingAds.join(', ')}`
    : '既存の広告クラス: なし';

  return `
以下のウェブページを読んで、3つの情報を出力してください。

## ページ情報
ファイルパス: ${pageRelPath}
${metaLines}
${existingAdsText}

## ページ本文
\`\`\`
${pageBody}
\`\`\`

## 注意
- HTML タグ・テンプレート構文は無視してテキストの意味だけを読むこと。
- タイトルと本文冒頭がテーマの最重要手がかり。
- ナビゲーションメニューや更新履歴のリストをテーマと混同しないこと。

## 出力形式 (この3項目だけ出力すること)

### 1. ページ概要
テーマ・内容・想定読者を2〜3行で説明してください。

### 2. 読者が興味を持ちそうな商品・サービスのジャンル
箇条書きで5〜10個挙げてください。広告との関連は考慮不要。ページの内容から純粋に考えること。

### 3. 商品検索キーワード
読者が Amazon・楽天で検索しそうなキーワードを5〜10個、カンマ区切りで1行で出力してください。
ページ内容と無関係なキーワードは含めないでください。

出力は日本語・Markdown 形式でお願いします。
`.trim();
};

/**
 * Step1の出力からジャンルリストを抽出する。
 * 「### 2.」セクションの箇条書き行を収集して返す。
 * 抽出できなければ空配列。
 */
export const extractGenres = (step1Result) => {
  const section = step1Result.match(/###\s*2[^\n]*\n([\s\S]*?)(?=###|$)/);
  if (!section) return [];
  return section[1]
    .split('\n')
    .map(l => l.replace(/^[\s*\-・]+/, '').trim())
    .filter(Boolean);
};

/**
 * Step1の出力から商品検索キーワードを抽出する。
 * 「### 3.」セクションの最初の非空行を返す。
 */
export const extractKeywords = (step1Result) => {
  const section = step1Result.match(/###\s*3[^\n]*\n([\s\S]*?)(?=###|$)/);
  if (!section) return '';
  return section[1].split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
};

/**
 * Step2: 広告照合プロンプト
 * Step1から抽出したジャンルリストを使って広告と照合する。
 */
export const buildAdMatchPrompt = ({ genres, adsIndex, existingAds }) => {
  const existingAdsText = existingAds.length > 0
    ? `既存の広告クラス: ${existingAds.join(', ')}`
    : '既存の広告クラス: なし';

  const genreList = genres.length > 0
    ? genres.map(g => `- ${g}`).join('\n')
    : '(ジャンル情報なし)';

  return `
あるウェブページの読者が興味を持ちそうな商品・サービスのジャンルが以下の通りです。

## 読者が興味を持つジャンル
${genreList}

${existingAdsText}

このジャンルに合致する広告を、以下の提携広告一覧から選んでください。

## 利用可能な提携広告一覧
${adsIndex}

## 指示
- 上記のジャンルリストと明確に合致する広告だけを選ぶこと。
- 合致する広告がない場合は「該当なし」としてください。無理に選ばないこと。
- 広告リストの量や種類に引きずられず、ジャンルリストだけを基準に判断すること。

## 出力形式

### 推奨広告 (最大5件、なければ「該当なし」)

- **広告名**: (プログラム名)
- **理由**: 上記のどのジャンルと合っているか (1行)
- **効果予測**: 高 / 中 / 低

### 改善判定
以下のどちらかを明記してください:
- **改善推奨**: 掲載すべき広告またはキーワードリンクがある
- **現状維持でよい**: 広告との相性が低い、または既存広告で十分 (理由も書く)

### 掲載位置の提案
記事冒頭・記事末尾・本文中など、具体的な位置を提案してください。

出力は日本語・Markdown 形式でお願いします。
`.trim();
};
