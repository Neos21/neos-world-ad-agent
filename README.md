# Neo's World 広告改善 AI エージェント

Neo's World (https://neos21.net) の広告収益改善を支援するローカル AI エージェント。

`src/pages/` 配下のページを読み、利用可能な提携広告リストと照合して「どのページに何の広告を貼ると良いか」を `memo/idea/` に出力する。


## 前提

- Node.js (ESM対応、v18以上推奨)
- [Ollama](https://ollama.com/) がインストール済みであること (サーバー未起動でも自動起動する)
- デフォルトモデル : `qwen3.5:9b` (`index.js` にて定義)


## ディレクトリ構成

```
/github/neos21.net/
├── src/pages/               ← サイトのページデータ (読み取り専用)
└── memo/
    ├── package.json
    ├── available-ads/       ← 広告リスト置き場
    │   ├── a8.csv               ← a8.net からエクスポートした CSV
    │   ├── valuecommerce.csv    ← バリューコマースからエクスポートした CSV
    │   ├── a8-index.json        ← build-ad-index.js が生成 (自動)
    │   ├── valuecommerce-index.json  ← 同上
    │   └── combined-index.txt   ← Ollama に渡す整形済みテキスト (自動)
    ├── agent/               ← このエージェントのプログラム
    │   ├── index.js             ← エントリポイント・オーケストレータ
    │   ├── build-ad-index.js    ← CSV → 整形済みインデックスの変換ツール
    │   ├── session.js           ← セッション状態の読み書き
    │   ├── file-tracker.js      ← ページファイルの追加・変更・状態を追跡
    │   ├── page-reader.js       ← src/pages/ のスキャンと読み込み
    │   ├── ad-loader.js         ← available-ads/ の広告情報ロード
    │   ├── ollama-client.js     ← Ollama API クライアント (自動起動対応)
    │   ├── prompts.js           ← Ollama に送るプロンプトのテンプレート
    │   ├── reporter.js          ← idea/ への出力・history/ へのログ追記
    ├── history/             ← 作業ログ (自動生成)
    │   ├── session-state.json   ← ファイル状態・キュー (自動生成・更新)
    │   └── YYYY-MM-DD.md        ← 日次ログ (自動生成・追記)
    └── idea/                ← AI の提案出力先 (自動生成)
        ├── index.md             ← 改善推奨ページの一覧表
        ├── blog/2024/...        ← 改善推奨ページ (src/pages/ と同じ階層)
        └── done/
            └── blog/2024/...    ← 現状維持ページ (src/pages/ と同じ階層)
```


## セットアップ (初回のみ)

```bash
$ cd /github/neos21.net/memo/agent/

# 1. a8.net・バリューコマースの管理画面から CSV をエクスポートして配置
#    memo/available-ads/a8.csv
#    memo/available-ads/valuecommerce.csv

# 2. CSV を AI が読みやすい形に変換する (約93%圧縮)
$ node build-ad-index.js
# → combined-index.txt が生成される

# 3. エージェントを起動
$ node index.js
```


## 日常の使い方

```bash
# 通常起動 (起動するたびに新規・更新ファイルを自動検知して処理)
$ node index.js

# 今日は10ページだけ処理して止まる
$ node index.js --limit 10

# 現在の進捗を確認 (Ollama 不要)
$ node index.js --status

# fileIndex をリセットして全ページ再処理 (広告リストを大幅に更新したときなど)
$ node index.js --reset

# history/ と idea/ の中身を全削除して .gitkeep だけ残す
$ node index.js --clean
```

## ファイルの追加・変更への対応

エージェントは起動するたびに `src/pages/` を全スキャンして変化を自動検知する。

| ケース                                    | エージェントの動作                                   |
|-------------------------------------------|------------------------------------------------------|
| 新しいページを追加した                    | 次回起動時に自動で処理キューに追加される             |
| ページを更新した (`last-modified` を変更) | 次回起動時に再分析対象として自動でキューに追加される |
| ページを削除した                          | fileIndex には残るが処理対象にはならない (無害)      |

## 修正済みページを AI に伝える方法

AI の提案を見て実際に広告を貼ったり、「このページは対応不要」と判断したりしたら、`idea/` 配下の対応 `.md` ファイルの先頭付近に1行追記する。

```markdown
status: applied
# 広告提案: blog/2024/01/article.md
...
```

| 値                | 意味                                  | 次回起動時の動作                     |
|-------------------|---------------------------------------|--------------------------------------|
| `status: applied` | 広告を掲載した                        | ページが更新されるまで再処理されない |
| `status: done`    | 改善不要・現状維持と判断 (手動上書き) | 同上                                 |

> **現状維持ページの自動フラグについて**
> AI が「現状維持でよい」と判断したページは自動的に `idea/done/` 配下に出力され、
> `fileIndex` のステータスも `done` になる。追記作業は不要。
> ただし AI 判定を覆して「やはり改善したい」と思ったら、`idea/done/` の該当ファイルに
> `status: applied` を追記すれば次回起動時に `analyzed` として扱われる。

`last-modified` が変わったページは `applied` / `done` に関わらず自動的に再分析される。


## 実行時のコンソール出力

```
────────────────────────────────────────────────────────────
 Ollama 起動確認
────────────────────────────────────────────────────────────
[Ollama] サーバーは起動済みです。
[Ollama] モデル qwen3.5:9b をロード中...
[Ollama] モデルのロード完了 (2.1秒)

────────────────────────────────────────────────────────────
 ファイルスキャン
────────────────────────────────────────────────────────────
[Scanner] src/pages/ をスキャン中...
  + blog/2026/03/new-article.md   ← 新規ファイル
  ~ blog/2024/01/article.md       ← 更新検知 (再分析対象)
[Queue] 処理対象: 2 ページ

[1/342] blog/2026/03/new-article.md
  タイトル: 新しい記事
  最終更新: 2026-03-23
  プロンプト: 3842 文字
  [完了]   287 tokens | 6.4s | 平均 44.8 t/s
  判定: 改善推奨 | 推奨: ConoHa VPS, ABLENET VPS
  ✓ 保存: memo/idea/blog/2026/03/new-article.md

[2/342] blog/2024/01/old-article.md
  タイトル: 古い日記
  最終更新: 2024-01-10
  プロンプト: 3201 文字
  [完了]   203 tokens | 4.8s | 平均 42.3 t/s
  判定: 現状維持 → idea/done/
  ✓ 保存: memo/idea/done/blog/2024/01/old-article.md
```


## コンテキスト長対策

コンテキスト長が限られる Ollama ローカルモデルへの対策として以下を実施している。

| 問題             | 対処                                                                              |
|------------------|-----------------------------------------------------------------------------------|
| ページ本文が長い | `page-reader.js` で本文を4000文字にトランケート                                   |
| 広告リストが長い | `build-ad-index.js` で必要情報だけ抽出・約93%圧縮して `combined-index.txt` を生成 |
| 会話が長くなる   | 1ページ = 1回の Ollama コールに分割し、会話履歴を持ち越さない                     |
| 中断・クラッシュ | `session-state.json` にキューと状態を都度保存、再起動で自動再開                   |

`ollama-client.js` の `numCtx` はデフォルト `16384`。RTX5070Ti (16GB VRAM) なら余裕で動くが、速度を見て `8192` や `32768` に調整してよい。


## ページのステータス管理

`$ node index.js --status` で確認できる。

```
 ページステータス一覧
────────────────────────────────────────────────────────────
  pending  (未処理・再処理待ち):  3
  analyzed (AI提案済み・未対応): 12
  applied  (広告掲載済み):        8
  done     (改善不要確定):       45
  合計:                           68
```

| ステータス | 意味                                                             |
|------------|------------------------------------------------------------------|
| `pending`  | 未処理、またはページ更新で再分析待ちになった                     |
| `analyzed` | AI が提案を出力済み。`idea/` の `.md` を見て対応を検討する       |
| `applied`  | 広告を掲載した。`idea/*.md` に `status: applied` と記載した状態  |
| `done`     | 改善不要と判断した。`idea/*.md` に `status: done` と記載した状態 |


## Author

[Neo](https://neos21.net/)


## Links

- [Neo's World](https://neos21.net/)
- [Neo's GitHub Pages](https://neos21.github.io/)
