package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"score-splitter/backend/gen/go/score"
	"score-splitter/backend/gen/go/scoreconnect"

	"connectrpc.com/connect"
	"github.com/phpdave11/gofpdf"
	"github.com/phpdave11/gofpdf/contrib/gofpdi"
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

func (s *scoreService) TrimScore(
	ctx context.Context,
	req *connect.Request[score.TrimScoreRequest],
) (*connect.Response[score.TrimScoreResponse], error) {
	_ = ctx

	pdfBytes := req.Msg.GetPdfFile()
	if len(pdfBytes) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("PDFファイルが空です"))
	}

	normalized, err := normalizeAreas(req.Msg.GetAreas())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	trimmed, err := buildTrimmedPDF(pdfBytes, normalized)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	filename := deriveFilename(req.Msg.GetTitle())
	res := connect.NewResponse(&score.TrimScoreResponse{
		Message:    "トリミング済みPDFを生成しました",
		TrimmedPdf: trimmed,
		Filename:   filename,
	})

	return res, nil
}

type normalizedArea struct {
	top    float64
	left   float64
	width  float64
	height float64
}

const minAreaSize = 0.01

func clamp(value, min, max float64) float64 {
	return math.Min(math.Max(value, min), max)
}

func normalizeAreas(areas []*score.CropArea) ([]normalizedArea, error) {
	if len(areas) == 0 {
		return nil, errors.New("トリミングエリアがありません")
	}

	normalized := make([]normalizedArea, 0, len(areas))
	for idx, area := range areas {
		if area == nil {
			continue
		}
		top := clamp(area.GetTop(), 0, 1)
		left := clamp(area.GetLeft(), 0, 1)
		width := clamp(area.GetWidth(), minAreaSize, 1)
		height := clamp(area.GetHeight(), minAreaSize, 1)

		if left+width > 1 {
			width = 1 - left
		}
		if top+height > 1 {
			height = 1 - top
		}
		if width < minAreaSize || height < minAreaSize {
			return nil, fmt.Errorf("トリミングエリア%vがページ範囲外です", idx+1)
		}

		normalized = append(normalized, normalizedArea{
			top:    top,
			left:   left,
			width:  width,
			height: height,
		})
	}

	if len(normalized) == 0 {
		return nil, errors.New("有効なトリミングエリアがありません")
	}

	sort.SliceStable(normalized, func(i, j int) bool {
		if normalized[i].top == normalized[j].top {
			return normalized[i].left < normalized[j].left
		}
		return normalized[i].top < normalized[j].top
	})

	return normalized, nil
}

func buildTrimmedPDF(pdfBytes []byte, areas []normalizedArea) ([]byte, error) {
	if len(areas) == 0 {
		return nil, errors.New("トリミングエリアがありません")
	}

	reader := bytes.NewReader(pdfBytes)
	var rs io.ReadSeeker = reader

	pdf := gofpdf.NewCustom(&gofpdf.InitType{UnitStr: "pt"})
	pdf.SetMargins(0, 0, 0)
	pdf.SetAutoPageBreak(false, 0)

	importer := gofpdi.NewImporter()

	tpl := importer.ImportPageFromStream(pdf, &rs, 1, "/MediaBox")
	pageSizes := importer.GetPageSizes()
	totalPages := len(pageSizes)

	for pageIndex := 1; pageIndex <= totalPages; pageIndex++ {
		if pageIndex > 1 {
			reader = bytes.NewReader(pdfBytes)
			rs = reader
			tpl = importer.ImportPageFromStream(pdf, &rs, pageIndex, "/MediaBox")
		}

		sizeInfo, ok := pageSizes[pageIndex]["/MediaBox"]
		if !ok {
			return nil, fmt.Errorf("ページ%vのサイズ情報を取得できません", pageIndex)
		}
		pageWidth := sizeInfo["w"]
		pageHeight := sizeInfo["h"]

		sections := make([]struct {
			width  float64
			height float64
			left   float64
			top    float64
		}, len(areas))

		totalHeight := 0.0
		maxWidth := 0.0
		for idx, area := range areas {
			width := area.width * pageWidth
			height := area.height * pageHeight
			left := area.left * pageWidth
			top := area.top * pageHeight
			sections[idx] = struct {
				width  float64
				height float64
				left   float64
				top    float64
			}{
				width:  width,
				height: height,
				left:   left,
				top:    top,
			}
			totalHeight += height
			if width > maxWidth {
				maxWidth = width
			}
		}

		if totalHeight <= 0 || maxWidth <= 0 {
			continue
		}

		pdf.AddPageFormat("P", gofpdf.SizeType{Wd: maxWidth, Ht: totalHeight})

		cursorY := 0.0
		for _, section := range sections {
			pdf.ClipRect(0, cursorY, section.width, section.height, true)
			importer.UseImportedTemplate(
				pdf,
				tpl,
				-section.left,
				cursorY-section.top,
				pageWidth,
				pageHeight,
			)
			pdf.ClipEnd()
			cursorY += section.height
		}
	}

	if err := pdf.Error(); err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

var invalidFilenameChars = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1F]`)

func deriveFilename(title string) string {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		trimmed = "trimmed-score"
	}
	sanitized := invalidFilenameChars.ReplaceAllString(trimmed, "_")
	sanitized = strings.Trim(sanitized, ". ")
	if sanitized == "" {
		sanitized = "trimmed-score"
	}
	return fmt.Sprintf("%s-trimmed.pdf", sanitized)
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
