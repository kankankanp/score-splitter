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

	score "score-splitter/backend/gen/go"
	"score-splitter/backend/gen/go/scoreconnect"

	"connectrpc.com/connect"
	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfcpu "github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

type scoreService struct{}

type normalizedArea struct {
	top    float64
	left   float64
	width  float64
	height float64
}

const minAreaSize = 0.01

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

	log.Printf(
		"TrimScore request: title=%s pdfBytes=%d areas=%d pageSettings=%d",
		req.Msg.GetTitle(),
		len(req.Msg.GetPdfFile()),
		len(req.Msg.GetAreas()),
		len(req.Msg.GetPageSettings()),
	)
	if pages := req.Msg.GetIncludePages(); len(pages) > 0 {
		log.Printf("TrimScore includePages: %v", pages)
	}

	pdfBytes := req.Msg.GetPdfFile()
	if len(pdfBytes) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("PDFファイルが空です"))
	}

	defaultAreas, err := normalizeAreas(req.Msg.GetAreas())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	pageOverrides := make(map[int][]normalizedArea)
	for _, setting := range req.Msg.GetPageSettings() {
		if setting == nil {
			continue
		}
		pageNumber := int(setting.GetPageNumber())
		if pageNumber < 1 {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("ページ番号%vが無効です", setting.GetPageNumber()))
		}
		areas := setting.GetAreas()
		if len(areas) == 0 {
			continue
		}
		normalizedOverride, errNormalize := normalizeAreas(areas)
		if errNormalize != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, errNormalize)
		}
		if len(normalizedOverride) == 0 {
			continue
		}
		pageOverrides[pageNumber] = normalizedOverride
	}

	if len(defaultAreas) == 0 && len(pageOverrides) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("トリミングエリアがありません"))
	}

	trimmed, err := buildTrimmedPDF(
		pdfBytes,
		defaultAreas,
		req.Msg.GetIncludePages(),
		req.Msg.GetPassword(),
		pageOverrides,
	)
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

// TrimScoreWithProgress はプログレス情報付きでPDFトリミングを実行します
func (s *scoreService) TrimScoreWithProgress(
	ctx context.Context,
	req *connect.Request[score.TrimScoreRequest],
	stream *connect.ServerStream[score.TrimScoreProgressResponse],
) error {
	_ = ctx

	log.Printf(
		"TrimScoreWithProgress request: title=%s pdfBytes=%d areas=%d pageSettings=%d orientation=%s",
		req.Msg.GetTitle(),
		len(req.Msg.GetPdfFile()),
		len(req.Msg.GetAreas()),
		len(req.Msg.GetPageSettings()),
		req.Msg.GetOrientation(),
	)

	// 段階1: PDFファイル検証
	if err := stream.Send(&score.TrimScoreProgressResponse{
		Stage:    "parsing",
		Progress: 10,
		Message:  "PDFファイルを検証しています...",
	}); err != nil {
		return err
	}

	pdfBytes := req.Msg.GetPdfFile()
	if len(pdfBytes) == 0 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("PDFファイルが空です"))
	}

	// 段階2: トリミングエリア正規化
	if err := stream.Send(&score.TrimScoreProgressResponse{
		Stage:    "parsing",
		Progress: 25,
		Message:  "トリミングエリアを処理しています...",
	}); err != nil {
		return err
	}

	defaultAreas, err := normalizeAreas(req.Msg.GetAreas())
	if err != nil {
		return connect.NewError(connect.CodeInvalidArgument, err)
	}

	pageOverrides := make(map[int][]normalizedArea)
	for _, setting := range req.Msg.GetPageSettings() {
		if setting == nil {
			continue
		}
		pageNumber := int(setting.GetPageNumber())
		if pageNumber < 1 {
			return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("ページ番号%vが無効です", setting.GetPageNumber()))
		}
		areas := setting.GetAreas()
		if len(areas) == 0 {
			continue
		}
		normalizedOverride, errNormalize := normalizeAreas(areas)
		if errNormalize != nil {
			return connect.NewError(connect.CodeInvalidArgument, errNormalize)
		}
		if len(normalizedOverride) == 0 {
			continue
		}
		pageOverrides[pageNumber] = normalizedOverride
	}

	if len(defaultAreas) == 0 && len(pageOverrides) == 0 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("トリミングエリアがありません"))
	}

	// 段階3: PDF処理開始
	if err := stream.Send(&score.TrimScoreProgressResponse{
		Stage:    "processing",
		Progress: 40,
		Message:  "PDFページを処理しています...",
	}); err != nil {
		return err
	}

	// プログレス付きでPDF処理
	trimmed, err := buildTrimmedPDFWithProgress(
		pdfBytes,
		defaultAreas,
		req.Msg.GetIncludePages(),
		req.Msg.GetPassword(),
		pageOverrides,
		req.Msg.GetOrientation(),
		stream,
	)
	if err != nil {
		if errors.Is(err, pdfcpu.ErrWrongPassword) {
			return connect.NewError(connect.CodeInvalidArgument, errors.New("PDFのパスワードが正しくありません"))
		}
		return connect.NewError(connect.CodeInternal, err)
	}

	// 段階4: 完了
	filename := deriveFilename(req.Msg.GetTitle())
	orientationSuffix := ""
	if req.Msg.GetOrientation() == "landscape" {
		orientationSuffix = "-landscape"
	}
	if orientationSuffix != "" {
		filename = strings.Replace(filename, ".pdf", orientationSuffix+".pdf", 1)
	}

	if err := stream.Send(&score.TrimScoreProgressResponse{
		Stage:       "complete",
		Progress:    100,
		Message:     "トリミング済みPDFを生成しました",
		TrimmedPdf:  trimmed,
		Filename:    filename,
	}); err != nil {
		return err
	}

	return nil
}

// SearchYoutubeVideos は削除された機能のスタブ
func (s *scoreService) SearchYoutubeVideos(
	ctx context.Context,
	req *connect.Request[score.SearchYoutubeVideosRequest],
) (*connect.Response[score.SearchYoutubeVideosResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("YouTube検索機能は削除されました"))
}

// GenerateScrollVideo は削除された機能のスタブ
func (s *scoreService) GenerateScrollVideo(
	ctx context.Context,
	req *connect.Request[score.GenerateScrollVideoRequest],
) (*connect.Response[score.GenerateScrollVideoResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("動画生成機能は削除されました"))
}

func clamp(value, min, max float64) float64 {
	return math.Min(math.Max(value, min), max)
}

func resolvePagesToProcess(totalPages int, includePages []int32) ([]int, error) {
	if totalPages <= 0 {
		return nil, errors.New("PDFにページがありません")
	}

	if len(includePages) == 0 {
		pages := make([]int, totalPages)
		for i := 1; i <= totalPages; i++ {
			pages[i-1] = i
		}
		return pages, nil
	}

	seen := make(map[int]struct{}, len(includePages))
	pages := make([]int, 0, len(includePages))
	for _, pageNum := range includePages {
		pageIndex := int(pageNum)
		if pageIndex < 1 || pageIndex > totalPages {
			return nil, fmt.Errorf("含めるページ番号%vが範囲外です", pageNum)
		}
		if _, exists := seen[pageIndex]; exists {
			continue
		}
		seen[pageIndex] = struct{}{}
		pages = append(pages, pageIndex)
	}

	if len(pages) == 0 {
		return nil, errors.New("有効なページがありません")
	}

	sort.Ints(pages)
	return pages, nil
}

func normalizeAreas(areas []*score.CropArea) ([]normalizedArea, error) {
	if len(areas) == 0 {
		return nil, nil
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

func buildTrimmedPDF(
	pdfBytes []byte,
	defaultAreas []normalizedArea,
	includePages []int32,
	password string,
	pageOverrides map[int][]normalizedArea,
) ([]byte, error) {
	if len(defaultAreas) == 0 && len(pageOverrides) == 0 {
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

	pagesToProcess, err := resolvePagesToProcess(ctx.PageCount, includePages)
	if err != nil {
		return nil, err
	}

	for pageNumber := range pageOverrides {
		if pageNumber < 1 || pageNumber > ctx.PageCount {
			return nil, fmt.Errorf("ページ%vの設定がPDFの範囲外です", pageNumber)
		}
	}

	var segments [][]byte

	for _, pageIndex := range pagesToProcess {
		areasForPage := pageOverrides[pageIndex]
		if len(areasForPage) == 0 {
			areasForPage = defaultAreas
		}
		if len(areasForPage) == 0 {
			return nil, fmt.Errorf("ページ%vのトリミングエリアがありません", pageIndex)
		}

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

		for _, area := range areasForPage {
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

// buildTrimmedPDFWithProgress はプログレス情報を送信しながらPDFを処理します
func buildTrimmedPDFWithProgress(
	pdfBytes []byte,
	defaultAreas []normalizedArea,
	includePages []int32,
	password string,
	pageOverrides map[int][]normalizedArea,
	orientation string,
	stream *connect.ServerStream[score.TrimScoreProgressResponse],
) ([]byte, error) {
	if len(defaultAreas) == 0 && len(pageOverrides) == 0 {
		return nil, errors.New("トリミングエリアがありません")
	}

	// PDFコンテキスト作成
	if err := stream.Send(&score.TrimScoreProgressResponse{
		Stage:    "processing",
		Progress: 45,
		Message:  "PDFを解析しています...",
	}); err != nil {
		return nil, err
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

	// ページ範囲解決
	if err := stream.Send(&score.TrimScoreProgressResponse{
		Stage:    "processing",
		Progress: 50,
		Message:  "処理対象ページを決定しています...",
	}); err != nil {
		return nil, err
	}

	pagesToProcess, err := resolvePagesToProcess(ctx.PageCount, includePages)
	if err != nil {
		return nil, err
	}

	for pageNumber := range pageOverrides {
		if pageNumber < 1 || pageNumber > ctx.PageCount {
			return nil, fmt.Errorf("ページ%vの設定がPDFの範囲外です", pageNumber)
		}
	}

	var segments [][]byte
	totalPages := len(pagesToProcess)

	// 各ページを処理
	for i, pageIndex := range pagesToProcess {
		progress := 55 + int(float64(i)/float64(totalPages)*25) // 55-80%の範囲
		if err := stream.Send(&score.TrimScoreProgressResponse{
			Stage:    "processing",
			Progress: int32(progress),
			Message:  fmt.Sprintf("ページ %d/%d を処理しています...", i+1, totalPages),
		}); err != nil {
			return nil, err
		}

		areasForPage := pageOverrides[pageIndex]
		if len(areasForPage) == 0 {
			areasForPage = defaultAreas
		}
		if len(areasForPage) == 0 {
			return nil, fmt.Errorf("ページ%vのトリミングエリアがありません", pageIndex)
		}

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

		for _, area := range areasForPage {
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

	// PDF生成
	if err := stream.Send(&score.TrimScoreProgressResponse{
		Stage:    "generating",
		Progress: 85,
		Message:  "PDFを生成しています...",
	}); err != nil {
		return nil, err
	}

	var result []byte
	if len(segments) == 1 {
		result = segments[0]
	} else {
		readers := make([]io.ReadSeeker, len(segments))
		for i, data := range segments {
			readers[i] = bytes.NewReader(data)
		}

		var out bytes.Buffer
		mergeConf := model.NewDefaultConfiguration()
		if err := pdfapi.MergeRaw(readers, &out, false, mergeConf); err != nil {
			return nil, err
		}
		result = out.Bytes()
	}

	// 横向き変換
	if orientation == "landscape" {
		if err := stream.Send(&score.TrimScoreProgressResponse{
			Stage:    "generating",
			Progress: 95,
			Message:  "スライド形式に変換しています...",
		}); err != nil {
			return nil, err
		}

		result, err = rotatePDFToLandscape(result)
		if err != nil {
			return nil, err
		}
	}

	return result, nil
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

	// ヘルスチェックエンドポイント
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok","service":"score-splitter-backend"}`))
	})

	// 2つの値（パスとハンドラ）を受け取る
	path, handler := scoreconnect.NewScoreServiceHandler(&scoreService{})
	mux.Handle(path, corsMiddleware(handler))

	log.Println("listening on :8085")
	if err := http.ListenAndServe(":8085", mux); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}

// rotatePDFToLandscape はトリミング済みページを横向きスライド形式のPDFに変換します
func rotatePDFToLandscape(pdfBytes []byte) ([]byte, error) {
	log.Printf("Converting PDF to landscape slide format (4 pages per slide)")
	
	conf := model.NewDefaultConfiguration()
	ctx, err := pdfapi.ReadValidateAndOptimize(bytes.NewReader(pdfBytes), conf)
	if err != nil {
		return nil, err
	}
	if err := ctx.EnsurePageCount(); err != nil {
		return nil, err
	}

	log.Printf("Creating landscape slides from %d pages", ctx.PageCount)
	
	// 各ページを画像として抽出し、4つずつスライドに配置
	return createSlidesFromPages(ctx)
}

// createSlidesFromPages は pdfcpu の NUp 機能を使用してスライドを作成します
func createSlidesFromPages(ctx *model.Context) ([]byte, error) {
	// 4アップ（2x2）グリッド設定を作成
	conf := model.NewDefaultConfiguration()
	nUpConfig, err := pdfapi.PDFGridConfig(2, 2, "A4L", conf)
	if err != nil {
		return nil, fmt.Errorf("failed to create NUp config: %v", err)
	}
	
	log.Printf("Creating %d slides from %d pages using 2x2 grid", 
		(ctx.PageCount + 3) / 4, ctx.PageCount)
	
	// 元のPDFを一時ファイルに書き出し
	var inBuf bytes.Buffer
	if err := pdfapi.WriteContext(ctx, &inBuf); err != nil {
		return nil, err
	}
	
	// NUp処理を実行
	var outBuf bytes.Buffer
	if err := pdfapi.NUp(bytes.NewReader(inBuf.Bytes()), &outBuf, nil, nil, nUpConfig, conf); err != nil {
		return nil, fmt.Errorf("failed to create NUp layout: %v", err)
	}
	
	return outBuf.Bytes(), nil
}
