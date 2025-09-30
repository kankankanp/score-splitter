import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
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
import {
  trimScore,
  searchYoutubeVideos,
  type YoutubeVideo,
} from "./api/scoreClient";

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

type PracticePage = {
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
};

type PracticeData = {
  pdfData: Uint8Array;
  title: string;
  filename: string;
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
const SCROLL_PIXELS_PER_BEAT = 120;
const MIN_BPM = 30;
const MAX_BPM = 240;

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

function cloneAreasWithNewIds(areas: CropArea[]): CropArea[] {
  return areas.map((area) => ({
    ...area,
    id: crypto.randomUUID(),
  }));
}

function App() {
  const [pdfName, setPdfName] = useState<string>("");
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfPages, setPdfPages] = useState<PdfPagePreview[]>([]);
  const [excludedPageNumbers, setExcludedPageNumbers] = useState<number[]>([]);
  const [selectedPageNumber, setSelectedPageNumber] = useState<number | null>(
    null,
  );
  const [selectedPageImage, setSelectedPageImage] =
    useState<SelectedPageImage | null>(null);
  const [viewMode, setViewMode] = useState<"editor" | "practice">("editor");
  const [practiceData, setPracticeData] = useState<PracticeData | null>(null);
  const [globalAreas, setGlobalAreas] = useState<CropArea[]>([
    createDefaultArea(),
  ]);
  const [pageSpecificAreas, setPageSpecificAreas] = useState<
    Record<number, CropArea[]>
  >({});
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
  const [pdfPassword, setPdfPassword] = useState<string | null>(null);

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
    setExcludedPageNumbers([]);
    setSelectedPageNumber(null);
    setSelectedPageImage(null);
    setGlobalAreas([createDefaultArea()]);
    setPageSpecificAreas({});
    setPracticeData(null);
    setViewMode("editor");
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
    setPdfPassword(null);
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

  // eslint-disable-next-line react-hooks/rules-of-hooks
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

  // eslint-disable-next-line react-hooks/rules-of-hooks
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

  // eslint-disable-next-line react-hooks/rules-of-hooks
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
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const storedBytes = new Uint8Array(bytes);
        setPdfBytes(storedBytes);
        setExcludedPageNumbers([]);

        const loadingTask = getDocument({ data: bytes });
        loadingTask.onPassword = (updatePassword: (arg0: string) => void, reason: number) => {
          const message =
            reason === PasswordResponses.NEED_PASSWORD
              ? "このPDFはパスワードで保護されています。パスワードを入力してください。"
              : "パスワードが違います。もう一度入力してください。";

          void requestPassword(message).then((password) => {
            if (typeof password === "string") {
              setPdfPassword(password);
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
        setGlobalAreas([initialArea]);
        setPageSpecificAreas({});
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

  // eslint-disable-next-line react-hooks/rules-of-hooks
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

  const availablePages = useMemo(() => {
    if (excludedPageNumbers.length === 0) {
      return pdfPages;
    }
    const excludedSet = new Set(excludedPageNumbers);
    return pdfPages.filter((page) => !excludedSet.has(page.pageNumber));
  }, [pdfPages, excludedPageNumbers]);

  const excludedPages = useMemo(() => {
    if (excludedPageNumbers.length === 0) {
      return [] as PdfPagePreview[];
    }
    const excludedSet = new Set(excludedPageNumbers);
    return pdfPages.filter((page) => excludedSet.has(page.pageNumber));
  }, [pdfPages, excludedPageNumbers]);

  const selectedPageHasSpecific = useMemo(() => {
    if (selectedPageNumber === null) {
      return false;
    }
    return Boolean(pageSpecificAreas[selectedPageNumber]);
  }, [pageSpecificAreas, selectedPageNumber]);

  const currentAreas = useMemo(() => {
    if (selectedPageNumber !== null) {
      const override = pageSpecificAreas[selectedPageNumber];
      if (override) {
        return override;
      }
    }
    return globalAreas;
  }, [globalAreas, pageSpecificAreas, selectedPageNumber]);

  const sortedAreas = useMemo(() => sortAreasByTop(currentAreas), [currentAreas]);

  const mutateCurrentAreas = useCallback(
    (updater: (areas: CropArea[]) => CropArea[]) => {
      if (selectedPageHasSpecific && selectedPageNumber !== null) {
        setPageSpecificAreas((current) => {
          const existing = current[selectedPageNumber] ?? [];
          const nextAreas = updater(existing);
          return {
            ...current,
            [selectedPageNumber]: nextAreas,
          };
        });
        return;
      }
      setGlobalAreas((current) => updater(current));
    },
    [selectedPageHasSpecific, selectedPageNumber],
  );

  useEffect(() => {
    if (currentAreas.length === 0) {
      setActiveAreaId(null);
      return;
    }
    if (!currentAreas.some((area) => area.id === activeAreaId)) {
      setActiveAreaId(currentAreas[0].id);
    }
  }, [activeAreaId, currentAreas]);

  useEffect(() => {
    if (availablePages.length === 0) {
      if (selectedPageNumber !== null) {
        setSelectedPageNumber(null);
      }
      return;
    }
    const firstPageNumber = availablePages[0]?.pageNumber ?? null;
    if (selectedPageNumber === null) {
      setSelectedPageNumber(firstPageNumber);
      return;
    }
    const stillAvailable = availablePages.some(
      (page) => page.pageNumber === selectedPageNumber,
    );
    if (!stillAvailable) {
      setSelectedPageNumber(firstPageNumber);
    }
  }, [availablePages, selectedPageNumber]);

  const availablePageCount = availablePages.length;

  const getRelativePosition = useCallback((event: ReactPointerEvent) => {
    if (!pageContainerRef.current) {
      return { x: 0, y: 0 };
    }
    const rect = pageContainerRef.current.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    return { x, y };
  }, []);

  const updateArea = useCallback(
    (areaId: string, updater: (current: CropArea) => CropArea) => {
      mutateCurrentAreas((areas) =>
        areas.map((area) =>
          area.id === areaId ? clampArea(updater(area)) : area,
        ),
      );
    },
    [mutateCurrentAreas],
  );

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
      mutateCurrentAreas((areas) => [...areas, initialArea]);
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
    [getRelativePosition, mutateCurrentAreas, selectedPageImage],
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
          const createdArea = currentAreas.find(
            (area) => area.id === interaction.areaId,
          );
          if (
            createdArea &&
            (createdArea.width <= MIN_AREA_SIZE * 1.1 ||
              createdArea.height <= MIN_AREA_SIZE * 1.1)
          ) {
            mutateCurrentAreas((areas) =>
              areas.filter((area) => area.id !== interaction.areaId),
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
    [currentAreas, mutateCurrentAreas],
  );

  const handleAddArea = useCallback(() => {
    const next = createDefaultArea();
    mutateCurrentAreas((areas) => [...areas, next]);
    setActiveAreaId(next.id);
  }, [mutateCurrentAreas]);

  const handleRemoveArea = useCallback((areaId: string) => {
    if (currentAreas.length <= 1) {
      return;
    }
    const filtered = currentAreas.filter((area) => area.id !== areaId);
    if (filtered.length === currentAreas.length) {
      return;
    }
    mutateCurrentAreas(() => filtered);
    if (filtered.length > 0) {
      if (activeAreaId === areaId) {
        setActiveAreaId(filtered[0].id);
      }
    } else {
      setActiveAreaId(null);
    }
  }, [activeAreaId, currentAreas, mutateCurrentAreas]);

  const handleEnablePageSpecific = useCallback(() => {
    if (selectedPageNumber === null) {
      return;
    }
    let createdAreas: CropArea[] | undefined;
    setPageSpecificAreas((current) => {
      if (current[selectedPageNumber]) {
        createdAreas = current[selectedPageNumber];
        return current;
      }
      const cloned = cloneAreasWithNewIds(globalAreas);
      createdAreas = cloned;
      return {
        ...current,
        [selectedPageNumber]: cloned,
      };
    });
    interactionRef.current = null;
    if (createdAreas && createdAreas.length > 0) {
      setActiveAreaId(createdAreas[0].id);
    }
  }, [globalAreas, selectedPageNumber]);

  const handleDisablePageSpecific = useCallback(() => {
    if (selectedPageNumber === null) {
      return;
    }
    setPageSpecificAreas((current) => {
      if (!current[selectedPageNumber]) {
        return current;
      }
      const { [selectedPageNumber]: _removed, ...rest } = current;
      return rest;
    });
    interactionRef.current = null;
    if (globalAreas.length > 0) {
      setActiveAreaId(globalAreas[0].id);
    } else {
      setActiveAreaId(null);
    }
  }, [globalAreas, selectedPageNumber]);

  const handleExcludePage = useCallback((pageNumber: number) => {
    if (availablePageCount <= 1) {
      setErrorMessage("トリミング対象は少なくとも1ページ必要です");
      return;
    }
    let updated = false;
    setExcludedPageNumbers((current) => {
      if (current.includes(pageNumber)) {
        return current;
      }
      updated = true;
      return [...current, pageNumber];
    });
    if (updated) {
      setErrorMessage("");
      setStatusMessage("");
    }
  }, [availablePageCount]);

  const handleRestorePage = useCallback((pageNumber: number) => {
    let restored = false;
    setExcludedPageNumbers((current) => {
      if (!current.includes(pageNumber)) {
        return current;
      }
      restored = true;
      return current.filter((value) => value !== pageNumber);
    });
    if (restored) {
      setErrorMessage("");
      setStatusMessage("");
    }
  }, []);

  const handleExport = useCallback(async () => {
    const hasDefaultAreas = globalAreas.length > 0;
    const hasPageOverrides = Object.values(pageSpecificAreas).some(
      (areas) => areas.length > 0,
    );
    if (!pdfBytes || (!hasDefaultAreas && !hasPageOverrides)) {
      setErrorMessage("トリミングエリアを設定してください");
      return;
    }

    const includePageNumbers = availablePages.map((page) => page.pageNumber);
    if (includePageNumbers.length === 0) {
      setErrorMessage("トリミング対象のページを選択してください");
      return;
    }

    const includePageSet = new Set(includePageNumbers);
    const defaultAreasForPayload = sortAreasByTop(globalAreas);

    const pagesRequiringDefault = includePageNumbers.filter(
      (pageNumber) => !pageSpecificAreas[pageNumber],
    );
    if (pagesRequiringDefault.length > 0 && defaultAreasForPayload.length === 0) {
      setErrorMessage("共通のトリミングエリアを設定してください");
      return;
    }

    for (const [pageKey, areas] of Object.entries(pageSpecificAreas)) {
      const pageNumber = Number(pageKey);
      if (includePageSet.has(pageNumber) && areas.length === 0) {
        setErrorMessage(`ページ${pageNumber}のトリミングエリアを設定してください`);
        return;
      }
    }

    setErrorMessage("");
    setStatusMessage("");
    setGenerating(true);

    try {
      const baseTitle = pdfName.replace(/\.pdf$/i, "") || "trimmed-score";
      const pageSettingsPayload = Object.entries(pageSpecificAreas)
        .filter(([pageKey, areas]) => {
          const pageNumber = Number(pageKey);
          return includePageSet.has(pageNumber) && areas.length > 0;
        })
        .map(([pageKey, areas]) => ({
          pageNumber: Number(pageKey),
          areas: sortAreasByTop(areas).map((area) => ({
            top: area.top,
            left: area.left,
            width: area.width,
            height: area.height,
          })),
        }));

      const response = await trimScore({
        title: baseTitle,
        pdfBytes,
        password: pdfPassword ?? undefined,
        areas: defaultAreasForPayload.map((area) => ({
          top: area.top,
          left: area.left,
          width: area.width,
          height: area.height,
        })),
        includePages: includePageNumbers,
        pageSettings: pageSettingsPayload,
      });

      setPracticeData({
        pdfData: new Uint8Array(response.pdfData),
        title: baseTitle,
        filename: response.filename || `${baseTitle}-trimmed.pdf`,
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
  }, [
    availablePages,
    globalAreas,
    pageSpecificAreas,
    pdfBytes,
    pdfName,
    pdfPassword,
  ]);

  const canExport =
    pdfBytes !== null &&
    availablePages.length > 0 &&
    !generating &&
    (globalAreas.length > 0 ||
      Object.values(pageSpecificAreas).some((areas) => areas.length > 0));

  if (viewMode === "practice" && practiceData) {
    return (
      <PracticeMode
        pdfData={practiceData.pdfData}
        title={practiceData.title}
        filename={practiceData.filename}
        onExit={() => setViewMode("editor")}
      />
    );
  }

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
          {practiceData && (
            <button
              type="button"
              onClick={() => setViewMode("practice")}
              className="self-start rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-white shadow shadow-emerald-900/40 transition hover:bg-emerald-400"
            >
              練習モードを開く
            </button>
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
            {selectedPageNumber !== null && (
              <div className="flex items-center justify-between rounded-2xl border border-slate-700/60 bg-slate-900/50 px-4 py-2 text-xs text-slate-300">
                <span>
                  {selectedPageHasSpecific
                    ? `ページ${selectedPageNumber}専用の設定を編集中`
                    : "共通設定を編集中"}
                </span>
                <div className="flex gap-2">
                  {selectedPageHasSpecific ? (
                    <button
                      type="button"
                      onClick={handleDisablePageSpecific}
                      className="rounded-full border border-slate-600/60 px-3 py-1 text-xs font-medium text-slate-200 transition hover:border-emerald-500/60 hover:text-emerald-200"
                    >
                      共通設定に戻す
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleEnablePageSpecific}
                      className="rounded-full border border-indigo-500/60 px-3 py-1 text-xs font-medium text-indigo-200 transition hover:bg-indigo-500/20"
                    >
                      このページ専用にする
                    </button>
                  )}
                </div>
              </div>
            )}
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
                    {currentAreas.map((area) => {
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
                    disabled={currentAreas.length <= 1}
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
            {availablePages.map((page) => {
              const isSelected = page.pageNumber === selectedPageNumber;
              return (
                <div key={page.pageNumber} className="relative">
                  <button
                    type="button"
                    onClick={() => setSelectedPageNumber(page.pageNumber)}
                    className={`flex min-w-[8rem] flex-col items-center gap-2 rounded-2xl border px-3 pb-3 pt-2 text-xs transition ${
                      isSelected
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
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      handleExcludePage(page.pageNumber);
                    }}
                    className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-slate-600/60 bg-slate-900/80 text-sm text-slate-300 shadow shadow-slate-950/50 transition hover:border-rose-500/70 hover:text-rose-200"
                    title={`ページ${page.pageNumber}を除外`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {availablePages.length === 0 && (
              <div className="flex h-36 min-w-[16rem] items-center justify-center rounded-2xl border border-slate-700/60 bg-slate-900/60 px-4 text-xs text-slate-400">
                すべてのページが除外されています
              </div>
            )}
          </div>
          {excludedPages.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
              <span className="text-slate-400">除外したページ:</span>
              {excludedPages.map((page) => (
                <button
                  key={`excluded-${page.pageNumber}`}
                  type="button"
                  onClick={() => handleRestorePage(page.pageNumber)}
                  className="rounded-full border border-slate-600/60 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-500/60 hover:text-emerald-200"
                >
                  ページ {page.pageNumber} を戻す
                </button>
              ))}
            </div>
          )}
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

type PracticeModeProps = {
  pdfData: Uint8Array;
  title: string;
  filename: string;
  onExit: () => void;
};

function PracticeMode({ pdfData, title, filename, onExit }: PracticeModeProps) {
  const [pages, setPages] = useState<PracticePage[]>([]);
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
    setLoadingPages(true);
    setRenderError("");
    const loadingTask = getDocument({ data: pdfData });

    (async () => {
      try {
        const doc = await loadingTask.promise;
        const rendered: PracticePage[] = [];

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
          setRenderError("楽譜の読み込みに失敗しました");
          setPages([]);
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
    });
    return `https://www.youtube.com/embed/${selectedVideo.videoId}?${params.toString()}`;
  }, [selectedVideo]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
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

      <div className="flex flex-1 flex-col gap-6 p-6">
        <section className="flex flex-1 flex-col gap-4 rounded-3xl border border-slate-800/70 bg-slate-900/40 p-5 shadow-2xl shadow-black/40">
          <form className="flex flex-wrap items-center gap-3" onSubmit={handleSearchSubmit}>
            <div className="flex min-w-[16rem] flex-1 items-center gap-2 rounded-2xl border border-slate-700/60 bg-slate-950/70 px-4 py-2">
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
              <div className="aspect-video w-full overflow-hidden rounded-2xl border border-slate-700/60 bg-black">
                <iframe
                  key={selectedVideo.videoId}
                  src={videoSrc}
                  title={selectedVideo.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full"
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
                  className="w-20 rounded-lg border border-slate-700/60 bg-slate-950 px-2 py-1 text-right text-sm text-slate-100 focus:border-emerald-500/60 focus:outline-none"
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
              <div className="flex h-full items-center gap-6 px-6">
                {pages.map((page) => (
                  <img
                    key={`practice-${page.pageNumber}`}
                    src={page.dataUrl}
                    alt={`楽譜 ${page.pageNumber}`}
                    className="h-full max-h-full w-auto flex-shrink-0 rounded-xl border border-slate-700/60 bg-slate-900/80 object-contain"
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

export default App;
