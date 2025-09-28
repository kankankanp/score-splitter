package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"score-splitter/backend/gen/go/score"
	"score-splitter/backend/gen/go/scoreconnect"

	"connectrpc.com/connect"
)

type scoreService struct{}

func (s *scoreService) UploadScore(
    ctx context.Context,
    req *connect.Request[score.UploadScoreRequest],
) (*connect.Response[score.UploadScoreResponse], error) {
    dir := "uploads"
    if err := os.MkdirAll(dir, 0755); err != nil {
        return nil, connect.NewError(connect.CodeInternal, err)
    }

    filename := req.Msg.GetTitle() + ".pdf"
    path := filepath.Join(dir, filename)

    if err := os.WriteFile(path, req.Msg.GetPdfFile(), 0644); err != nil {
        return nil, connect.NewError(connect.CodeInternal, err)
    }

    res := connect.NewResponse(&score.UploadScoreResponse{
        Message: "PDF uploaded successfully",
        ScoreId: filename,
    })
    return res, nil
}

// CORSミドルウェアを追加
func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Connect-Protocol-Version")
        
        if r.Method == "OPTIONS" {
            w.WriteHeader(http.StatusOK)
            return
        }
        
        next.ServeHTTP(w, r)
    })
}

func main() {
    mux := http.NewServeMux()

    // 2つの値（パスとハンドラ）を受け取る
    path, handler := scoreconnect.NewScoreServiceHandler(&scoreService{})
    mux.Handle(path, corsMiddleware(handler))

    log.Println("listening on :8085")
    if err := http.ListenAndServe(":8085", mux); err != nil {
        log.Fatalf("server stopped: %v", err)
    }
}