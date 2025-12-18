import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker?url";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { usePractice } from "./practiceContext";
import { useLanguage } from "./hooks/useLanguage";

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
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
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
  const { t } = useTranslation();
  const [pages, setPages] = useState<PracticePageImage[]>([]);
  const [loadingPages, setLoadingPages] = useState<boolean>(true);
  const [renderError, setRenderError] = useState<string>("");
  const [bpm, setBpm] = useState<number>(80);
  const [isScrolling, setIsScrolling] = useState<boolean>(false);

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
            await page.render({
              canvasContext: context,
              viewport: renderViewport,
              canvas,
            }).promise;
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
          setRenderError(t('errors.scoreLoadFailed'));
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

        if (
          container.scrollLeft + container.clientWidth >=
          container.scrollWidth - 1
        ) {
          container.scrollLeft = Math.max(
            0,
            container.scrollWidth - container.clientWidth
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

  const handleBpmChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value);
      if (Number.isFinite(value)) {
        setBpm(Math.round(clamp(value, MIN_BPM, MAX_BPM)));
      }
    },
    []
  );

  return (
    <div
      className="min-h-screen bg-slate-50 text-slate-900"
      style={{ contain: "layout style", maxWidth: "100vw", overflow: "hidden" }}
    >
      <header className="flex items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-4 backdrop-blur">
        <div>
          <h1 className="text-2xl font-semibold">{t('practice.title')}</h1>
          <p className="text-xs text-slate-600">
            {title} / {filename}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setIsScrolling(false);
            onExit();
          }}
          className="rounded-full border border-slate-400 px-4 py-2 text-sm font-medium text-slate-800 transition hover:border-emerald-500 hover:text-emerald-700"
        >
          {t('buttons.backToTrimming')}
        </button>
      </header>

      <div
        className="flex flex-1 flex-col gap-6 p-6"
        style={{ maxWidth: "100%", overflow: "hidden" }}
      >
        <section className="flex flex-1 flex-col gap-4 rounded-3xl border border-slate-200 bg-white/60 p-5 shadow-2xl shadow-black/10">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-sm text-slate-800">
              <label className="flex items-center gap-2">
                <span className="text-xs text-slate-600">{t('practice.bpmLabel')}</span>
                <input
                  type="number"
                  value={bpm}
                  min={MIN_BPM}
                  max={MAX_BPM}
                  onChange={handleBpmChange}
                  className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1 text-right text-slate-900 focus:border-emerald-500 focus:outline-none"
                />
              </label>
              <span className="text-xs text-slate-500">
                {t('practice.pixelSpeed', { speed: Math.round((bpm / 60) * SCROLL_PIXELS_PER_BEAT) })}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleStartScroll}
                className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow shadow-emerald-900/40 transition hover:bg-emerald-400 disabled:opacity-60"
                disabled={isScrolling || pages.length === 0 || loadingPages}
              >
                {t('buttons.start')}
              </button>
              <button
                type="button"
                onClick={handlePauseScroll}
                className="rounded-full border border-slate-400 px-4 py-2 text-sm font-medium text-slate-800 transition hover:border-slate-600 hover:text-slate-900 disabled:opacity-60"
                disabled={!isScrolling}
              >
                {t('buttons.pause')}
              </button>
              <button
                type="button"
                onClick={handleResetScroll}
                className="rounded-full border border-slate-400 px-4 py-2 text-sm font-medium text-slate-800 transition hover:border-slate-600 hover:text-slate-900"
              >
                {t('buttons.reset')}
              </button>
            </div>
          </div>

          {renderError && (
            <div className="rounded-2xl border border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {renderError}
            </div>
          )}

          <div
            ref={scrollContainerRef}
            className="relative flex-1 overflow-x-auto overflow-y-hidden rounded-2xl border border-slate-200 bg-white/80"
          >
            {loadingPages ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-600">
                {t('practice.loadingScore')}
              </div>
            ) : pages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-600">
                {t('practice.noScore')}
              </div>
            ) : (
              <div className="flex h-full items-center gap-6 px-10">
                {pages.map((page) => (
                  <img
                    key={`practice-${page.pageNumber}`}
                    src={page.dataUrl}
                    alt={t('practice.scoreAlt', { pageNumber: page.pageNumber })}
                    className="h-full max-h-[70vh] w-auto flex-shrink-0 rounded-xl border border-slate-300 bg-white object-contain"
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
  const { t } = useTranslation();
  const { navigateWithLanguage } = useLanguage();
  const { practiceData, setPracticeData } = usePractice();

  useEffect(() => {
    if (!practiceData) {
      navigateWithLanguage("/");
    }
  }, [practiceData, navigateWithLanguage]);

  if (!practiceData) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 text-slate-700">
        <p>{t('practice.noDataFound')}</p>
        <button
          type="button"
          onClick={() => {
            setPracticeData(null); // Clear just in case
            navigateWithLanguage("/");
          }}
          className="rounded-full border border-slate-400 px-4 py-2 text-sm text-slate-800 transition hover:border-emerald-500 hover:text-emerald-700"
        >
          {t('practice.backToTrimming')}
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
        setPracticeData(null); // Clear practice data
        navigateWithLanguage("/");
      }}
    />
  );
}

export default PracticePage;
