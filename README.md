# Score Splitter

楽譜分割・動画生成アプリケーション

## 🚀 クイックスタート

### 必要な環境
- Node.js (18+)
- Go (1.24+)
- Docker & Docker Compose

### 初期セットアップ
```bash
# プロジェクトをクローン
git clone [repository-url]
cd score-splitter

# 依存関係のチェックとインストール
make setup
```

### 開発環境の起動
```bash
# フロントエンドとバックエンドを同時に起動
make dev
```

アクセス:
- フロントエンド: http://localhost:5173
- バックエンド: http://localhost:8085
- バックエンドヘルスチェック: http://localhost:8085/health

## 📋 利用可能なコマンド

### 基本操作
```bash
make help          # 利用可能なコマンド一覧
make dev           # 開発環境を起動
make status        # サービス状態を確認
make stop          # 全サービスを停止
```

### 個別操作
```bash
make dev-frontend  # フロントエンドのみ起動
make dev-backend   # バックエンドのみ起動（Docker）
make docker-dev    # バックエンドをDockerで起動
```

### ビルド・テスト
```bash
make build         # 全体をビルド
make test          # テストを実行
make lint          # コードチェック
```

### メンテナンス
```bash
make clean         # ビルド成果物を削除
make reset         # プロジェクトをリセット
make update        # 依存関係を更新
```

## 🏗️ プロジェクト構成

```
score-splitter/
├── frontend/           # React + Vite フロントエンド
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── backend/            # Go バックエンド
│   ├── docker/         # Docker設定
│   ├── main.go
│   └── go.mod
├── Makefile           # プロジェクト管理用
└── README.md
```

## 🔧 開発について

### フロントエンド
- **フレームワーク**: React 19 + TypeScript
- **ビルドツール**: Vite
- **開発サーバー**: http://localhost:5173

### バックエンド
- **言語**: Go 1.24
- **ポート**: 8085
- **Docker**: 開発環境ではDocker Composeを使用

### API
- **プロトコル**: Connect RPC
- **エンドポイント**: `/score.ScoreService/*`

## 🐳 Docker を使った開発

バックエンドはDockerコンテナで動作し、ホットリロード機能付きです：

```bash
# Docker環境のみでバックエンドを起動
make docker-dev

# ログを確認
make logs

# Docker環境をクリーンアップ
make docker-clean
```

## 🚀 本番デプロイ

```bash
# 本番用ビルド
make prod-build

# 本番用Dockerイメージの確認
docker images | grep score-splitter-backend
```

## 🛠️ トラブルシューティング

### 依存関係エラー
```bash
make check-deps  # 必要なツールを確認
make reset       # プロジェクトをリセット
```

### ポート競合
- フロントエンド: 5173ポートが使用中の場合、Viteが自動的に別ポートを使用
- バックエンド: 8085ポートを確認 `lsof -i :8085`

### Docker関連
```bash
make docker-clean  # Dockerリソースをクリーンアップ
docker system prune -f  # 不要なDockerデータを削除
```

## 📝 開発フロー

1. **開発開始**
   ```bash
   make dev
   ```

2. **コード変更**
   - フロントエンド: 自動リロード
   - バックエンド: 自動リビルド・リスタート

3. **テスト・品質チェック**
   ```bash
   make lint
   make test
   ```

4. **コミット前**
   ```bash
   make clean
   make build  # ビルドエラーチェック
   ```

## 💡 Tips

- `make help` で全コマンドを確認
- `make status` でサービス状態を素早く確認
- 開発中は `make logs` でバックエンドログを監視
- `Ctrl+C` で開発サーバーを停止後、`make stop` で確実にクリーンアップ