# 本番環境用Dockerfile
FROM golang:1.24.3-alpine AS builder

# 必要なパッケージをインストール
RUN apk update && apk add --no-cache \
    git \
    ca-certificates \
    tzdata

# ワーキングディレクトリを設定
WORKDIR /app

# Go modulesをコピーして依存関係をダウンロード
COPY go.mod go.sum ./
RUN go mod download

# ソースコードをコピー
COPY . .

# アプリケーションをビルド
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

# 本番用イメージ
FROM alpine:latest

# 必要なランタイム依存関係をインストール
RUN apk update && apk add --no-cache \
    ca-certificates \
    tzdata \
    imagemagick \
    poppler-utils \
    ffmpeg

# ワーキングディレクトリを設定
WORKDIR /root/

# ビルドしたバイナリをコピー
COPY --from=builder /app/main .

# アップロード用ディレクトリを作成
RUN mkdir -p uploads

# ポート8085を公開
EXPOSE 8085

# アプリケーションを実行
CMD ["./main"]