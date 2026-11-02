---
name: card-from-video
description: 大谷の動画の字幕から、見立てが変わった場面を記録カードにする。新しい動画をカードにする時に使う。
---

# 動画から記録カードを作る

1. 字幕を `private/transcripts/` に置く（`tools/read_srt.mjs`）。全文は公開しない。
2. 「大丈夫と思った」「〜のせいだと思った」場面と、それが覆った、または言い切れなかった場面を探す。見立てどおりだった例も残す。
3. `data/cards.json` に足す。`human_check` は必ず `pending` にする。
4. `cannot_say` に、字幕から言えないことを書く。部品名や原因を補わない。
5. `node tools/check_cards.mjs` で時刻の実在を確かめる。
6. 大谷が映像で確かめ、`owner_note` に本人の言葉を書いてから `approved` にする。

メーカーの資料、相場、一般論をカードに入れない。お客さんの名前とナンバーを入れない。
