## TypeScript Reader とは？
TypeScript Reader とは、LLMと一緒にTypeScriptのコードを読むためのツールです。

#### [できること]
- 人がコードを読まずともLLMが関数探索してくれる
- 前に進んだ関数経路に戻れる
- 調べている関数経路のバグをLLMが見つけてくれる
- 調べている関数をLLMが図にしてくれる
- 調べた関数経路をLLMがレポートにしてくれる
- 調べた関数経路をJSONにしてインポート・エクスポートできる

#### [効果]
- TypeScriptコードをランダムウォークなしに読み進められる
- 土地勘がないと10分以上かかる数百行、数千行の関数のコードリーディングを、LLMが1分で終わらせてくれる
- TypeScriptコードのバグを見つけられる機能がある
- 頭にいれるだけで暗黙知になりがちな関数経路や関数の説明をLLMがしてくれる

#### [できないこと/人の作業]
- エントリーポイントの把握
- LLMによる関数自動探索（人が判断した方が正確）
- コードベースを分割せず一括でLLMに調べさせること

## 利用方法

1. typescript-language-serverの準備

```
npm install -g typescript-language-server typescript
# or
brew install typescript-language-server
```

その後、"TypeScript and JavaScript Language Features"を以下の手順でdisableにします（LSPの衝突を避けるため）

https://stackoverflow.com/a/60026235

```
Show All Commands (Ctrl/Cmd + Shift + P) -> Type "Extensions: Show Built-in Extensions" -> Features -> TypeScript and JavaScript Language Features -> Disable (Workspace)
```

2. vscode のインストール

vscode 1.100.0以上のものをインストールしてください

3. TypeScript Reader のインストール

vs code で [download](https://marketplace.visualstudio.com/items?itemName=coffeecupjapan.typescript-reader&ssr=false#overview) してください。

https://marketplace.visualstudio.com/items?itemName=coffeecupjapan.typescript-reader&ssr=false#overview 

4. VS拡張機能を開く

ダウンロードができたら、「コマンドパレットを開き（Command + Shift + P）」、「Open TypeScript Reader Tab」を入力して、右側にタブが出てきたら成功です

5. 設定の入力
typescript-language-serverのパス、LLM（OpenAI・Claude・Plamo・Gemini）を入力

6. チャット画面で探索を開始
最初に、「探索を開始するファイルパス」「探索を開始する関数」「探索の目的」を入力すれば、探索を開始できます。

7. 探索を制御する

探索を開始すると、LLMが現在の関数の中から重要な関数を推薦してくれます。なのであなたはその中から重要そうな次に探索したい関数を選びます。このプロセスはあなたがいいと思うまで続け、探索を続けます。
