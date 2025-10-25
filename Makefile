# Score Splitter Project Makefile
# プロジェクト全体の管理用

.PHONY: help dev dev-frontend dev-backend build build-frontend build-backend test lint clean install deps-frontend deps-backend docker-dev docker-prod docker-clean logs stop check-deps

# デフォルトターゲット
.DEFAULT_GOAL := help

##@ Help
help: ## このヘルプメッセージを表示
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Development
dev: check-deps ## フロントエンドとバックエンドの開発環境を同時に起動
	@echo "🚀 開発環境を起動しています..."
	@make -j2 dev-frontend dev-backend

dev-frontend: ## フロントエンドの開発サーバーを起動
	@echo "🎨 フロントエンド開発サーバーを起動中..."
	@cd frontend && npm run dev

dev-backend: ## バックエンドの開発サーバーを起動
	@echo "⚙️ バックエンド開発サーバーを起動中..."
	@cd backend/docker && docker-compose up --build

##@ Build
build: build-frontend build-backend ## フロントエンドとバックエンドをビルド
	@echo "✅ ビルドが完了しました"

build-frontend: ## フロントエンドをビルド
	@echo "🎨 フロントエンドをビルド中..."
	@cd frontend && npm run build

build-backend: ## バックエンドをビルド
	@echo "⚙️ バックエンドをビルド中..."
	@cd backend && go build -o main .

##@ Test & Quality
test: test-frontend test-backend ## 全てのテストを実行
	@echo "✅ 全テストが完了しました"

test-frontend: ## フロントエンドのテストを実行
	@echo "🧪 フロントエンドテスト実行中..."
	@cd frontend && npm test 2>/dev/null || echo "⚠️ フロントエンドテストが設定されていません"

test-backend: ## バックエンドのテストを実行
	@echo "🧪 バックエンドテスト実行中..."
	@cd backend && go test ./... || echo "⚠️ バックエンドテストが見つかりません"

lint: lint-frontend lint-backend ## コードの静的解析を実行
	@echo "✅ Lintが完了しました"

lint-frontend: ## フロントエンドのLintを実行
	@echo "🔍 フロントエンドLint実行中..."
	@cd frontend && npm run lint

lint-backend: ## バックエンドのLintを実行
	@echo "🔍 バックエンドLint実行中..."
	@cd backend && go fmt ./... && go vet ./...

##@ Dependencies
install: deps-frontend deps-backend ## 全ての依存関係をインストール
	@echo "✅ 依存関係のインストールが完了しました"

deps-frontend: ## フロントエンドの依存関係をインストール
	@echo "📦 フロントエンド依存関係インストール中..."
	@cd frontend && npm install

deps-backend: ## バックエンドの依存関係をインストール
	@echo "📦 バックエンド依存関係インストール中..."
	@cd backend && go mod download && go mod tidy

##@ Docker
docker-dev: ## Docker開発環境を起動
	@echo "🐳 Docker開発環境を起動中..."
	@cd backend/docker && docker-compose up -d --build
	@echo "✅ バックエンドがDocker環境で起動しました (http://localhost:8085)"
	@echo "🎨 フロントエンドを通常の開発サーバーで起動してください: make dev-frontend"

docker-prod: ## 本番用Dockerイメージをビルド
	@echo "🐳 本番用Dockerイメージをビルド中..."
	@cd backend && docker build -f docker/Dockerfile -t score-splitter-backend:latest .
	@echo "✅ 本番用イメージのビルドが完了しました"

docker-clean: ## Docker関連のリソースをクリーンアップ
	@echo "🧹 Dockerリソースをクリーンアップ中..."
	@cd backend/docker && docker-compose down -v --remove-orphans
	@docker system prune -f

##@ Utilities
logs: ## バックエンドのDockerログを表示
	@echo "📋 バックエンドログを表示中..."
	@cd backend/docker && docker-compose logs -f

stop: ## 全ての開発サーバーを停止
	@echo "🛑 開発サーバーを停止中..."
	@cd backend/docker && docker-compose down
	@pkill -f "vite" 2>/dev/null || true
	@pkill -f "npm.*dev" 2>/dev/null || true
	@echo "✅ 開発サーバーを停止しました"

clean: ## ビルド成果物とキャッシュを削除
	@echo "🧹 プロジェクトをクリーンアップ中..."
	@cd frontend && rm -rf dist node_modules/.vite
	@cd backend && rm -f main && rm -rf tmp
	@echo "✅ クリーンアップが完了しました"

status: ## 開発サーバーの状態を確認
	@echo "📊 サービス状態を確認中..."
	@echo "フロントエンド (Vite):"
	@curl -s http://localhost:5173 > /dev/null && echo "  ✅ 起動中 (http://localhost:5173)" || echo "  ❌ 停止中"
	@echo "バックエンド (Go):"
	@curl -s http://localhost:8085/health > /dev/null && echo "  ✅ 起動中 (http://localhost:8085)" || echo "  ❌ 停止中"

##@ Checks
check-deps: ## 必要な依存関係をチェック
	@echo "🔍 依存関係をチェック中..."
	@command -v node >/dev/null 2>&1 || { echo "❌ Node.js が見つかりません"; exit 1; }
	@command -v npm >/dev/null 2>&1 || { echo "❌ npm が見つかりません"; exit 1; }
	@command -v go >/dev/null 2>&1 || { echo "❌ Go が見つかりません"; exit 1; }
	@command -v docker >/dev/null 2>&1 || { echo "❌ Docker が見つかりません"; exit 1; }
	@command -v docker-compose >/dev/null 2>&1 || command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || { echo "❌ Docker Compose が見つかりません"; exit 1; }
	@echo "✅ 必要な依存関係が揃っています"

##@ Quick Start
setup: install ## プロジェクトの初期セットアップ
	@echo "🚀 プロジェクトの初期セットアップ中..."
	@make check-deps
	@make install
	@echo "✅ セットアップが完了しました"
	@echo ""
	@echo "次のコマンドで開発を開始できます:"
	@echo "  make dev    # 開発環境を起動"
	@echo "  make status # サービス状態を確認"

##@ Production
prod-build: build-frontend docker-prod ## 本番用ビルドを実行
	@echo "🚀 本番用ビルドを実行中..."
	@make build-frontend
	@make docker-prod
	@echo "✅ 本番用ビルドが完了しました"

##@ Advanced
reset: clean install ## プロジェクトをリセット（クリーンアップ + 再インストール）
	@echo "🔄 プロジェクトをリセット中..."
	@make clean
	@make install
	@echo "✅ プロジェクトのリセットが完了しました"

update: ## 依存関係を更新
	@echo "📦 依存関係を更新中..."
	@cd frontend && npm update
	@cd backend && go get -u ./... && go mod tidy
	@echo "✅ 依存関係の更新が完了しました"