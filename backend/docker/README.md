# Score Splitter Backend Docker 設定

このディレクトリには、Score Splitter バックエンドサービス用のDocker設定が含まれています。

## ファイル構成

- `Dockerfile` - 本番環境用のDockerイメージ設定
- `Dockerfile.local` - 開発環境用のDockerイメージ設定（ホットリロード対応）
- `docker-compose.yml` - 開発環境用のDocker Compose設定

## 開発環境での使用方法

### 1. 開発環境でサービスを起動

```bash
cd backend/docker
docker-compose up --build
```

### 2. バックグラウンドで起動する場合

```bash
cd backend/docker
docker-compose up -d --build
```

### 3. ログを確認

```bash
docker-compose logs -f score-splitter-backend
```

### 4. サービスを停止

```bash
docker-compose down
```

### 5. ボリュームも含めて完全に削除

```bash
docker-compose down -v
```

## 本番環境での使用方法

### 1. 本番用イメージをビルド

```bash
cd backend
docker build -f docker/Dockerfile -t score-splitter-backend:latest .
```

### 2. 本番用コンテナを起動

```bash
docker run -d \
  --name score-splitter-backend \
  -p 8085:8085 \
  -v $(pwd)/uploads:/root/uploads \
  score-splitter-backend:latest
```

## 機能

- **ホットリロード**: 開発環境では、ソースコードの変更が自動的にアプリケーションに反映されます
- **ボリュームマウント**: アップロードされたファイルは永続化されます
- **ヘルスチェック**: `http://localhost:8085/health` でサービスの状態を確認できます
- **依存関係管理**: 必要なツール（ImageMagick、poppler-utils、FFmpeg）がすべて含まれています

## 依存関係

このアプリケーションは以下の外部ツールに依存しています：

- **ImageMagick**: PDF→画像変換
- **poppler-utils**: PDFツール（pdftoppmなど）
- **FFmpeg**: 動画生成

これらのツールはDockerイメージに含まれているため、ホストシステムにインストールする必要はありません。

## ポート

- **8085**: アプリケーションのメインポート

## 環境変数

開発環境では以下の環境変数が設定されます：

- `GO_ENV=development`
- `CGO_ENABLED=0`

本番環境では必要に応じて追加の環境変数を設定してください。