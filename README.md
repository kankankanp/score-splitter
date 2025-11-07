# Score Splitter

<p align="center">
  A powerful application for splitting musical scores and generating videos from PDF sheet music.
</p>

<p align="center">
  <a href="#features">Features</a> |
  <a href="#quick-start">Quick Start</a> |
  <a href="#documentation">Documentation</a> |
  <a href="#development">Development</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="Score Splitter is released under the MIT license." />
  <img src="https://img.shields.io/badge/React-19.1.1-blue.svg" alt="React version" />
  <img src="https://img.shields.io/badge/Go-1.25-00ADD8.svg" alt="Go version" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-blue.svg" alt="TypeScript version" />
</p>

<p align="center">
  TypeScript-based frontend with React and Go-based backend. Open source tool for processing musical scores and generating educational content.
</p>

## Features

| PDF Score Processing | Video Generation | Modern Tech Stack |
| --- | --- | --- |
| Split and process musical scores with precision using PDF processing capabilities. | Generate educational videos from sheet music with automated workflows. | Built with React 19, TypeScript, Go 1.25, and modern development tools. |

## Quick Start

### Prerequisites

- **Node.js** (18+)
- **Go** (1.25+)  
- **Docker & Docker Compose**

### Installation

```bash
# Clone the repository
git clone [repository-url]
cd score-splitter

# Check dependencies and install
make setup
```

### Running the Application

```bash
# Start both frontend and backend development servers
make dev
```

Access the application:
- **Frontend**: http://localhost:5173
- **Backend**: http://localhost:8085
- **Health Check**: http://localhost:8085/health

## Available Commands

### Basic Operations
```bash
make help          # Show all available commands
make dev           # Start development environment
make status        # Check service status
make stop          # Stop all services
```

### Individual Services
```bash
make dev-frontend  # Start frontend only
make dev-backend   # Start backend only (Docker)
make docker-dev    # Start backend with Docker
```

### Build & Test
```bash
make build         # Build entire project
make test          # Run tests
make lint          # Run code quality checks
```

### Maintenance
```bash
make clean         # Clean build artifacts
make reset         # Reset project state
make update        # Update dependencies
```

## Project Structure

```
score-splitter/
├── frontend/           # React + Vite frontend
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── backend/            # Go backend
│   ├── docker/         # Docker configuration
│   ├── main.go
│   └── go.mod
├── Makefile           # Project management
└── README.md
```

## Development

### Frontend

- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite
- **Development Server**: http://localhost:5173
- **Features**: 
  - PDF.js integration for PDF rendering
  - React Router for navigation
  - Internationalization (i18next)

### Backend

- **Language**: Go 1.25
- **Port**: 8085
- **Docker**: Development uses Docker Compose
- **Features**:
  - Connect RPC for API communication
  - PDF processing with pdfcpu
  - Video generation with FFmpeg
  - File upload handling

### API

- **Protocol**: Connect RPC
- **Endpoints**: `/score.ScoreService/*`

## Docker Development

The backend runs in Docker containers with hot-reload functionality:

```bash
# Start backend with Docker only
make docker-dev

# View logs
make logs

# Clean up Docker environment
make docker-clean
```

## Production Deployment

```bash
# Production build
make prod-build

# Check production Docker image
docker images | grep score-splitter-backend
```

## Troubleshooting

### Dependency Issues
```bash
make check-deps  # Verify required tools
make reset       # Reset project state
```

### Port Conflicts
- **Frontend**: If port 5173 is in use, Vite will automatically use another port
- **Backend**: Check port 8085 with `lsof -i :8085`

### Docker Issues
```bash
make docker-clean  # Clean Docker resources
docker system prune -f  # Remove unused Docker data
```

## Development Workflow

1. **Start Development**
   ```bash
   make dev
   ```

2. **Make Changes**
   - Frontend: Automatic reload
   - Backend: Automatic rebuild and restart

3. **Quality Checks**
   ```bash
   make lint
   make test
   ```

4. **Before Committing**
   ```bash
   make clean
   make build  # Verify build integrity
   ```

## Technology Stack

### Frontend Dependencies
- **React** 19.1.1 - UI framework
- **TypeScript** 5.8 - Type safety
- **Vite** 7.2.0 - Build tool and dev server
- **PDF.js** 5.4.149 - PDF rendering
- **React Router** 7.9.3 - Client-side routing
- **i18next** 25.6.0 - Internationalization

### Backend Dependencies
- **Go** 1.25 - Backend language
- **Connect RPC** 1.18.1 - API protocol
- **pdfcpu** 0.11.0 - PDF processing
- **FFmpeg-go** 0.5.0 - Video generation
- **Protocol Buffers** - API definition

## Contributing

We welcome contributions! Here's how you can help:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run quality checks (`make lint && make test`)
5. Commit your changes (`git commit -m 'Add some amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Development Guidelines

- Follow the existing code style
- Write tests for new features
- Update documentation as needed
- Ensure all checks pass before submitting PR

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for details.

## Tips

- Use `make help` to see all available commands
- Use `make status` to quickly check service status
- Monitor backend logs during development with `make logs`
- After stopping with `Ctrl+C`, run `make stop` for complete cleanup

---

Built with ❤️ for the music education community