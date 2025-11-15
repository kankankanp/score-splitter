import {
  GlobalWorkerOptions,
  PasswordResponses,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker?url";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { trimScore } from "./api/scoreClient";
import { usePractice } from "./practiceContext";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { useLanguage } from "./hooks/useLanguage";

GlobalWorkerOptions.workerSrc = workerSrc;

const MIN_AREA_SIZE = 0.01;

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

function TrimEditor(): ReactElement {
  const { t } = useTranslation();
  const { navigateWithLanguage, currentLanguage } = useLanguage();
  const { practiceData, setPracticeData } = usePractice();

  const [pdfName, setPdfName] = useState<string>("");
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfPages, setPdfPages] = useState<PdfPagePreview[]>([]);
  const [excludedPageNumbers, setExcludedPageNumbers] = useState<number[]>([]);
  const [selectedPageNumber, setSelectedPageNumber] = useState<number | null>(
    null
  );
  const [selectedPageImage, setSelectedPageImage] =
    useState<SelectedPageImage | null>(null);
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
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [trimProgress, setTrimProgress] = useState<{
    stage: string;
    progress: number;
    message: string;
  } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    progress: number;
    message: string;
  } | null>(null);

  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const pageContainerRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<InteractionState | null>(null);
  const passwordResolverRef = useRef<((value: string | null) => void) | null>(
    null
  );
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
    setOrientation("portrait");
    setTrimProgress(null);
    setUploadProgress(null);
  }, [setPracticeData]);

  // Clear practiceData when TrimEditor page loads
  useEffect(() => {
    if (practiceData) {
      setPracticeData(null);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      setLoadingMessage(t('password.waiting'));
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
    setLoadingMessage(t('progress.loadingPdf'));
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
    []
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
    [handlePasswordCancel, handlePasswordSubmit]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      resetState();
      setPdfName(file.name);
      setLoadingMessage(t('progress.loadingPdf'));
      
      // Simulate upload progress
      setUploadProgress({ progress: 10, message: t('progress.loadingFile') });
      await new Promise(resolve => setTimeout(resolve, 100));

      passwordCancelledRef.current = false;

      try {
        setUploadProgress({ progress: 30, message: t('progress.parsingPdf') });
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const storedBytes = new Uint8Array(bytes);
        setPdfBytes(storedBytes);
        setExcludedPageNumbers([]);

        setUploadProgress({ progress: 50, message: t('progress.loadingPdf') });
        const loadingTask = getDocument({ data: bytes });
        loadingTask.onPassword = (
          updatePassword: (arg0: string) => void,
          reason: number
        ) => {
          const message =
            reason === PasswordResponses.NEED_PASSWORD
              ? t('password.protected')
              : t('password.incorrect');

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
            setErrorMessage(t('password.cancelled'));
          });
        };
        setUploadProgress({ progress: 70, message: t('progress.generatingPreviews') });
        const doc = await loadingTask.promise;
        pdfDocumentRef.current = doc;

        const previews: PdfPagePreview[] = [];

        for (let index = 1; index <= doc.numPages; index += 1) {
          // Update preview generation progress
          const previewProgress = 70 + Math.floor((index / doc.numPages) * 25);
          setUploadProgress({ 
            progress: previewProgress, 
            message: t('progress.pageProgress', { current: index, total: doc.numPages }) 
          });
          
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
            await page.render({
              canvasContext: context,
              viewport: renderViewport,
              canvas,
            }).promise;
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
        
        setUploadProgress({ progress: 100, message: t('progress.loadComplete') });
        
        // Auto-clear success message after 2 seconds
        setTimeout(() => {
          setUploadProgress(null);
        }, 2000);
      } catch (error) {
        const isPasswordError =
          passwordCancelledRef.current ||
          (error instanceof Error && error.name === "PasswordException");

        if (!isPasswordError) {
          console.error(error);
          setErrorMessage(t('errors.pdfLoadFailed'));
          resetState();
        }
        passwordCancelledRef.current = false;
      } finally {
        setLoadingMessage("");
        setUploadProgress(null);
        event.target.value = "";
      }
    },
    [requestPassword, resetState]
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
          await page.render({
            canvasContext: context,
            viewport: renderViewport,
            canvas,
          }).promise;
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
          setErrorMessage(t('errors.pageRenderFailed'));
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
    const areas = pageSpecificAreas[selectedPageNumber];
    return Array.isArray(areas) && areas.length > 0;
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

  const sortedAreas = useMemo(
    () => sortAreasByTop(currentAreas),
    [currentAreas]
  );

  const mutateCurrentAreas = useCallback(
    (updater: (areas: CropArea[]) => CropArea[]) => {
      if (selectedPageHasSpecific && selectedPageNumber !== null) {
        setPageSpecificAreas((current) => {
          const existing = current[selectedPageNumber] ?? [];
          const nextAreas = updater(existing);
          if (nextAreas.length === 0) {
            const { ...rest } = current;
            return rest;
          }
          return {
            ...current,
            [selectedPageNumber]: nextAreas,
          };
        });
        return;
      }
      setGlobalAreas((current) => updater(current));
    },
    [selectedPageHasSpecific, selectedPageNumber]
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
      (page) => page.pageNumber === selectedPageNumber
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
          area.id === areaId ? clampArea(updater(area)) : area
        )
      );
    },
    [mutateCurrentAreas]
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
    [getRelativePosition, mutateCurrentAreas, selectedPageImage]
  );

  const handleAreaPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, area: CropArea) => {
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
    },
    [getRelativePosition]
  );

  const handleHandlePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLButtonElement>,
      area: CropArea,
      handle: CornerHandle
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
    []
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
    [getRelativePosition, updateArea]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const interaction = interactionRef.current;
      if (interaction) {
        if (interaction.type === "creating") {
          const createdArea = currentAreas.find(
            (area) => area.id === interaction.areaId
          );
          if (
            createdArea &&
            (createdArea.width <= MIN_AREA_SIZE * 1.1 ||
              createdArea.height <= MIN_AREA_SIZE * 1.1)
          ) {
            mutateCurrentAreas((areas) =>
              areas.filter((area) => area.id !== interaction.areaId)
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
    [currentAreas, mutateCurrentAreas]
  );

  const handleAddArea = useCallback(() => {
    const next = createDefaultArea();
    mutateCurrentAreas((areas) => [...areas, next]);
    setActiveAreaId(next.id);
  }, [mutateCurrentAreas]);

  const handleRemoveArea = useCallback(
    (areaId: string) => {
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
    },
    [activeAreaId, currentAreas, mutateCurrentAreas]
  );

  const handleEnablePageSpecific = useCallback(() => {
    if (selectedPageNumber === null) {
      return;
    }
    let createdAreas: CropArea[] | undefined;
    setPageSpecificAreas((current: Record<number, CropArea[]>) => {
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
    setPageSpecificAreas((current: { [x: string]: any; }) => {
      if (!current[selectedPageNumber]) {
        return current;
      }
      const { ...rest } = current;
      return rest;
    });
    interactionRef.current = null;
    if (globalAreas.length > 0) {
      setActiveAreaId(globalAreas[0].id);
    } else {
      setActiveAreaId(null);
    }
  }, [globalAreas, selectedPageNumber]);

  const handleExcludePage = useCallback(
    (pageNumber: number) => {
      if (availablePageCount <= 1) {
        setErrorMessage(t('errors.needAtLeastOnePage'));
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
    },
    [availablePageCount]
  );

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
      (areas) => areas.length > 0
    );
    if (!pdfBytes || (!hasDefaultAreas && !hasPageOverrides)) {
      setErrorMessage(t('errors.setTrimArea'));
      return;
    }

    const includePageNumbers = availablePages.map((page) => page.pageNumber);
    if (includePageNumbers.length === 0) {
      setErrorMessage(t('errors.selectPageToTrim'));
      return;
    }

    const includePageSet = new Set(includePageNumbers);
    const defaultAreasForPayload = sortAreasByTop(globalAreas);

    const pagesRequiringDefault = includePageNumbers.filter(
      (pageNumber) => !pageSpecificAreas[pageNumber]
    );
    if (
      pagesRequiringDefault.length > 0 &&
      defaultAreasForPayload.length === 0
    ) {
      setErrorMessage(t('errors.setCommonTrimArea'));
      return;
    }

    for (const [pageKey, areas] of Object.entries(pageSpecificAreas)) {
      const pageNumber = Number(pageKey);
      if (includePageSet.has(pageNumber) && areas.length === 0) {
        setErrorMessage(
          t('errors.setPageTrimArea', { pageNumber })
        );
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
        orientation,
        language: currentLanguage,
        onProgress: (progress) => {
          setTrimProgress(progress);
        },
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
              response.pdfData.byteOffset + response.pdfData.byteLength
            ) as ArrayBuffer);

      const blob = new Blob([arrayBuffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.filename || `${baseTitle}-trimmed.pdf`;
      link.click();
      setStatusMessage(
        response.message || t('progress.downloadComplete')
      );
      setErrorMessage("");
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1500);
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        setErrorMessage(error.message || t('errors.pdfGenerationFailed'));
      } else {
        setErrorMessage(t('errors.pdfGenerationFailed'));
      }
    } finally {
      setGenerating(false);
      setTrimProgress(null);
    }
  }, [
    availablePages,
    globalAreas,
    pageSpecificAreas,
    pdfBytes,
    pdfName,
    pdfPassword,
    setPracticeData,
  ]);

  const canExport =
    pdfBytes !== null &&
    availablePages.length > 0 &&
    !generating &&
    (globalAreas.length > 0 ||
      Object.values(pageSpecificAreas).some((areas) => areas.length > 0));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
            {t('title')}
          </h1>
          <LanguageSwitcher />
        </div>
        <p className="text-sm text-slate-600">
          {t('description')}
        </p>
      </header>

      <section className="rounded-3xl bg-white/80 p-6 shadow-2xl shadow-slate-950/10">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm text-slate-800">
            <span className="font-semibold text-slate-900">
              {t('fileUpload.title')}
            </span>
            <div className="relative">
              <input
                type="file"
                accept="application/pdf"
                onChange={handleFileChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              />
              <div className={`w-full rounded-xl border border-dashed px-4 py-3 text-base transition-colors ${
                pdfName 
                  ? "border-emerald-400 bg-emerald-50" 
                  : "border-slate-400 bg-slate-50 hover:border-indigo-500"
              }`}>
                <div className="flex items-center gap-4">
                  <span className={`inline-flex rounded-lg px-4 py-2 text-sm font-medium ${
                    pdfName 
                      ? "bg-emerald-500 text-white" 
                      : "bg-indigo-500 text-white"
                  }`}>
                    {pdfName ? t('fileUpload.fileSelected') : t('fileUpload.selectFile')}
                  </span>
                  <span className={`${
                    pdfName 
                      ? "text-emerald-800 font-medium" 
                      : "text-slate-600"
                  }`}>
                    {pdfName 
                      ? t('fileUpload.selectedFile', { filename: pdfName })
                      : t('fileUpload.placeholder')}
                  </span>
                </div>
              </div>
            </div>
          </label>
          {loadingMessage && (
            <p className="text-sm text-indigo-600">{loadingMessage}</p>
          )}
          
          {uploadProgress && (
            <div className="rounded-2xl border border-indigo-400 bg-indigo-50 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-indigo-900">
                  {t('fileUpload.uploading')}
                </h3>
                <span className="text-sm font-medium text-indigo-800">
                  {uploadProgress.progress}%
                </span>
              </div>
              <div className="w-full bg-indigo-200 rounded-full h-2 mb-2">
                <div 
                  className="bg-indigo-500 h-2 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${uploadProgress.progress}%` }}
                />
              </div>
              <p className="text-sm text-indigo-800">{uploadProgress.message}</p>
            </div>
          )}
          
          {practiceData && (
            <button
              type="button"
              onClick={() => {
                navigateWithLanguage('/practice');
              }}
              className="self-start rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-white shadow shadow-emerald-900/40 transition hover:bg-emerald-400"
            >
              {t('buttons.openPracticeMode')}
            </button>
          )}
        </div>
      </section>

      {errorMessage && (
        <div className="rounded-2xl border border-rose-400 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
          {errorMessage}
        </div>
      )}
      {statusMessage && (
        <div className="rounded-2xl border border-emerald-400 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {statusMessage}
        </div>
      )}
      
      {trimProgress && (
        <div className="rounded-2xl border border-blue-400 bg-blue-50 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-blue-900">
              {trimProgress.stage === "parsing" && t('progress.parsing')}
              {trimProgress.stage === "processing" && t('progress.processing')}
              {trimProgress.stage === "generating" && t('progress.generating')}
              {trimProgress.stage === "complete" && t('progress.complete')}
            </h3>
            <span className="text-sm font-medium text-blue-800">
              {trimProgress.progress}%
            </span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2 mb-2">
            <div 
              className="bg-blue-500 h-2 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${trimProgress.progress}%` }}
            />
          </div>
          <p className="text-sm text-blue-800">{trimProgress.message}</p>
        </div>
      )}

      {pdfPages.length > 0 && (
        <section className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {t('trimming.previewTitle')}
              </h2>
              <button
                type="button"
                onClick={handleAddArea}
                className="rounded-full bg-slate-200 px-4 py-2 text-sm font-medium text-slate-900 shadow shadow-slate-300 transition hover:bg-slate-300"
              >
                {t('buttons.addArea')}
              </button>
            </div>
            <p className="text-xs text-slate-600">
              {t('trimming.instructions')}
            </p>
            {selectedPageNumber !== null && (
              <div className="flex items-center justify-between rounded-2xl border border-slate-300 bg-white/80 px-4 py-2 text-xs text-slate-700">
                <span>
                  {selectedPageHasSpecific
                    ? t('trimming.pageSpecificEditing', { pageNumber: selectedPageNumber })
                    : t('trimming.commonEditing')}
                </span>
                <div className="flex gap-2">
                  {selectedPageHasSpecific ? (
                    <button
                      type="button"
                      onClick={handleDisablePageSpecific}
                      className="rounded-full border border-slate-400 px-3 py-1 text-xs font-medium text-slate-800 transition hover:border-emerald-500 hover:text-emerald-700"
                    >
                      {t('buttons.backToCommon')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleEnablePageSpecific}
                      className="rounded-full border border-indigo-400 px-3 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-50"
                    >
                      {t('buttons.makePageSpecific')}
                    </button>
                  )}
                </div>
              </div>
            )}
            <div
              ref={pageContainerRef}
              className="relative overflow-hidden rounded-3xl border border-slate-300 bg-slate-50"
              onPointerDown={handleContainerPointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            >
              {selectedPageImage ? (
                <>
                  <img
                    src={selectedPageImage.dataUrl}
                    alt={t('trimming.pageLabel', { pageNumber: selectedPageImage.pageNumber })}
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
                          <button
                            type="button"
                            aria-label={t('trimming.deleteAreaLabel')}
                            className="pointer-events-auto absolute -right-2 -top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-rose-400/60 bg-rose-500 text-xs font-semibold text-white shadow shadow-rose-950/50 transition hover:bg-rose-400"
                            onClick={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                              handleRemoveArea(area.id);
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                          >
                            ×
                          </button>
                          {(
                            [
                              "top-left",
                              "top-right",
                              "bottom-left",
                              "bottom-right",
                            ] as CornerHandle[]
                          ).map((handle) => (
                            <button
                              key={handle}
                              type="button"
                              data-handle={handle}
                              onPointerDown={(event) =>
                                handleHandlePointerDown(event, area, handle)
                              }
                              className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-emerald-600 bg-emerald-400 shadow ${
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
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="flex h-80 items-center justify-center text-sm text-slate-500">
                  {renderingPage
                    ? t('trimming.renderingPage')
                    : t('trimming.selectPage')}
                </div>
              )}
            </div>
          </div>

          <aside className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-slate-900">
              {t('trimming.areasTitle')}
            </h2>
            <ul className="space-y-3">
              {sortedAreas.map((area, index) => (
                <li
                  key={area.id}
                  className={`flex items-start justify-between rounded-2xl border px-4 py-3 text-sm ${
                    area.id === activeAreaId
                      ? "border-emerald-500 bg-emerald-50 text-emerald-900"
                      : "border-slate-300 bg-white/80 text-slate-800"
                  }`}
                >
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => setActiveAreaId(area.id)}
                  >
                    <div className="font-semibold">{t('trimming.areaLabel', { number: index + 1 })}</div>
                    <div className="text-xs opacity-80">
                      {t('trimming.areaCoordinates', {
                        top: Math.round(area.top * 100),
                        left: Math.round(area.left * 100),
                        width: Math.round(area.width * 100),
                        height: Math.round(area.height * 100)
                      })}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-slate-400 px-3 py-1 text-xs text-slate-700 transition hover:border-rose-400 hover:text-rose-700"
                    onClick={() => handleRemoveArea(area.id)}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={handleExport}
              className="rounded-full bg-emerald-500 px-5 py-3 text-sm font-semibold text-white shadow shadow-emerald-900/40 transition hover:bg-emerald-400 disabled:opacity-60"
              disabled={!canExport}
            >
              {t('buttons.trimAndDownload')}
            </button>
          </aside>
        </section>
      )}

      {pdfPages.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">
            {t('trimming.pagePreviewTitle')}
          </h2>
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
                        ? "border-indigo-400 bg-indigo-50 text-indigo-900"
                        : "border-slate-300 bg-white/80 text-slate-700 hover:border-indigo-400 hover:text-indigo-800"
                    }`}
                  >
                    <img
                      src={page.thumbnailUrl}
                      alt={t('trimming.thumbnailAlt', { pageNumber: page.pageNumber })}
                      className="h-32 w-auto select-none rounded-xl border border-slate-300 object-contain"
                      draggable={false}
                    />
                    <span>{t('trimming.pageLabel', { pageNumber: page.pageNumber })}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      handleExcludePage(page.pageNumber);
                    }}
                    className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-slate-400 bg-white/90 text-sm text-slate-700 shadow shadow-slate-300 transition hover:border-rose-500 hover:text-rose-700"
                    title={t('trimming.excludePage', { pageNumber: page.pageNumber })}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {availablePages.length === 0 && (
              <div className="flex h-36 min-w-[16rem] items-center justify-center rounded-2xl border border-slate-300 bg-white/80 px-4 text-xs text-slate-600">
                {t('trimming.allPagesExcluded')}
              </div>
            )}
          </div>
          {excludedPages.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
              <span className="text-slate-600">{t('trimming.excludedPages')}</span>
              {excludedPages.map((page) => (
                <button
                  key={`excluded-${page.pageNumber}`}
                  type="button"
                  onClick={() => handleRestorePage(page.pageNumber)}
                  className="rounded-full border border-slate-400 px-3 py-1 text-xs text-slate-800 transition hover:border-emerald-500 hover:text-emerald-700"
                >
                  {t('trimming.restorePage', { pageNumber: page.pageNumber })}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {passwordPromptOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur">
          <div className="w-full max-w-sm rounded-2xl border border-slate-300 bg-white/95 p-6 shadow-2xl shadow-black/30">
            <h3 className="text-lg font-semibold text-slate-900">
              {t('password.title')}
            </h3>
            <p className="mt-2 text-sm text-slate-700">
              {passwordPromptMessage}
            </p>
            <input
              ref={passwordInputRef}
              type="password"
              value={passwordValue}
              onChange={handlePasswordInputChange}
              onKeyDown={handlePasswordKeyDown}
              className="mt-4 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              placeholder={t('password.placeholder')}
            />
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={handlePasswordCancel}
                className="rounded-full border border-slate-400 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-600 hover:text-slate-900"
              >
                {t('buttons.cancel')}
              </button>
              <button
                type="button"
                onClick={handlePasswordSubmit}
                className="rounded-full bg-indigo-500 px-5 py-2 text-sm font-semibold text-white shadow shadow-indigo-900/50 transition hover:bg-indigo-400 disabled:opacity-60"
                disabled={passwordValue.length === 0}
              >
                {t('buttons.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default TrimEditor;
