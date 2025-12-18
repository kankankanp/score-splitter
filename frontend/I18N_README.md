# 多言語化実装

このプロジェクトは英語と日本語の両方をサポートしています。

## URL構造

- 英語版: `http://localhost:5173/` (デフォルト)
- 日本語版: `http://localhost:5173/ja/`

### ページ

- メインページ（トリミング）: `/` または `/ja/`
- 練習モード: `/practice` または `/ja/practice`

## 実装詳細

### ルーティング

`src/App.tsx`では以下のルートが定義されています：

```tsx
// 英語ルート
<Route path="/" element={<TrimEditor />} />
<Route path="/practice" element={<PracticePage />} />

// 日本語ルート  
<Route path="/ja" element={<TrimEditor />} />
<Route path="/ja/practice" element={<PracticePage />} />
```

### 言語切り替え

`src/hooks/useLanguage.ts`フックが言語切り替えとナビゲーションを管理します：

- `currentLanguage`: 現在の言語を取得
- `changeLanguage(lang)`: 言語を変更してURLを更新
- `navigateWithLanguage(path)`: 現在の言語プレフィックスを保持してナビゲート

### 翻訳ファイル

- `src/i18n/locales/en.json`: 英語翻訳
- `src/i18n/locales/ja.json`: 日本語翻訳

### コンポーネント

- `src/components/LanguageSwitcher.tsx`: 言語切り替えボタン
- 各コンポーネントで`useTranslation()`フックを使用してテキストを翻訳

## 新しい翻訳の追加

1. `src/i18n/locales/en.json`と`src/i18n/locales/ja.json`にキーを追加
2. コンポーネントで`t('your.key')`を使用
3. パラメータを使用する場合: `t('key', { param: value })`

## テスト

```bash
# i18n設定のテスト
node test-i18n.cjs

# アプリケーションの起動
npm run dev
```

## 注意事項

- 新しい言語を追加する場合は、`src/i18n/index.ts`の`resources`に追加
- URL構造を変更する場合は、`useLanguage`フックも更新する必要があります
- すべてのハードコードされたテキストを翻訳関数に置き換えました