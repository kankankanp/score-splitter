import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  GlobalWorkerOptions,
  PasswordResponses,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker?url";
import { trimScore } from "./api/scoreClient";

type PdfPagePreview = {
  pageNumber: number;
  thumbnailUrl: string;
  originalWidth: number;
  originalHeight: number;
};

type SelectedPageImage = {
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
};

type CropArea = {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

type CornerHandle = "top-left" | "top-right" | "bottom-left" | "bottom-right";

type InteractionState =
  | {
      type: "creating";
      areaId: string;
      startX: number;
      startY: number;
    }
  | {
      type: "moving";
      areaId: string;
      offsetX: number;
      offsetY: number;
    }
  | {
      type: "resizing";
      areaId: string;
      handle: CornerHandle;
      origin: CropArea;
    };

GlobalWorkerOptions.workerSrc = workerSrc;

const MIN_AREA_SIZE = 0.01;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function createDefaultArea(): CropArea {
  return {
    id: crypto.randomUUID(),
    top: 0.05,
    left: 0.07,
    width: 0.86,
    height: 0.2,
  };
}

function clampArea(area: CropArea): CropArea {
  let { left, top, width, height } = area;

  left = clamp(left, 0, 1 - MIN_AREA_SIZE);
  top = clamp(top, 0, 1 - MIN_AREA_SIZE);
  width = clamp(width, MIN_AREA_SIZE, 1);
  height = clamp(height, MIN_AREA_SIZE, 1);

  if (left + width > 1) {
    width = Math.max(MIN_AREA_SIZE, 1 - left);
  }
  if (top + height > 1) {
    height = Math.max(MIN_AREA_SIZE, 1 - top);
  }

  return { ...area, left, top, width, height };
}

function sortAreasByTop(areas: CropArea[]): CropArea[] {
  return [...areas].sort((a, b) => a.top - b.top || a.left - b.left);
}

function App() {
  const [pdfName, setPdfName] = useState<string>("");
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfPages, setPdfPages] = useState<PdfPagePreview[]>([]);
  const [selectedPageNumber, setSelectedPageNumber] = useState<number | null>(
    null,
  );
  const [selectedPageImage, setSelectedPageImage] =
    useState<SelectedPageImage | null>(null);
  const [cropAreas, setCropAreas] = useState<CropArea[]>([createDefaultArea()]);
  const [activeAreaId, setActiveAreaId] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState<string>("");
  const [renderingPage, setRenderingPage] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [generating, setGenerating] = useState<boolean>(false);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState<boolean>(false);
  const [passwordPromptMessage, setPasswordPromptMessage] =
    useState<string>("");
  const [passwordValue, setPasswordValue] = useState<string>("");

  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const pageContainerRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<InteractionState | null>(null);
  const passwordResolverRef =
    useRef<((value: string | null) => void) | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const passwordCancelledRef = useRef<boolean>(false);

  const resetState = useCallback(() => {
    pdfDocumentRef.current = null;
    setPdfBytes(null);
    setPdfPages([]);
    setSelectedPageNumber(null);
    setSelectedPageImage(null);
    setCropAreas([createDefaultArea()]);
    setActiveAreaId(null);
    setStatusMessage("");
    setErrorMessage("");
    setPdfName("");
    if (passwordResolverRef.current) {
      passwordResolverRef.current(null);
    }
    passwordResolverRef.current = null;
    passwordCancelledRef.current = false;
    setPasswordPromptOpen(false);
    setPasswordPromptMessage("");
    setPasswordValue("");
  }, []);

  useEffect(() => {
    if (!passwordPromptOpen) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      passwordInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [passwordPromptOpen]);

  const requestPassword = useCallback((message: string) => {
    return new Promise<string | null>((resolve) => {
      if (passwordResolverRef.current) {
        passwordResolverRef.current(null);
      }
      passwordResolverRef.current = resolve;
      setPasswordPromptMessage(message);
      setPasswordValue("");
      setPasswordPromptOpen(true);
      setLoadingMessage("パスワードの入力を待機しています…");
    });
  }, []);

  const handlePasswordSubmit = useCallback(() => {
    if (passwordValue.length === 0) {
      return;
    }
    const resolver = passwordResolverRef.current;
    if (resolver) {
      resolver(passwordValue);
    }
    passwordResolverRef.current = null;
    setPasswordPromptOpen(false);
    setPasswordValue("");
    setLoadingMessage("PDFを読み込んでいます…");
  }, [passwordValue]);

  const handlePasswordCancel = useCallback(() => {
    const resolver = passwordResolverRef.current;
    if (resolver) {
      resolver(null);
    }
    passwordResolverRef.current = null;
    setPasswordPromptOpen(false);
    setPasswordValue("");
    setLoadingMessage("");
  }, []);

  const handlePasswordInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setPasswordValue(event.target.value);
    },
    [],
  );

  const handlePasswordKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handlePasswordCancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        handlePasswordSubmit();
      }
    },
    [handlePasswordCancel, handlePasswordSubmit],
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      resetState();
      setPdfName(file.name);
      setLoadingMessage("PDFを読み込んでいます…");

      passwordCancelledRef.current = false;

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        setPdfBytes(bytes);

        const loadingTask = getDocument({ data: bytes });
        loadingTask.onPassword = (updatePassword: (arg0: string) => void, reason: number) => {
          const message =
            reason === PasswordResponses.NEED_PASSWORD
              ? "このPDFはパスワードで保護されています。パスワードを入力してください。"
              : "パスワードが違います。もう一度入力してください。";

          void requestPassword(message).then((password) => {
            if (typeof password === "string") {
              updatePassword(password);
              return;
            }

            void loadingTask.destroy();
            passwordCancelledRef.current = true;
            resetState();
            setLoadingMessage("");
            setErrorMessage("パスワード入力をキャンセルしました");
          });
        };
        const doc = await loadingTask.promise;
        pdfDocumentRef.current = doc;

        const previews: PdfPagePreview[] = [];

        for (let index = 1; index <= doc.numPages; index += 1) {
          const page = await doc.getPage(index);
          const viewport = page.getViewport({ scale: 1 });
          const targetWidth = 180;
          const scale = clamp(targetWidth / viewport.width, 0.2, 2.5);
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
          previews.push({
            pageNumber: index,
            thumbnailUrl: canvas.toDataURL("image/png"),
            originalWidth: viewport.width,
            originalHeight: viewport.height,
          });
          page.cleanup();
        }

        setPdfPages(previews);
        setSelectedPageNumber(previews[0]?.pageNumber ?? null);
        const initialArea = createDefaultArea();
        setCropAreas([initialArea]);
        setActiveAreaId(initialArea.id);
        setStatusMessage("");
        setErrorMessage("");
      } catch (error) {
        const isPasswordError =
          passwordCancelledRef.current ||
          (error instanceof Error && error.name === "PasswordException");

        if (!isPasswordError) {
          console.error(error);
          setErrorMessage("PDFの読み込みに失敗しました");
          resetState();
        }
        passwordCancelledRef.current = false;
      } finally {
        setLoadingMessage("");
        event.target.value = "";
      }
    },
    [requestPassword, resetState],
  );

  useEffect(() => {
    let cancelled = false;

    const renderSelectedPage = async () => {
      if (!pdfDocumentRef.current || !selectedPageNumber) {
        setSelectedPageImage(null);
        return;
      }

      setRenderingPage(true);
      try {
        const page = await pdfDocumentRef.current.getPage(selectedPageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const targetWidth = 900;
        const scale = clamp(targetWidth / viewport.width, 1, 3);
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
          setSelectedPageImage({
            pageNumber: selectedPageNumber,
            dataUrl: canvas.toDataURL("image/png"),
            width: renderViewport.width,
            height: renderViewport.height,
          });
        }
        page.cleanup();
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setErrorMessage("ページの描画に失敗しました");
        }
      } finally {
        if (!cancelled) {
          setRenderingPage(false);
        }
      }
    };

    renderSelectedPage();

    return () => {
      cancelled = true;
    };
  }, [selectedPageNumber, pdfBytes]);

  const sortedAreas = useMemo(() => sortAreasByTop(cropAreas), [cropAreas]);

  const getRelativePosition = useCallback((event: ReactPointerEvent) => {
    if (!pageContainerRef.current) {
      return { x: 0, y: 0 };
    }
    const rect = pageContainerRef.current.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    return { x, y };
  }, []);

  const updateArea = useCallback((areaId: string, updater: (current: CropArea) => CropArea) => {
    setCropAreas((current) =>
      current.map((area) =>
        area.id === areaId ? clampArea(updater(area)) : area,
      ),
    );
  }, []);

  const handleContainerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!selectedPageImage || !pageContainerRef.current) {
        return;
      }

      const target = event.target as HTMLElement;
      if (target.dataset.handle || target.dataset.areaId) {
        return;
      }

      const { x, y } = getRelativePosition(event);
      const newAreaId = crypto.randomUUID();
      const initialArea: CropArea = clampArea({
        id: newAreaId,
        top: y,
        left: x,
        width: MIN_AREA_SIZE,
        height: MIN_AREA_SIZE,
      });
      setCropAreas((current) => [...current, initialArea]);
      setActiveAreaId(newAreaId);
      interactionRef.current = {
        type: "creating",
        areaId: newAreaId,
        startX: x,
        startY: y,
      };
      pageContainerRef.current.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [getRelativePosition, selectedPageImage],
  );

  const handleAreaPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, area: CropArea) => {
    if (!pageContainerRef.current) {
      return;
    }
    const { x, y } = getRelativePosition(event);
    interactionRef.current = {
      type: "moving",
      areaId: area.id,
      offsetX: x - area.left,
      offsetY: y - area.top,
    };
    setActiveAreaId(area.id);
    pageContainerRef.current.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, [getRelativePosition]);

  const handleHandlePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLButtonElement>,
      area: CropArea,
      handle: CornerHandle,
    ) => {
      if (!pageContainerRef.current) {
        return;
      }
      interactionRef.current = {
        type: "resizing",
        areaId: area.id,
        handle,
        origin: { ...area },
      };
      setActiveAreaId(area.id);
      pageContainerRef.current.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }
      const { x, y } = getRelativePosition(event);

      if (interaction.type === "creating") {
        const { startX, startY, areaId } = interaction;
        updateArea(areaId, () => {
          const left = Math.min(startX, x);
          const top = Math.min(startY, y);
          const right = Math.max(startX, x);
          const bottom = Math.max(startY, y);
          return {
            id: areaId,
            left,
            top,
            width: Math.max(MIN_AREA_SIZE, right - left),
            height: Math.max(MIN_AREA_SIZE, bottom - top),
          };
        });
      } else if (interaction.type === "moving") {
        const { areaId, offsetX, offsetY } = interaction;
        updateArea(areaId, (area) => ({
          ...area,
          left: x - offsetX,
          top: y - offsetY,
        }));
      } else if (interaction.type === "resizing") {
        const { areaId, handle, origin } = interaction;
        const originRight = origin.left + origin.width;
        const originBottom = origin.top + origin.height;

        updateArea(areaId, (area) => {
          switch (handle) {
            case "top-left": {
              const left = clamp(x, 0, originRight - MIN_AREA_SIZE);
              const top = clamp(y, 0, originBottom - MIN_AREA_SIZE);
              return {
                ...area,
                left,
                top,
                width: originRight - left,
                height: originBottom - top,
              };
            }
            case "top-right": {
              const right = clamp(x, origin.left + MIN_AREA_SIZE, 1);
              const top = clamp(y, 0, originBottom - MIN_AREA_SIZE);
              return {
                ...area,
                top,
                width: right - origin.left,
                height: originBottom - top,
              };
            }
            case "bottom-left": {
              const left = clamp(x, 0, originRight - MIN_AREA_SIZE);
              const bottom = clamp(y, origin.top + MIN_AREA_SIZE, 1);
              return {
                ...area,
                left,
                width: originRight - left,
                height: bottom - origin.top,
              };
            }
            case "bottom-right": {
              const right = clamp(x, origin.left + MIN_AREA_SIZE, 1);
              const bottom = clamp(y, origin.top + MIN_AREA_SIZE, 1);
              return {
                ...area,
                width: right - origin.left,
                height: bottom - origin.top,
              };
            }
            default:
              return area;
          }
        });
      }
    },
    [getRelativePosition, updateArea],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const interaction = interactionRef.current;
      if (interaction) {
        if (interaction.type === "creating") {
          const createdArea = cropAreas.find((area) => area.id === interaction.areaId);
          if (
            createdArea &&
            (createdArea.width <= MIN_AREA_SIZE * 1.1 ||
              createdArea.height <= MIN_AREA_SIZE * 1.1)
          ) {
            setCropAreas((current) =>
              current.filter((area) => area.id !== interaction.areaId),
            );
            setActiveAreaId(null);
          }
        }
        interactionRef.current = null;
      }
      if (pageContainerRef.current?.hasPointerCapture(event.pointerId)) {
        pageContainerRef.current.releasePointerCapture(event.pointerId);
      }
    },
    [cropAreas],
  );

  const handleAddArea = useCallback(() => {
    const next = createDefaultArea();
    setCropAreas((current) => [...current, next]);
    setActiveAreaId(next.id);
  }, []);

  const handleRemoveArea = useCallback((areaId: string) => {
    setCropAreas((current) => {
      if (current.length <= 1) {
        return current;
      }
      const filtered = current.filter((area) => area.id !== areaId);
      if (filtered.length === 0) {
        return current;
      }
      if (activeAreaId === areaId) {
        setActiveAreaId(filtered[0].id);
      }
      return filtered;
    });
  }, [activeAreaId]);

  const handleExport = useCallback(async () => {
    if (!pdfBytes || sortedAreas.length === 0) {
      setErrorMessage("トリミングエリアを設定してください");
      return;
    }

    setErrorMessage("");
    setStatusMessage("");
    setGenerating(true);

    try {
      const baseTitle = pdfName.replace(/\.pdf$/i, "") || "trimmed-score";
      const response = await trimScore({
        title: baseTitle,
        pdfBytes,
        areas: sortedAreas.map((area) => ({
          top: area.top,
          left: area.left,
          width: area.width,
          height: area.height,
        })),
      });

      const sourceBuffer = response.pdfData.buffer;
      const arrayBuffer =
        response.pdfData.byteOffset === 0 &&
        response.pdfData.byteLength === sourceBuffer.byteLength
          ? (sourceBuffer as ArrayBuffer)
          : (sourceBuffer.slice(
              response.pdfData.byteOffset,
              response.pdfData.byteOffset + response.pdfData.byteLength,
            ) as ArrayBuffer);

      const blob = new Blob([arrayBuffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.filename || `${baseTitle}-trimmed.pdf`;
      link.click();
      setStatusMessage(response.message || "トリミング済みPDFをダウンロードしました");
      setErrorMessage("");
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1500);
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        setErrorMessage(error.message || "PDFの生成に失敗しました");
      } else {
        setErrorMessage("PDFの生成に失敗しました");
      }
    } finally {
      setGenerating(false);
    }
  }, [pdfBytes, pdfName, sortedAreas]);

  const canExport = pdfBytes !== null && sortedAreas.length > 0 && !generating;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-100">
          楽譜PDFトリミング
        </h1>
        <p className="text-sm text-slate-400">
          PDFを読み込んで全ページプレビューし、共通のトリミング範囲を指定したうえで新しいPDFとして書き出します。
        </p>
      </header>

      <section className="rounded-3xl bg-slate-900/60 p-6 shadow-2xl shadow-slate-950/50">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm text-slate-200">
            <span className="font-semibold text-slate-100">PDFファイルを選択</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              className="w-full cursor-pointer rounded-xl border border-dashed border-slate-600/60 bg-slate-900/60 px-4 py-3 text-base text-slate-100 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-500 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:border-indigo-500/60"
            />
          </label>
          {loadingMessage && (
            <p className="text-sm text-indigo-300">{loadingMessage}</p>
          )}
          {pdfName && (
            <p className="text-sm text-slate-400">
              選択中: <span className="font-medium text-slate-200">{pdfName}</span>
            </p>
          )}
        </div>
      </section>

      {errorMessage && (
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-200">
          {errorMessage}
        </div>
      )}
      {statusMessage && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-200">
          {statusMessage}
        </div>
      )}

      {pdfPages.length > 0 && (
        <section className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-100">トリミングプレビュー</h2>
              <button
                type="button"
                onClick={handleAddArea}
                className="rounded-full bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 shadow shadow-slate-950/50 transition hover:bg-slate-700"
              >
                エリア追加
              </button>
            </div>
            <p className="text-xs text-slate-400">
              プレビュー内をドラッグしてエリアを追加できます。エリア枠をドラッグして移動・リサイズしてください。
            </p>
            <div
              ref={pageContainerRef}
              className="relative overflow-hidden rounded-3xl border border-slate-700/60 bg-slate-950/40"
              onPointerDown={handleContainerPointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            >
              {selectedPageImage ? (
                <>
                  <img
                    src={selectedPageImage.dataUrl}
                    alt={`ページ${selectedPageImage.pageNumber}`}
                    className="block w-full select-none"
                    draggable={false}
                  />
                  <div className="pointer-events-none absolute inset-0">
                    {cropAreas.map((area) => {
                      const isActive = area.id === activeAreaId;
                      return (
                        <div
                          key={area.id}
                          data-area-id={area.id}
                          className={`pointer-events-auto absolute border-2 ${
                            isActive
                              ? "border-emerald-400 bg-emerald-400/15"
                              : "border-emerald-400/60 bg-emerald-400/10"
                          }`}
                          style={{
                            left: `${area.left * 100}%`,
                            top: `${area.top * 100}%`,
                            width: `${area.width * 100}%`,
                            height: `${area.height * 100}%`,
                          }}
                          onPointerDown={(event) =>
                            handleAreaPointerDown(event, area)
                          }
                        >
                          {(["top-left", "top-right", "bottom-left", "bottom-right"] as CornerHandle[]).map(
                            (handle) => (
                              <button
                                key={handle}
                                type="button"
                                data-handle={handle}
                                onPointerDown={(event) =>
                                  handleHandlePointerDown(event, area, handle)
                                }
                                className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-emerald-200/70 bg-emerald-300/80 shadow ${
                                  isActive ? "" : "opacity-60"
                                }`}
                                style={{
                                  left: handle.includes("right") ? "100%" : "0%",
                                  top: handle.includes("bottom") ? "100%" : "0%",
                                  cursor:
                                    handle === "top-left"
                                      ? "nwse-resize"
                                      : handle === "top-right"
                                        ? "nesw-resize"
                                        : handle === "bottom-left"
                                          ? "nesw-resize"
                                          : "nwse-resize",
                                }}
                              />
                            ),
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="flex h-80 items-center justify-center text-sm text-slate-500">
                  {renderingPage ? "ページを描画しています…" : "ページを選択してください"}
                </div>
              )}
            </div>
          </div>

          <aside className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-slate-100">トリミングエリア</h2>
            <ul className="space-y-3">
              {sortedAreas.map((area, index) => (
                <li
                  key={area.id}
                  className={`flex items-start justify-between rounded-2xl border px-4 py-3 text-sm ${
                    area.id === activeAreaId
                      ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-100"
                      : "border-slate-700/60 bg-slate-900/60 text-slate-200"
                  }`}
                >
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => setActiveAreaId(area.id)}
                  >
                    <div className="font-semibold">エリア{index + 1}</div>
                    <div className="text-xs opacity-80">
                      上 {Math.round(area.top * 100)}% / 左 {Math.round(area.left * 100)}% / 幅 {Math.round(area.width * 100)}% / 高さ {Math.round(area.height * 100)}%
                    </div>
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-slate-600/60 px-3 py-1 text-xs text-slate-300 transition hover:border-rose-400/70 hover:text-rose-200 disabled:opacity-40"
                    onClick={() => handleRemoveArea(area.id)}
                    disabled={cropAreas.length <= 1}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={handleExport}
              disabled={!canExport}
              className="mt-2 inline-flex items-center justify-center rounded-full bg-gradient-to-r from-indigo-500 via-indigo-400 to-violet-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:scale-[1.02] hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
            >
              {generating ? "生成中…" : "トリミングPDFをダウンロード"}
            </button>
          </aside>
        </section>
      )}

      {pdfPages.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">ページプレビュー</h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {pdfPages.map((page) => (
              <button
                key={page.pageNumber}
                type="button"
                onClick={() => setSelectedPageNumber(page.pageNumber)}
                className={`flex flex-col items-center gap-2 rounded-2xl border px-3 pb-3 pt-2 text-xs transition ${
                  page.pageNumber === selectedPageNumber
                    ? "border-indigo-400/70 bg-indigo-500/10 text-indigo-100"
                    : "border-slate-700/60 bg-slate-900/60 text-slate-300 hover:border-indigo-500/60 hover:text-indigo-200"
                }`}
              >
                <img
                  src={page.thumbnailUrl}
                  alt={`サムネイル ${page.pageNumber}`}
                  className="h-32 w-auto select-none rounded-xl border border-slate-700/50 object-contain"
                  draggable={false}
                />
                <span>ページ {page.pageNumber}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {passwordPromptOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700/70 bg-slate-900/90 p-6 shadow-2xl shadow-black/60">
            <h3 className="text-lg font-semibold text-slate-100">PDFパスワード</h3>
            <p className="mt-2 text-sm text-slate-300">{passwordPromptMessage}</p>
            <input
              ref={passwordInputRef}
              type="password"
              value={passwordValue}
              onChange={handlePasswordInputChange}
              onKeyDown={handlePasswordKeyDown}
              className="mt-4 w-full rounded-xl border border-slate-700/60 bg-slate-950 px-4 py-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              placeholder="パスワード"
            />
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={handlePasswordCancel}
                className="rounded-full border border-slate-600/70 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handlePasswordSubmit}
                className="rounded-full bg-indigo-500 px-5 py-2 text-sm font-semibold text-white shadow shadow-indigo-900/50 transition hover:bg-indigo-400 disabled:opacity-60"
                disabled={passwordValue.length === 0}
              >
                送信
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
