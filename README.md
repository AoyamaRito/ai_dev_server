# ai-dev-server

> AIコーダーのためのゼロ依存デバッグサーバー

## 3行で

- ブラウザエラーを自動収集
- エラー時のHTML状態を保存
- AIが `tail error.log` で即把握

## 問題

AIコーダーはブラウザが見えない:
- エラーが起きても「何が起きた？」と聞くしかない
- 人間がスクショを貼る往復が発生
- デバッグループが遅い

## 解決

エラーとその瞬間の画面を自動保存:

```
ブラウザ → エラー発生 → 自動でログ + スナップショット
    ↓
AI: tail -1 error.log で確認
AI: head snapshots/snapshot_*.html で画面状態確認
AI: 修正
```

人間の介在なし。

## インストール

```bash
# 依存なし、Node.jsのみ
node ai_dev_server.js
```

## 使い方

### 1. サーバー起動

```bash
node ai_dev_server.js
# → http://localhost:3000
```

### 2. HTMLにスニペット追加

```html
<script>
(function(){
  const S='http://localhost:3000';
  window.onerror=(m,s,l,c,e)=>{
    fetch(S+'/error',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'error',message:m,source:s,line:l,stack:e?.stack||''})});
    fetch(S+'/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({html:document.body.innerHTML,error:m,url:location.href})});
  };
})();
</script>
```

### 3. AIがエラー確認

```bash
# 最新エラー（トークン効率）
tail -1 error.log

# スナップショット一覧
ls snapshots/

# スナップショット確認
head snapshots/snapshot_*.html
```

## エンドポイント

| メソッド | パス | 説明 |
|----------|------|------|
| POST | `/error` | エラーログ記録 |
| POST | `/snapshot` | HTMLスナップショット保存 |
| POST | `/snapshot/request?label=xxx` | E2Eからスナップショット要求 |
| GET | `/log` | 全エラー取得 (JSON) |
| DELETE | `/log` | ログクリア |
| GET | `/snapshots` | スナップショット一覧 |
| GET | `/snapshots/:file` | スナップショット表示 |
| GET | `/status` | サーバー状態 |

## オプション

```bash
node ai_dev_server.js --help   # ヘルプ
node ai_dev_server.js --test   # E2Eテスト (20テスト)
node ai_dev_server.js --kill   # ポート競合時に強制起動
```

## 環境変数

| 変数 | デフォルト | 説明 |
|------|------------|------|
| PORT | 3000 | サーバーポート |
| LOG_FILE | error.log | ログファイル |
| STATIC_DIR | . | 静的ファイルディレクトリ |
| SNAPSHOT_DIR | ./snapshots | スナップショット保存先 |

## AI向け vs 人間向け

```bash
# AI向け（トークン効率）
tail -1 error.log
ls snapshots/

# 人間向け（フルJSON）
curl localhost:3000/log
curl localhost:3000/snapshots
```

## 機能

- **重複エラー抑制**: 5秒以内の同一エラーは集約
- **自動ポート切り替え**: 使用中なら次のポートを試行
- **E2Eスナップショット**: `curl -X POST '/snapshot/request?label=step1'`

## E2Eテストから使う

```bash
# テストコード内でスナップショット要求
curl -X POST 'localhost:3000/snapshot/request?label=after_login'
# → ブラウザが自動でスナップショット取得、完了まで待機
```

## テスト

```bash
node ai_dev_server.js --test
# → 20テスト実行
```

## ライセンス

MIT
