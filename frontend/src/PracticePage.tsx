import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  GlobalWorkerOptions,
  getDocument,
} from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker?url";
import { searchYoutubeVideos, type YoutubeVideo } from "./api/scoreClient";
import { usePractice } from "./practiceContext";

type PracticePageImage = {
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
};

const SCROLL_PIXELS_PER_BEAT = 120;
const MIN_BPM = 30;
const MAX_BPM = 240;

GlobalWorkerOptions.workerSrc = workerSrc;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function bufferToUint8Array(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data
    : new Uint8Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
}

function PracticeWorkspace({
  title,
  filename,
  pdfData,
  onExit,
}: {
  title: string;
  filename: string;
  pdfData: Uint8Array;
  onExit: () => void;
}): ReactElement {
  const [pages, setPages] = useState<PracticePageImage[]>([]);
  const [loadingPages, setLoadingPages] = useState<boolean>(true);
  const [renderError, setRenderError] = useState<string>("");
  const [bpm, setBpm] = useState<number>(80);
  const [isScrolling, setIsScrolling] = useState<boolean>(false);
  const [searchInput, setSearchInput] = useState<string>(title);
  const [searchResults, setSearchResults] = useState<YoutubeVideo[]>([]);
  const [searching, setSearching] = useState<boolean>(false);
  const [searchError, setSearchError] = useState<string>("");
  const [selectedVideo, setSelectedVideo] = useState<YoutubeVideo | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollStateRef = useRef<{ lastTimestamp: number | null }>({
    lastTimestamp: null,
  });

  useEffect(() => {
    let cancelled = false;
    const bytes = bufferToUint8Array(pdfData);
    setLoadingPages(true);
    setRenderError("");
    const loadingTask = getDocument({ data: bytes });

    (async () => {
      try {
        const doc = await loadingTask.promise;
        const rendered: PracticePageImage[] = [];

        for (let index = 1; index <= doc.numPages; index += 1) {
          const page = await doc.getPage(index);
          const viewport = page.getViewport({ scale: 1 });
          const targetHeight = 650;
          const scale = clamp(targetHeight / viewport.height, 1, 3);
          const renderViewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(renderViewport.width);
          canvas.height = Math.floor(renderViewport.height);
          const context = canvas.getContext("2d");
          if (context) {
            await page
              .render({ canvasContext: context, viewport: renderViewport, canvas })
              .promise;
          }
          if (!cancelled) {
            rendered.push({
              pageNumber: index,
              dataUrl: canvas.toDataURL("image/png"),
              width: canvas.width,
              height: canvas.height,
            });
          }
          page.cleanup();
        }

        if (!cancelled) {
          setPages(rendered);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setPages([]);
          setRenderError("楽譜の読み込みに失敗しました");
        }
      } finally {
        if (!cancelled) {
          setLoadingPages(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [pdfData]);

  const runSearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setSearchError("検索キーワードを入力してください");
      setSearchResults([]);
      setSelectedVideo(null);
      return;
    }

    setSearching(true);
    setSearchError("");
    try {
      const results = await searchYoutubeVideos(trimmed);
      setSearchResults(results);
      setSelectedVideo(results[0] ?? null);
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        setSearchError(error.message || "動画の検索に失敗しました");
      } else {
        setSearchError("動画の検索に失敗しました");
      }
      setSearchResults([]);
      setSelectedVideo(null);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    setSearchInput(title);
    void runSearch(title);
  }, [title, runSearch]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollLeft = 0;
    }
    scrollStateRef.current.lastTimestamp = null;
    setIsScrolling(false);
  }, [pages.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isScrolling) {
      scrollStateRef.current.lastTimestamp = null;
      return undefined;
    }

    let active = true;
    let rafId = 0;

    const step = (timestamp: number) => {
      if (!active) {
        return;
      }

      const last = scrollStateRef.current.lastTimestamp;
      scrollStateRef.current.lastTimestamp = timestamp;

      if (last !== null) {
        const delta = timestamp - last;
        const pixelsPerSecond = (bpm / 60) * SCROLL_PIXELS_PER_BEAT;
        container.scrollLeft += (pixelsPerSecond * delta) / 1000;

        if (container.scrollLeft + container.clientWidth >= container.scrollWidth - 1) {
          container.scrollLeft = Math.max(
            0,
            container.scrollWidth - container.clientWidth,
          );
          active = false;
          scrollStateRef.current.lastTimestamp = null;
          setIsScrolling(false);
          return;
        }
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => {
      active = false;
      scrollStateRef.current.lastTimestamp = null;
      cancelAnimationFrame(rafId);
    };
  }, [isScrolling, bpm]);

  const handleSearchSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void runSearch(searchInput);
    },
    [runSearch, searchInput],
  );

  const handleStartScroll = useCallback(() => {
    if (pages.length === 0) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    if (container.scrollWidth <= container.clientWidth) {
      return;
    }
    scrollStateRef.current.lastTimestamp = null;
    setIsScrolling(true);
  }, [pages.length]);

  const handlePauseScroll = useCallback(() => {
    setIsScrolling(false);
  }, []);

  const handleResetScroll = useCallback(() => {
    setIsScrolling(false);
    scrollStateRef.current.lastTimestamp = null;
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollLeft = 0;
    }
  }, []);

  const handleBpmChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) {
      setBpm(Math.round(clamp(value, MIN_BPM, MAX_BPM)));
    }
  }, []);

  const videoSrc = useMemo(() => {
    if (!selectedVideo) {
      return "";
    }
    const params = new URLSearchParams({
      autoplay: "1",
      rel: "0",
      modestbranding: "1",
      playsinline: "1",
      iv_load_policy: "3",
      showinfo: "0",
      controls: "1",
      loop: "1",
    });
    params.set("playlist", selectedVideo.videoId);
    return `https://www.youtube.com/embed/${selectedVideo.videoId}?${params.toString()}`;
  }, [selectedVideo]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ contain: 'layout style', maxWidth: '100vw', overflow: 'hidden' }}>
      <header className="flex items-center justify-between border-b border-slate-800/70 bg-slate-950/80 px-6 py-4 backdrop-blur">
        <div>
          <h1 className="text-2xl font-semibold">練習モード</h1>
          <p className="text-xs text-slate-400">
            {title} / {filename}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setIsScrolling(false);
            onExit();
          }}
          className="rounded-full border border-slate-600/60 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-emerald-500/70 hover:text-emerald-100"
        >
          トリミングへ戻る
        </button>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6" style={{ maxWidth: '100%', overflow: 'hidden' }}>
        <section className="flex flex-1 flex-col gap-4 rounded-3xl border border-slate-800/70 bg-slate-900/40 p-5 shadow-2xl shadow-black/40">
          <form
            className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-700/60 bg-slate-950/80 px-4 py-3"
            onSubmit={handleSearchSubmit}
          >
            <div className="flex min-w-[16rem] flex-1 items-center gap-2">
              <span className="text-xs text-slate-400">Youtube検索</span>
              <input
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="曲名やアーティスト名"
                className="flex-1 bg-transparent text-sm text-slate-100 outline-none"
              />
            </div>
            <button
              type="submit"
              className="rounded-full bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow shadow-indigo-900/40 transition hover:bg-indigo-400 disabled:opacity-60"
              disabled={searching}
            >
              {searching ? "検索中..." : "検索"}
            </button>
          </form>
          {searchError && (
            <p className="text-xs text-rose-300">{searchError}</p>
          )}
          <div className="flex flex-1 flex-col gap-4 overflow-hidden">
            {selectedVideo ? (
              <div className="relative w-full max-w-4xl self-center overflow-hidden rounded-2xl border border-slate-700/60 bg-black" style={{ aspectRatio: '16/9', contain: 'layout size style' }}>
                <iframe
                  key={selectedVideo.videoId}
                  src={videoSrc}
                  title={selectedVideo.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="absolute inset-0 h-full w-full"
                  style={{ 
                    maxWidth: '100%', 
                    maxHeight: '100%',
                    border: 'none',
                    outline: 'none'
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-slate-700/60 bg-slate-950/60 text-sm text-slate-400">
                動画を検索して選択してください
              </div>
            )}

            {searchResults.length > 0 && (
              <div className="flex gap-3 overflow-x-auto pb-2">
                {searchResults.map((video) => {
                  const isActive = selectedVideo?.videoId === video.videoId;
                  return (
                    <button
                      key={video.videoId}
                      type="button"
                      onClick={() => setSelectedVideo(video)}
                      className={`flex min-w-[12rem] flex-col gap-2 rounded-2xl border px-3 py-3 text-left text-xs transition ${
                        isActive
                          ? "border-emerald-500/80 bg-emerald-500/10 text-emerald-100"
                          : "border-slate-700/60 bg-slate-900/60 text-slate-300 hover:border-emerald-500/60 hover:text-emerald-100"
                      }`}
                    >
                      <div className="relative h-24 overflow-hidden rounded-xl border border-slate-700/50 bg-black">
                        {video.thumbnailUrl ? (
                          <img
                            src={video.thumbnailUrl}
                            alt={video.title}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">
                            サムネイルなし
                          </span>
                        )}
                      </div>
                      <span className="line-clamp-2 text-xs font-medium">{video.title}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="flex flex-1 flex-col gap-4 rounded-3xl border border-slate-800/70 bg-slate-900/40 p-5 shadow-2xl shadow-black/40">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-sm text-slate-200">
              <label className="flex items-center gap-2">
                <span className="text-xs text-slate-400">BPM</span>
                <input
                  type="number"
                  value={bpm}
                  min={MIN_BPM}
                  max={MAX_BPM}
                  onChange={handleBpmChange}
                  className="w-20 rounded-lg border border-slate-700/60 bg-slate-950 px-2 py-1 text-right text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                />
              </label>
              <span className="text-xs text-slate-500">
                ピクセル速度: 約{Math.round((bpm / 60) * SCROLL_PIXELS_PER_BEAT)}px/s
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleStartScroll}
                className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow shadow-emerald-900/40 transition hover:bg-emerald-400 disabled:opacity-60"
                disabled={isScrolling || pages.length === 0 || loadingPages}
              >
                再生
              </button>
              <button
                type="button"
                onClick={handlePauseScroll}
                className="rounded-full border border-slate-600/60 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-slate-100 disabled:opacity-60"
                disabled={!isScrolling}
              >
                一時停止
              </button>
              <button
                type="button"
                onClick={handleResetScroll}
                className="rounded-full border border-slate-600/60 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-slate-100"
              >
                先頭に戻る
              </button>
            </div>
          </div>

          {renderError && (
            <div className="rounded-2xl border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {renderError}
            </div>
          )}

          <div
            ref={scrollContainerRef}
            className="relative flex-1 overflow-x-auto overflow-y-hidden rounded-2xl border border-slate-800/70 bg-slate-950/60"
          >
            {loadingPages ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                楽譜を読み込んでいます…
              </div>
            ) : pages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                表示できる楽譜がありません
              </div>
            ) : (
              <div className="flex h-full items-center gap-6 px-10">
                {pages.map((page) => (
                  <img
                    key={`practice-${page.pageNumber}`}
                    src={page.dataUrl}
                    alt={`楽譜 ${page.pageNumber}`}
                    className="h-full max-h-[70vh] w-auto flex-shrink-0 rounded-xl border border-slate-700/60 bg-slate-900/80 object-contain"
                    draggable={false}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function PracticePage(): ReactElement {
  const { practiceData } = usePractice();
  const navigate = useNavigate();

  useEffect(() => {
    if (!practiceData) {
      navigate("/", { replace: true });
    }
  }, [practiceData, navigate]);

  if (!practiceData) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 text-slate-300">
        <p>練習用のデータが見つかりませんでした。</p>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-full border border-slate-600/60 px-4 py-2 text-sm text-slate-200 transition hover:border-emerald-500/70 hover:text-emerald-100"
        >
          トリミング画面へ戻る
        </button>
      </div>
    );
  }

  return (
    <PracticeWorkspace
      title={practiceData.title}
      filename={practiceData.filename}
      pdfData={practiceData.pdfData}
      onExit={() => {
        navigate("/");
      }}
    />
  );
}

export default PracticePage;
