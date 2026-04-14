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

### 2. SNS アカウント名を設定する（README.md を編集）

以下のプレースホルダーを **自分のアカウント名** に置換してください。

| プレースホルダー | 置換先 | 出現箇所 |
|---|---|---|
| `YOUR_X_USERNAME` | X (Twitter) のユーザー名 | Connect セクション |
| `YOUR_QIITA_USERNAME` | Qiita のユーザー名 | About Me セクション + Connect セクション |
| `YOUR_CONNPASS_USERNAME` | connpass のユーザー名 | Connect セクション |

#### 検索＆置換コマンド（例）

エディタで `Ctrl + H` を使って一括置換するか、以下のコマンドで置換：

```bash
# macOS / Linux
sed -i 's/YOUR_X_USERNAME/実際のユーザー名/g' README.md
sed -i 's/YOUR_QIITA_USERNAME/実際のユーザー名/g' README.md
sed -i 's/YOUR_CONNPASS_USERNAME/実際のユーザー名/g' README.md

# Windows (PowerShell)
(Get-Content README.md) -replace 'YOUR_X_USERNAME','実際のユーザー名' | Set-Content README.md
(Get-Content README.md) -replace 'YOUR_QIITA_USERNAME','実際のユーザー名' | Set-Content README.md
(Get-Content README.md) -replace 'YOUR_CONNPASS_USERNAME','実際のユーザー名' | Set-Content README.md
```

---

### 3. Qiita RSS フィードの URL を確認する

GitHub Actions のワークフローで Qiita の記事を自動取得しています。

1. ブラウザで `https://qiita.com/あなたのQiitaユーザー名/feed` にアクセスし、XML が返ってくることを確認
2. `.github/workflows/blog-posts.yml` 内の `YOUR_QIITA_USERNAME` を実際の Qiita ユーザー名に置換

```yaml
feed_list: "https://qiita.com/YOUR_QIITA_USERNAME/feed"
#                          ↑ ここを置換
```

---

### 4. GitHub Actions の権限を設定する

ブログ記事の自動取得ワークフローが README を更新（コミット・プッシュ）するために、書き込み権限が必要です。

1. リポジトリの **Settings** → **Actions** → **General** に移動
2. **Workflow permissions** セクションで **Read and write permissions** を選択
3. **Save** をクリック

---

### 5. ワークフローを初回実行する

1. リポジトリの **Actions** タブに移動
2. 左サイドバーから「**Latest blog post workflow**」を選択
3. **Run workflow** → **Run workflow** をクリック
4. 完了後、README.md の `BLOG-POST-LIST` セクションに Qiita の最新記事が挿入されていることを確認

> 以降は毎日 0:00 UTC（日本時間 9:00）に自動実行されます。

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
| ブログ記事が更新されない | Actions タブでワークフロー実行したエラー有無を確認。権限設定（手順 4）を再確認 |
| バッジ画像が壊れて表示される | URL のスペースは `%20` にエンコードされているか確認 |
| typing-svg が表示されない | [readme-typing-svg.demolab.com](https://readme-typing-svg.demolab.com) が稼働中か確認（外部サービス依存） |
