# 作りの地図

```
画面 (public/)  台帳を持ち、発言と一緒に送る
  ↓
サーバー (src/server.mjs)  回数制限、台帳の形の検査
  ↓
Claude (src/claude.mjs, src/prompt.mjs)  発言を分け、カードと結ぶ
  ↓
仕組み (src/engine.mjs)  訂正で外れる比較を計算する
  ↓
検査 (src/guard.mjs)  根拠の外、言い切りを止める。駄目なら「該当動画なし」
```

## 直す場所

| やりたいこと | 直す場所 |
|---|---|
| 記録を増やす | `data/cards.json`。手順は `.claude/skills/card-from-video/` |
| 言語を増やす | `public/i18n.js` に1言語足す。`src/config.mjs` の `STOP_REPLY`、`src/guard.mjs` の言い切りの文も足す |
| 車種を増やす | カードを足す。確かめた整備士の名前を項目に足す |
| モデルや上限を変える | `src/config.mjs`（環境変数でも変えられる） |
| Claudeへの指示を変える | `src/prompt.mjs`。変えたら比較をやり直す |

## 守ること

- 判断の連動はプログラムで行い、Claudeに任せない。
- `human_check` が `approved` のカードだけを公開する。
- `private/` は公開しない。メーカーの資料を入れない。
