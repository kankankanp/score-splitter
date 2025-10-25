#!/bin/bash

# Score Splitter 動画生成機能テスト用スクリプト

echo "=== Score Splitter 動画生成機能テスト ==="

# 必要なツールの確認
echo "1. 必要なツールの確認..."

# FFmpeg確認
if command -v ffmpeg >/dev/null 2>&1; then
    echo "✓ FFmpeg: $(ffmpeg -version | head -n1)"
else
    echo "✗ FFmpeg が見つかりません。インストールしてください。"
    echo "  macOS: brew install ffmpeg"
    echo "  Ubuntu: sudo apt install ffmpeg"
    exit 1
fi

# ImageMagick確認
if command -v convert >/dev/null 2>&1; then
    echo "✓ ImageMagick: $(convert -version | head -n1)"
    HAS_IMAGEMAGICK=true
elif command -v pdftoppm >/dev/null 2>&1; then
    echo "✓ Poppler: $(pdftoppm -h | head -n1)"
    HAS_IMAGEMAGICK=false
else
    echo "✗ ImageMagickまたはpoppler-utilsが見つかりません。"
    echo "  macOS: brew install imagemagick または brew install poppler"
    echo "  Ubuntu: sudo apt install imagemagick または sudo apt install poppler-utils"
    exit 1
fi

# Go確認
if command -v go >/dev/null 2>&1; then
    echo "✓ Go: $(go version)"
else
    echo "✗ Go が見つかりません。"
    exit 1
fi

# Node.js確認
if command -v node >/dev/null 2>&1; then
    echo "✓ Node.js: $(node --version)"
else
    echo "✗ Node.js が見つかりません。"
    exit 1
fi

echo ""

# バックエンドビルド
echo "2. バックエンドビルド..."
cd backend
if go build -o main .; then
    echo "✓ バックエンドビルド成功"
else
    echo "✗ バックエンドビルドに失敗しました"
    exit 1
fi
cd ..

echo ""

# フロントエンドビルド
echo "3. フロントエンドビルド..."
cd frontend
if npm run build >/dev/null 2>&1; then
    echo "✓ フロントエンドビルド成功"
else
    echo "✗ フロントエンドビルドに失敗しました"
    exit 1
fi
cd ..

echo ""

# サーバー起動（バックグラウンド）
echo "4. バックエンドサーバー起動..."
cd backend
./main &
BACKEND_PID=$!
cd ..

# サーバーが起動するまで待機
sleep 3

# サーバーの起動確認
if curl -s http://localhost:8085 >/dev/null 2>&1; then
    echo "✓ バックエンドサーバー起動確認"
else
    echo "✗ バックエンドサーバーの起動に失敗しました"
    kill $BACKEND_PID 2>/dev/null
    exit 1
fi

echo ""

# フロントエンド開発サーバー起動案内
echo "5. 完了！"
echo ""
echo "動画生成機能をテストするには："
echo "1. 新しいターミナルで以下を実行："
echo "   cd frontend && npm run dev"
echo ""
echo "2. ブラウザで http://localhost:5173 を開く"
echo ""
echo "3. PDFファイルをアップロードしてトリミング"
echo ""
echo "4. 練習モードで動画生成ボタンをクリック"
echo ""
echo "バックエンドサーバーを停止するには："
echo "   kill $BACKEND_PID"
echo ""
echo "または Ctrl+C でこのスクリプトを終了してください。"

# サーバーが停止されるまで待機
wait $BACKEND_PID