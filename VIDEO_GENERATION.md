# 動画生成機能について

## 概要
このプロジェクトに、トリミングした楽譜スコアを設定BPMで横スクロールする動画を生成する機能が追加されました。

## 機能説明
- ユーザーが設定したBPMの速度で楽譜が横にスクロールする動画を生成
- 生成される動画はMP4形式（デフォルト）
- 動画サイズは1920x1080（変更可能）
- フレームレートは30fps（変更可能）

## 必要な外部ツール

### macOS（Homebrew使用）
```bash
# FFmpeg（動画処理）
brew install ffmpeg

# ImageMagick（PDF→画像変換）
brew install imagemagick

# または poppler（pdftoppmを含む）
brew install poppler
```

### Ubuntu/Debian
```bash
# FFmpeg
sudo apt update
sudo apt install ffmpeg

# ImageMagick
sudo apt install imagemagick

# または poppler-utils
sudo apt install poppler-utils
```

### Windows
1. [FFmpeg](https://ffmpeg.org/download.html) をダウンロードして PATH に追加
2. [ImageMagick](https://imagemagick.org/script/download.php#windows) をインストール
3. または [Poppler for Windows](https://blog.alivate.com.au/poppler-windows/) をインストール

## 使用方法

1. 楽譜PDFをアップロードしてトリミング
2. 練習モードでBPMを設定
3. 「動画生成」ボタンをクリック
4. 生成された動画が自動的にダウンロードされます

## 動画生成の仕組み

1. **PDF→画像変換**: トリミング済みPDFの各ページを画像に変換
2. **画像結合**: 全ページを横に結合して1つの長い画像を作成
3. **スクロール動画**: FFmpegを使用してBPMベースの速度でスクロールする動画を生成

### BPMとスクロール速度の関係
- スクロール速度 = (BPM ÷ 60) × 120 ピクセル/秒
- 例: BPM 120 の場合 → (120 ÷ 60) × 120 = 240 ピクセル/秒

## API仕様

### GenerateScrollVideo エンドポイント

**Request:**
```json
{
  "title": "楽譜名",
  "pdfFile": "base64エンコードされたPDFデータ",
  "bpm": 120,
  "videoWidth": 1920,
  "videoHeight": 1080,
  "fps": 30,
  "format": "mp4"
}
```

**Response:**
```json
{
  "message": "動画生成完了メッセージ",
  "videoData": "base64エンコードされた動画データ",
  "filename": "推奨ファイル名",
  "durationSeconds": 動画の長さ（秒）
}
```

## トラブルシューティング

### "FFmpeg not found" エラー
- FFmpegが正しくインストールされていることを確認
- パスが通っていることを確認: `ffmpeg -version`

### "ImageMagick/pdftoppm not found" エラー
- ImageMagickまたはpoppler-utilsがインストールされていることを確認
- パスが通っていることを確認: `convert -version` または `pdftoppm -h`

### 動画生成が失敗する
- PDFファイルが破損していないか確認
- 十分なディスク容量があるか確認
- BPMが30-240の範囲内であることを確認

## 制限事項
- 動画生成は処理が重いため、時間がかかる場合があります
- PDFページ数が多いと動画ファイルサイズが大きくなります
- メモリ使用量が多いため、大きなPDFファイルでは注意が必要です