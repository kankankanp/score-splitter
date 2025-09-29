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
	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfcpu "github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
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

	log.Printf("TrimScore request: title=%s pdfBytes=%d areas=%d", req.Msg.GetTitle(), len(req.Msg.GetPdfFile()), len(req.Msg.GetAreas()))

	pdfBytes := req.Msg.GetPdfFile()
	if len(pdfBytes) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("PDFファイルが空です"))
	}

	normalized, err := normalizeAreas(req.Msg.GetAreas())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	trimmed, err := buildTrimmedPDF(pdfBytes, normalized, req.Msg.GetPassword())
	if err != nil {
		if errors.Is(err, pdfcpu.ErrWrongPassword) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("PDFのパスワードが正しくありません"))
		}
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

func buildTrimmedPDF(pdfBytes []byte, areas []normalizedArea, password string) ([]byte, error) {
	if len(areas) == 0 {
		return nil, errors.New("トリミングエリアがありません")
	}

	conf := model.NewDefaultConfiguration()
	if password != "" {
		conf.UserPW = password
		conf.OwnerPW = password
	}
	ctx, err := pdfapi.ReadValidateAndOptimize(bytes.NewReader(pdfBytes), conf)
	if err != nil {
		return nil, err
	}
	if err := ctx.EnsurePageCount(); err != nil {
		return nil, err
	}

	if ctx.PageCount == 0 {
		return nil, errors.New("PDFにページがありません")
	}

	var segments [][]byte

	for pageIndex := 1; pageIndex <= ctx.PageCount; pageIndex++ {
		_, _, inh, err := ctx.PageDict(pageIndex, false)
		if err != nil {
			return nil, err
		}

		cropBox := inh.CropBox
		if cropBox == nil {
			cropBox = inh.MediaBox
		}
		if cropBox == nil {
			return nil, fmt.Errorf("ページ%vのサイズ情報を取得できません", pageIndex)
		}

		for _, area := range areas {
			rect, err := rectFromArea(cropBox, area)
			if err != nil {
				return nil, err
			}

			trimmed, err := extractTrimmedSegment(ctx, pageIndex, rect)
			if err != nil {
				return nil, err
			}
			segments = append(segments, trimmed)
		}
	}

	if len(segments) == 0 {
		return nil, errors.New("トリミング後のページを生成できませんでした")
	}

	if len(segments) == 1 {
		return segments[0], nil
	}

	readers := make([]io.ReadSeeker, len(segments))
	for i, data := range segments {
		readers[i] = bytes.NewReader(data)
	}

	var out bytes.Buffer
	mergeConf := model.NewDefaultConfiguration()
	if err := pdfapi.MergeRaw(readers, &out, false, mergeConf); err != nil {
		return nil, err
	}

	return out.Bytes(), nil
}

func rectFromArea(pageBox *types.Rectangle, area normalizedArea) (*types.Rectangle, error) {
	width := pageBox.Width()
	height := pageBox.Height()

	llx := pageBox.LL.X + area.left*width
	lly := pageBox.UR.Y - (area.top+area.height)*height
	urx := llx + area.width*width
	ury := lly + area.height*height

	if llx < pageBox.LL.X {
		llx = pageBox.LL.X
	}
	if lly < pageBox.LL.Y {
		lly = pageBox.LL.Y
	}
	if urx > pageBox.UR.X {
		urx = pageBox.UR.X
	}
	if ury > pageBox.UR.Y {
		ury = pageBox.UR.Y
	}

	if urx <= llx || ury <= lly {
		return nil, errors.New("トリミング範囲がページ外です")
	}

	return types.NewRectangle(llx, lly, urx, ury), nil
}

func extractTrimmedSegment(ctxSrc *model.Context, pageIndex int, rect *types.Rectangle) ([]byte, error) {
	ctxPage, err := pdfcpu.ExtractPages(ctxSrc, []int{pageIndex}, false)
	if err != nil {
		return nil, err
	}
	if err := ctxPage.EnsurePageCount(); err != nil {
		return nil, err
	}

	pageDict, _, inh, err := ctxPage.PageDict(1, false)
	if err != nil {
		return nil, err
	}
	if pageDict == nil {
		return nil, fmt.Errorf("ページ%vの抽出に失敗しました", pageIndex)
	}

	width := rect.Width()
	height := rect.Height()
	if width <= 0 || height <= 0 {
		return nil, errors.New("トリミング範囲の幅または高さが0です")
	}

	newBox := types.RectForWidthAndHeight(0, 0, width, height)
	pageDict["MediaBox"] = newBox.Array()
	pageDict["CropBox"] = newBox.Array()

	// Remove inherited rotation to avoid duplicating rotation transforms later.
	pageDict.Delete("Rotate")

	content, err := ctxPage.PageContent(pageDict, 1)
	if err != nil {
		return nil, err
	}

	dx := -rect.LL.X
	dy := -rect.LL.Y

	var buf bytes.Buffer
	buf.WriteString("q ")
	if inh.Rotate != 0 {
		baseBox := inh.MediaBox
		if baseBox == nil {
			baseBox = rect
		}
		buf.Write(model.ContentBytesForPageRotation(inh.Rotate, baseBox.Width(), baseBox.Height()))
	}
	fmt.Fprintf(&buf, "1 0 0 1 %.5f %.5f cm ", dx, dy)
	buf.Write(content)
	buf.WriteString(" Q ")

	streamDict, _ := ctxPage.NewStreamDictForBuf(buf.Bytes())
	if err := streamDict.Encode(); err != nil {
		return nil, err
	}

	indRef, err := ctxPage.IndRefForNewObject(*streamDict)
	if err != nil {
		return nil, err
	}
	pageDict["Contents"] = *indRef

	var out bytes.Buffer
	if err := pdfapi.WriteContext(ctxPage, &out); err != nil {
		return nil, err
	}

	return out.Bytes(), nil
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

		if strings.Contains(r.URL.Path, "TrimScore") {
			bodyBytes, err := io.ReadAll(r.Body)
			if err == nil {
				sample := string(bodyBytes)
				if len(sample) > 256 {
					sample = sample[:256]
				}
				log.Printf("TrimScore raw request: %s", sample)
				r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
			} else {
				log.Printf("TrimScore raw request read error: %v", err)
			}
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
