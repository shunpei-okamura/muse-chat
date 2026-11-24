# 呼び鈴（v4.15）の反映手順

反映はGitHub Actionsで自動化しています。最初に1回だけ設定をすれば、その後は**ファイルをGitHubの `main` に入れるだけで自動的に反映**されます。反映のたびにAIを使う必要はありません。

反映するタイミングは、しゅんぺいさんが決めてください（引き継ぎ文のルールでは、2026-11-29 20:09まではデプロイしない）。

---

## 1. 最初の1回だけの準備（ブラウザ操作・AI不要・目安20分）

### Cloudflare
1. Cloudflareのアカウントを作る（無料プラン）
2. 「Workers & Pages」を開き、初回に聞かれる workers.dev のサブドメインを決める（例：`shunpei`）。呼び鈴のURLは `https://muse-bell.<サブドメイン>.workers.dev` になる
3. 同じ画面の右側にある「アカウントID」を控える
4. 右上のアイコン →「My Profile」→「API Tokens」→「Create Token」→ テンプレート「Edit Cloudflare Workers」を選び、自分のアカウントを指定して作成する。表示されたトークンを控える（一度しか表示されない）

### 合言葉（BELL_SECRET）を決める
- 推測されにくい長い文字列にする（パスワード生成機能で40文字程度）
- GitHubとRenderの両方に、同じ値を入れる。チャットやファイルには書かない

### GitHub（リポジトリの Settings →「Secrets and variables」→「Actions」→「New repository secret」）
| 名前 | 値 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上で作ったAPIトークン |
| `CLOUDFLARE_ACCOUNT_ID` | アカウントID |
| `BELL_SECRET` | 合言葉 |
| `RENDER_DEPLOY_HOOK` | 下のRenderで取るDeploy HookのURL |

### Render（サービス `muse-chat`）
1. 「Settings」→「Deploy Hook」のURLをコピーし、GitHubの `RENDER_DEPLOY_HOOK` に入れる
2. 「Environment」に次の2つを追加する。保存方法を聞かれたら「保存のみ」を選ぶ（反映は次の手順で行う）
   - `BELL_URL`：`https://muse-bell.<サブドメイン>.workers.dev`
   - `BELL_SECRET`：合言葉

---

## 2. ファイルをGitHubに入れる（＝反映）

入れるファイルは次のとおりです（配布したzipと同じ構成）。

```
server.js
.gitignore
.github/workflows/deploy-bell.yml
.github/workflows/deploy-render.yml
bell/package.json
bell/package-lock.json
bell/wrangler.toml
bell/src/index.js
bell/tools/bell_listener.py
bell/PROTOCOL.md
bell/DEPLOY.md
```

**PCのブラウザで入れる場合**
1. GitHubのリポジトリで「Add file」→「Upload files」を開く
2. zipを展開したフォルダから、`server.js`・`.gitignore`・`bell` フォルダをドラッグし、「Commit changes」で `main` に入れる
3. `.github` は隠しフォルダで見えないことがあります。その場合は「Add file」→「Create new file」で、名前欄に `.github/workflows/deploy-bell.yml` と入力して中身を貼り付け、もう1つの `deploy-render.yml` も同じように作る

**Claude Codeが使える場合**
「このzipの中身を main にコミットしてpushして」とだけ伝えます。コードは完成済みなので、短いやり取りで済みます。

`main` に入ると、GitHubの「Actions」タブで `deploy-bell` と `deploy-render` が自動で動きます。呼び鈴の配備に1〜2分、Renderの反映に数分かかります。

---

## 3. 確認（AI不要）

| 確認先 | 期待する結果 |
| --- | --- |
| GitHubの「Actions」タブ | `deploy-bell` と `deploy-render` が緑（成功） |
| `https://muse-bell.<サブドメイン>.workers.dev/health` | `{"ok":true, ...}` |
| `https://muse-chat.onrender.com/api/health` | `bell.enabled` が `true`。アプリで1回投稿すると `bell.sent` が増え、`bell.lastError` が `null` |

---

## 4. カピおへ渡すもの

`bell/PROTOCOL.md` を渡し、カピお1席で試験を始めてもらいます（旧来のSSEは予備として残す）。

---

## 5. 元に戻す方法

- Renderの「Environment」から `BELL_URL` を消して保存・反映すると、呼び鈴への送信が止まり、v4.14と同じ動きに戻ります
- その場合は、カピおのリスナーも旧来のSSEに戻してもらいます

---

## 6. 今後の更新

`server.js` や `bell/` を直したら、`main` に入れるだけで自動的に反映されます。手動実行したい時は、GitHubの「Actions」タブで各ワークフローの「Run workflow」を押します。
