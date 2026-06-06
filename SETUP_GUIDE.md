# 🚀 GitHub Profile セットアップガイド

このガイドに従って、プロフィール README を有効にしてください。

---

## ✅ チェックリスト

### 1. プロフィール用リポジトリを作成する

GitHub で **自分のユーザー名と同名のリポジトリ** を作成すると、プロフィールページに README が表示されます。

1. [https://github.com/new](https://github.com/new) にアクセス
2. **Repository name** に `Yuyanz9` と入力
3. **Public** を選択
4. 「Add a README file」は **チェックしない**（このリポジトリの README.md を push するため）
5. **Create repository** をクリック
6. このフォルダの内容を push する：

```bash
cd /path/to/this/folder
git init
git remote add origin https://github.com/Yuyanz9/Yuyanz9.git
git add .
git commit -m "Initial profile README"
git branch -M main
git push -u origin main
```

---

### 2. 必要ならアカウント名を調整する

このリポジトリは `yuyanz` / `Yuyanz9` 前提で設定済みです。fork して使う場合だけ、以下を自分のアカウント名に合わせて変更してください。

| 現在値 | 用途 | 変更箇所 |
|---|---|---|
| `yuyanz_` | X (Twitter) のユーザー名 | `README.md` の Connect セクション |
| `yuyanz` | Qiita のユーザー名 | `README.md` / `.github/workflows/connpass-events.yml` |
| `yuyanz` | Docswell のユーザー名 | `.github/workflows/connpass-events.yml` |
| `yonayona` | 管理対象 connpass グループのサブドメイン | `.github/workflows/connpass-events.yml` |

---

### 3. Qiita RSS フィードを確認する

GitHub Actions の週次ワークフローで Qiita の記事を自動取得しています。

1. ブラウザで `https://qiita.com/あなたのQiitaユーザー名/feed` にアクセスし、XML が返ってくることを確認
2. `.github/workflows/connpass-events.yml` 内の `QIITA_USERNAME` を実際の Qiita ユーザー名に変更

```yaml
QIITA_USERNAME: yuyanz
#               ^^^^^^ ここを変更
```

---

### 4. connpass API / Docswell を設定する

Activity セクションは GitHub Actions から connpass API v2 と Docswell の RSS feed を参照して、週1で自動更新します。connpass では **指定したグループ（例: YonaYonaAzure Club）が管理しているイベント** を取得し、それ以外の登壇情報は **Docswell にアップした資料に含まれる connpass イベント URL** を起点に反映されます。

1. connpass で API 利用申請を行い、API キーを取得する
2. GitHub リポジトリの **Settings** → **Secrets and variables** → **Actions** に移動する
3. **New repository secret** で `CONNPASS_API_KEY` を追加する
4. YonaYonaAzure Club 以外のコミュニティを管理対象にしたい場合は、`.github/workflows/connpass-events.yml` 内の `CONNPASS_MANAGED_SUBDOMAIN` をその connpass サブドメインに変更する
5. `.github/workflows/connpass-events.yml` 内の `DOCSWELL_USERNAME` を、自分が登壇資料を公開している Docswell ユーザー名に変更する
6. 外部コミュニティでの登壇を README に載せたい場合は、Docswell の資料本文または説明文に対象 connpass イベントの URL を含める

> ワークフローは毎週月曜 0:00 UTC（日本時間 9:00）に実行されます。

---

### 5. GitHub Actions の権限を設定する

週次プロフィール更新ワークフローが README を更新（コミット・プッシュ）するために、書き込み権限が必要です。

1. リポジトリの **Settings** → **Actions** → **General** に移動
2. **Workflow permissions** セクションで **Read and write permissions** を選択
3. **Save** をクリック

---

### 6. ワークフローを初回実行する

1. リポジトリの **Actions** タブに移動
2. 左サイドバーから「**Weekly profile refresh workflow**」を選択
3. **Run workflow** → **Run workflow** をクリック
4. 完了後、README.md の `BLOG-POST-LIST`、`CONNPASS-UPCOMING`、`CONNPASS-ARCHIVE` セクションが更新されていることを確認

> 以降は毎週月曜 0:00 UTC（日本時間 9:00）に自動実行されます。

---

## 🎨 カスタマイズ（オプション）

### GitHub Stats カードのテーマ変更

README.md 内の `theme=dark` を以下のいずれかに変更できます：

| テーマ | 雰囲気 |
|--------|--------|
| `dark` | 黒基調（現在の設定） |
| `onedark` | やや暖かい黒 |
| `dracula` | 紫がかった黒 |
| `tokyonight` | 青みがかった黒 |
| `transparent` | 背景透過（GitHub のテーマに追従） |

全テーマ一覧: [github-readme-stats themes](https://github.com/anuraghazra/github-readme-stats/blob/master/themes/README.md)

### Tech Stack バッジの追加・削除

`### 🛠️ Tech Stack` セクション内の `<img>` タグを追加・削除してバッジを変更できます。

バッジの生成: [shields.io](https://shields.io/) で `https://img.shields.io/badge/ラベル-色?style=flat-square&logo=ロゴ名&logoColor=white` の形式で作成。

利用可能なロゴ一覧: [Simple Icons](https://simpleicons.org/)

### プロフィールビューカウンターを非表示にする

README.md 最下部の以下の行を削除すると非表示になります：

```html
<p align="center">
  <img src="https://komarev.com/ghpvc/..." alt="Profile Views" />
</p>
```

---

## ❓ トラブルシューティング

| 問題 | 対処 |
|------|------|
| Stats カードが表示されない | `Yuyanz9` がパブリックプロフィールか確認。プライベートリポジトリの統計は反映されません |
| ブログ記事やイベント情報が更新されない | Actions タブで `Weekly profile refresh workflow` のエラー有無を確認。`CONNPASS_API_KEY` と Workflow permissions を再確認 |
| バッジ画像が壊れて表示される | URL のスペースは `%20` にエンコードされているか確認 |
| typing-svg が表示されない | [readme-typing-svg.demolab.com](https://readme-typing-svg.demolab.com) が稼働中か確認（外部サービス依存） |
