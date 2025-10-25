package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"score-splitter/backend/gen/go/score"
	"score-splitter/backend/gen/go/score/scoreconnect"

	"connectrpc.com/connect"
	ffmpeg "github.com/u2takey/ffmpeg-go"
	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfcpu "github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

type scoreService struct{}

var youtubeInitialDataRegex = regexp.MustCompile(`(?s)ytInitialData\s*=\s*(\{.*?\})\s*;`)

const (
	maxYoutubeBodySize = 6 << 20 // 6MB
	defaultSearchLimit = 10
)

var httpClient = &http.Client{
	Timeout: 8 * time.Second,
}

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

func (s *scoreService) SearchYoutubeVideos(
	ctx context.Context,
	req *connect.Request[score.SearchYoutubeVideosRequest],
) (*connect.Response[score.SearchYoutubeVideosResponse], error) {
	query := strings.TrimSpace(req.Msg.GetQuery())
	if query == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("検索キーワードを入力してください"))
	}

	videos, err := fetchYoutubeVideos(ctx, query, defaultSearchLimit)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	res := connect.NewResponse(&score.SearchYoutubeVideosResponse{})
	for _, video := range videos {
		res.Msg.Videos = append(res.Msg.Videos, &score.YoutubeVideo{
			VideoId:      video.VideoId,
			Title:        video.Title,
			ThumbnailUrl: video.ThumbnailUrl,
		})
	}

	return res, nil
}

func (s *scoreService) GenerateScrollVideo(
	ctx context.Context,
	req *connect.Request[score.GenerateScrollVideoRequest],
) (*connect.Response[score.GenerateScrollVideoResponse], error) {
	log.Printf(
		"GenerateScrollVideo request: title=%s pdfBytes=%d bpm=%d",
		req.Msg.GetTitle(),
		len(req.Msg.GetPdfFile()),
		req.Msg.GetBpm(),
	)

	pdfBytes := req.Msg.GetPdfFile()
	if len(pdfBytes) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("PDFファイルが空です"))
	}

	bpm := req.Msg.GetBpm()
	if bpm <= 0 {
		bpm = 80 // デフォルトBPM
	}
	if bpm < 30 || bpm > 240 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("BPMは30から240の間で指定してください"))
	}

	videoWidth := req.Msg.GetVideoWidth()
	if videoWidth <= 0 {
		videoWidth = 1920
	}

	videoHeight := req.Msg.GetVideoHeight()
	if videoHeight <= 0 {
		videoHeight = 1080
	}

	fps := req.Msg.GetFps()
	if fps <= 0 {
		fps = 30
	}

	format := req.Msg.GetFormat()
	if format == "" {
		format = "mp4"
	}

	videoData, duration, err := generateScrollVideo(
		pdfBytes,
		int(bpm),
		int(videoWidth),
		int(videoHeight),
		int(fps),
		format,
	)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	filename := deriveVideoFilename(req.Msg.GetTitle(), format)
	res := connect.NewResponse(&score.GenerateScrollVideoResponse{
		Message:         "スクロール動画を生成しました",
		VideoData:       videoData,
		Filename:        filename,
		DurationSeconds: int32(duration),
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

func deriveVideoFilename(title, format string) string {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		trimmed = "score-scroll"
	}
	sanitized := invalidFilenameChars.ReplaceAllString(trimmed, "_")
	sanitized = strings.Trim(sanitized, ". ")
	if sanitized == "" {
		sanitized = "score-scroll"
	}
	return fmt.Sprintf("%s-scroll.%s", sanitized, format)
}

const SCROLL_PIXELS_PER_BEAT = 120.0

func generateScrollVideo(pdfBytes []byte, bpm, videoWidth, videoHeight, fps int, format string) ([]byte, int, error) {
	// 一時ディレクトリ作成
	tempDir, err := os.MkdirTemp("", "scroll-video-*")
	if err != nil {
		return nil, 0, fmt.Errorf("一時ディレクトリの作成に失敗: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// PDFを画像に変換
	imageFiles, totalWidth, err := convertPDFToImages(pdfBytes, tempDir, videoHeight)
	if err != nil {
		return nil, 0, fmt.Errorf("PDF画像変換に失敗: %v", err)
	}

	if len(imageFiles) == 0 {
		return nil, 0, errors.New("PDFから画像を生成できませんでした")
	}

	// 横に結合した画像を作成
	combinedImagePath := filepath.Join(tempDir, "combined.png")
	if err := combineImagesHorizontally(imageFiles, combinedImagePath, totalWidth, videoHeight); err != nil {
		return nil, 0, fmt.Errorf("画像結合に失敗: %v", err)
	}

	// 動画の長さを計算
	// BPMベースでスクロール速度を計算: (BPM / 60) * SCROLL_PIXELS_PER_BEAT pixels/second
	pixelsPerSecond := float64(bpm) / 60.0 * SCROLL_PIXELS_PER_BEAT
	scrollDistance := float64(totalWidth - videoWidth)
	if scrollDistance <= 0 {
		scrollDistance = float64(totalWidth) // 最低でも全体の幅分はスクロール
	}
	durationSeconds := int(math.Ceil(scrollDistance / pixelsPerSecond))
	if durationSeconds < 1 {
		durationSeconds = 1
	}

	// FFmpegで動画生成
	outputPath := filepath.Join(tempDir, fmt.Sprintf("output.%s", format))
	videoData, err := createScrollVideoWithFFmpeg(combinedImagePath, outputPath, videoWidth, videoHeight, fps, durationSeconds, int(scrollDistance))
	if err != nil {
		return nil, 0, fmt.Errorf("動画生成に失敗: %v", err)
	}

	return videoData, durationSeconds, nil
}

func convertPDFToImages(pdfBytes []byte, tempDir string, targetHeight int) ([]string, int, error) {
	// PDFをページごとに画像に変換
	conf := model.NewDefaultConfiguration()
	ctx, err := pdfapi.ReadValidateAndOptimize(bytes.NewReader(pdfBytes), conf)
	if err != nil {
		return nil, 0, err
	}

	if err := ctx.EnsurePageCount(); err != nil {
		return nil, 0, err
	}

	if ctx.PageCount == 0 {
		return nil, 0, errors.New("PDFにページがありません")
	}

	var imageFiles []string
	totalWidth := 0

	for pageNum := 1; pageNum <= ctx.PageCount; pageNum++ {
		// PDFページを画像として出力
		imagePath := filepath.Join(tempDir, fmt.Sprintf("page_%03d.png", pageNum))
		
		// pdfcpuを使用してページを画像に変換
		// 注: 実際の実装では、PDFページを画像に変換するための適切な方法を使用する必要があります
		// ここではImageMagickやpdftoppmを使用することを想定
		
		if err := convertPDFPageToImage(pdfBytes, pageNum, imagePath, targetHeight); err != nil {
			log.Printf("ページ%dの変換に失敗: %v", pageNum, err)
			continue
		}

		// 画像の幅を取得
		width, err := getImageWidth(imagePath)
		if err != nil {
			log.Printf("ページ%dの幅取得に失敗: %v", pageNum, err)
			continue
		}

		imageFiles = append(imageFiles, imagePath)
		totalWidth += width
	}

	return imageFiles, totalWidth, nil
}

func convertPDFPageToImage(pdfBytes []byte, pageNum int, outputPath string, targetHeight int) error {
	// 一時PDFファイルを作成
	tempPDF := outputPath + ".temp.pdf"
	if err := os.WriteFile(tempPDF, pdfBytes, 0644); err != nil {
		return err
	}
	defer os.Remove(tempPDF)

	// ImageMagickまたはpdftoppmを使用してPDFを画像に変換
	// まずpdftoppmを試す
	cmd := exec.Command("pdftoppm", 
		"-png",
		"-f", strconv.Itoa(pageNum),
		"-l", strconv.Itoa(pageNum),
		"-scale-to-y", strconv.Itoa(targetHeight),
		"-scale-to-x", "-1", // アスペクト比を維持
		tempPDF,
		strings.TrimSuffix(outputPath, ".png"),
	)

	if err := cmd.Run(); err != nil {
		// pdftoppmが失敗した場合、ImageMagickを試す
		cmd = exec.Command("convert",
			"-density", "150",
			fmt.Sprintf("%s[%d]", tempPDF, pageNum-1),
			"-resize", fmt.Sprintf("x%d", targetHeight),
			outputPath,
		)
		return cmd.Run()
	}

	// pdftoppmの出力ファイル名を調整
	generatedFile := strings.TrimSuffix(outputPath, ".png") + "-" + fmt.Sprintf("%d", pageNum) + ".png"
	if _, err := os.Stat(generatedFile); err == nil {
		return os.Rename(generatedFile, outputPath)
	}

	return nil
}

func getImageWidth(imagePath string) (int, error) {
	cmd := exec.Command("identify", "-format", "%w", imagePath)
	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}

	width, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil {
		return 0, err
	}

	return width, nil
}

func combineImagesHorizontally(imageFiles []string, outputPath string, totalWidth, height int) error {
	if len(imageFiles) == 0 {
		return errors.New("結合する画像がありません")
	}

	if len(imageFiles) == 1 {
		// 1つの画像の場合はコピー
		return copyFile(imageFiles[0], outputPath)
	}

	// ImageMagickを使用して画像を横に結合
	args := []string{"+append"}
	args = append(args, imageFiles...)
	args = append(args, outputPath)

	cmd := exec.Command("convert", args...)
	return cmd.Run()
}

func copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

func createScrollVideoWithFFmpeg(imagePath, outputPath string, width, height, fps, duration, scrollDistance int) ([]byte, error) {
	// FFmpegを使用してスクロール動画を生成
	err := ffmpeg.Input(imagePath).
		Filter("scale", ffmpeg.Args{fmt.Sprintf("%d:%d", width+scrollDistance, height)}).
		Filter("crop", ffmpeg.Args{fmt.Sprintf("%d:%d:t*%d/%d:0", width, height, scrollDistance, duration)}).
		Output(outputPath, ffmpeg.KwArgs{
			"vcodec":  "libx264",
			"pix_fmt": "yuv420p",
			"r":       fmt.Sprintf("%d", fps),
			"t":       fmt.Sprintf("%d", duration),
		}).
		OverWriteOutput().
		Run()

	if err != nil {
		return nil, fmt.Errorf("FFmpeg実行エラー: %v", err)
	}

	// 生成された動画ファイルを読み込み
	videoData, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, fmt.Errorf("動画ファイル読み込みエラー: %v", err)
	}

	return videoData, nil
}

type youtubeVideoInfo struct {
	VideoId      string
	Title        string
	ThumbnailUrl string
}

func fetchYoutubeVideos(ctx context.Context, query string, limit int) ([]youtubeVideoInfo, error) {
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	searchURL := fmt.Sprintf(
		"https://www.youtube.com/results?search_query=%s&sp=EgIQAQ%%253D%%253D",
		url.QueryEscape(query),
	)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, searchURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
	request.Header.Set("Accept-Language", "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7")

	response, err := httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("YouTube検索に失敗しました (HTTP %d)", response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxYoutubeBodySize))
	if err != nil {
		return nil, err
	}

	matches := youtubeInitialDataRegex.FindSubmatch(body)
	if len(matches) < 2 {
		return nil, errors.New("YouTube検索結果を解析できませんでした")
	}

	var initialData any
	if err := json.Unmarshal(matches[1], &initialData); err != nil {
		return nil, err
	}

	var renderers []map[string]any
	extractVideoRenderers(initialData, &renderers, limit*2)

	results := make([]youtubeVideoInfo, 0, limit)
	seen := make(map[string]struct{}, limit)
	for _, renderer := range renderers {
		info, ok := convertVideoRenderer(renderer)
		if !ok {
			continue
		}
		if _, exists := seen[info.VideoId]; exists {
			continue
		}
		seen[info.VideoId] = struct{}{}
		results = append(results, info)
		if len(results) >= limit {
			break
		}
	}

	if len(results) == 0 {
		return nil, errors.New("該当する動画が見つかりませんでした")
	}

	return results, nil
}

func extractVideoRenderers(node any, out *[]map[string]any, limit int) {
	if limit > 0 && len(*out) >= limit {
		return
	}
	switch value := node.(type) {
	case map[string]any:
		if renderer, ok := value["videoRenderer"]; ok {
			if rendererMap, ok := renderer.(map[string]any); ok {
				*out = append(*out, rendererMap)
				if limit > 0 && len(*out) >= limit {
					return
				}
			}
		}
		for _, next := range value {
			extractVideoRenderers(next, out, limit)
			if limit > 0 && len(*out) >= limit {
				return
			}
		}
	case []any:
		for _, item := range value {
			extractVideoRenderers(item, out, limit)
			if limit > 0 && len(*out) >= limit {
				return
			}
		}
	}
}

func convertVideoRenderer(renderer map[string]any) (youtubeVideoInfo, bool) {
	videoID, _ := renderer["videoId"].(string)
	if videoID == "" {
		return youtubeVideoInfo{}, false
	}

	title := extractVideoTitle(renderer)
	thumbnail := extractVideoThumbnail(renderer)

	if title == "" {
		title = "無題の動画"
	}

	return youtubeVideoInfo{
		VideoId:      videoID,
		Title:        title,
		ThumbnailUrl: thumbnail,
	}, true
}

func extractVideoTitle(renderer map[string]any) string {
	titleField, ok := renderer["title"].(map[string]any)
	if !ok {
		return ""
	}
	if runs, ok := titleField["runs"].([]any); ok {
		for _, run := range runs {
			if runMap, ok := run.(map[string]any); ok {
				if text, ok := runMap["text"].(string); ok && text != "" {
					return text
				}
			}
		}
	}
	if simple, ok := titleField["simpleText"].(string); ok {
		return simple
	}
	return ""
}

func extractVideoThumbnail(renderer map[string]any) string {
	thumbnailField, ok := renderer["thumbnail"].(map[string]any)
	if !ok {
		return ""
	}
	thumbnails, ok := thumbnailField["thumbnails"].([]any)
	if !ok {
		return ""
	}
	var urlCandidate string
	for _, item := range thumbnails {
		if thumbMap, ok := item.(map[string]any); ok {
			if urlValue, ok := thumbMap["url"].(string); ok && urlValue != "" {
				urlCandidate = urlValue
			}
		}
	}
	if urlCandidate == "" {
		return ""
	}
	return strings.ReplaceAll(urlCandidate, "\\u0026", "&")
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
