const CONNECT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "Connect-Protocol-Version": "1",
} as const;

function sanitizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function resolveBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (raw && raw.trim().length > 0) {
    return sanitizeBaseUrl(raw.trim());
  }
  // Return empty string in dev environment to use proxy
  return "";
}

const baseUrl = resolveBaseUrl();
const UPLOAD_ENDPOINT = `${baseUrl}/score.ScoreService/UploadScore`;
const TRIM_ENDPOINT = `${baseUrl}/score.ScoreService/TrimScore`;

// Output debug information to console
console.log("API Configuration:", {
  baseUrl,
  UPLOAD_ENDPOINT,
  TRIM_ENDPOINT,
  env: import.meta.env.MODE,
  isDev: import.meta.env.DEV,
  isProd: import.meta.env.PROD,
  viteApiBaseUrl: import.meta.env.VITE_API_BASE_URL,
  usingProxy: baseUrl === "",
});

export type UploadScoreParams = {
  title: string;
  file: File;
};

export type UploadScoreResponse = {
  message: string;
  scoreId: string;
};

export type CropArea = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type PageTrimSetting = {
  pageNumber: number;
  areas: CropArea[];
};

export type TrimScoreParams = {
  title: string;
  pdfBytes: Uint8Array;
  areas: CropArea[];
  password?: string;
  includePages?: number[];
  pageSettings?: PageTrimSetting[];
  orientation?: "portrait" | "landscape";
  onProgress?: (progress: TrimScoreProgress) => void;
  language?: string;
};

export type TrimScoreProgress = {
  stage: string;
  progress: number;
  message: string;
};

export type TrimScoreResponse = {
  message: string;
  filename: string;
  pdfData: Uint8Array;
};

async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
  if (buffer.byteLength === 0) {
    return "";
  }
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer]);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        const base64 = result.split(",")[1] || "";
        resolve(base64);
      } else {
        reject(new Error("Failed to convert ArrayBuffer to base64"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function uint8ArrayToBase64(bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) {
    return "";
  }
  return arrayBufferToBase64((bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function uploadScore({
  title,
  file,
}: UploadScoreParams): Promise<UploadScoreResponse> {
  const pdfBuffer = await file.arrayBuffer();
  const pdfFile = await arrayBufferToBase64(pdfBuffer);

  const payload = {
    title,
    pdfFile,
  };

  const response = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: CONNECT_HEADERS,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: unknown = {};
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text) as unknown;
    } catch (error) {
      console.error("Upload response parse error", error, text);
    }
  }

  if (!response.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message ||
      (data as { message?: string })?.message;
    throw new Error(
      message ? `Upload failed: ${message}` : `Upload failed (HTTP ${response.status})`,
    );
  }

  const body = data as {
    message?: string;
    scoreId?: string;
  };
  return {
    message: body.message || "Upload completed",
    scoreId: body.scoreId || "",
  };
}

export async function trimScore({
  title,
  pdfBytes,
  areas,
  password,
  includePages,
  pageSettings,
  orientation = "portrait",
  onProgress,
  language = "en",
}: TrimScoreParams): Promise<TrimScoreResponse> {
  if (areas.length === 0 && (!pageSettings || pageSettings.length === 0)) {
    throw new Error("Please specify trimming areas");
  }

  // Use streaming API if progress callback is provided
  if (onProgress) {
    return trimScoreWithProgress({
      title,
      pdfBytes,
      areas,
      password,
      includePages,
      pageSettings,
      orientation,
      onProgress,
      language,
    });
  }

  // Use legacy API (no progress)
  const payload: {
    title: string;
    pdfFile: string;
    areas: CropAreaPayload[];
    password?: string;
    includePages?: number[];
    pageSettings?: PageTrimSettingPayload[];
    orientation?: string;
  } = {
    title,
    pdfFile: await uint8ArrayToBase64(pdfBytes),
    areas: areas.map((area) => ({
      top: area.top,
      left: area.left,
      width: area.width,
      height: area.height,
    })),
  };

  if (password && password.trim().length > 0) {
    payload.password = password.trim();
  }

  if (includePages && includePages.length > 0) {
    payload.includePages = includePages;
  }

  if (pageSettings && pageSettings.length > 0) {
    payload.pageSettings = pageSettings.map((setting) => ({
      pageNumber: setting.pageNumber,
      areas: setting.areas.map((area) => ({
        top: area.top,
        left: area.left,
        width: area.width,
        height: area.height,
      })),
    }));
  }

  if (payload.pdfFile.length === 0) {
    console.error("PDF base64 is empty", {
      title,
      pdfBytesLength: pdfBytes.length,
      areasCount: areas.length,
    });
    throw new Error("Could not read PDF content");
  }

  if (import.meta.env.DEV) {
    console.log("trimScore payload", {
      pdfBytesLength: pdfBytes.length,
      base64Length: payload.pdfFile.length,
      areas: payload.areas.length,
      passwordIncluded: Boolean(payload.password),
      includePages: payload.includePages?.length ?? 0,
      pageSettings: payload.pageSettings?.length ?? 0,
    });
    console.log("trimScore request body sample", JSON.stringify(payload).slice(0, 200));
  }

  if (import.meta.env.DEV) {
    console.debug("trimScore request", {
      base64Length: payload.pdfFile.length,
      areas: payload.areas.length,
      includePages: payload.includePages?.length ?? 0,
      pageSettings: payload.pageSettings?.length ?? 0,
    });
  }

  const response = await fetch(TRIM_ENDPOINT, {
    method: "POST",
    headers: {
      ...CONNECT_HEADERS,
      "X-Language": language,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: unknown = {};
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text) as unknown;
    } catch (error) {
      console.error("Trim response parse error", error, text);
    }
  }

  if (!response.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message ||
      (data as { message?: string })?.message;
    throw new Error(
      message ? `Trimming failed: ${message}` : `Trimming failed (HTTP ${response.status})`,
    );
  }

  const body = data as {
    message?: string;
    filename?: string;
    trimmedPdf?: string;
    trimmed_pdf?: string;
  };
  const base64 = body.trimmedPdf || body.trimmed_pdf;
  if (typeof base64 !== "string" || base64.length === 0) {
    console.error("Base64 data not found:", {
      body,
      trimmedPdf: body.trimmedPdf,
      trimmed_pdf: body.trimmed_pdf,
    });
    throw new Error("Could not retrieve generated PDF");
  }

  console.log("Converting Base64 data:", {
    base64Length: base64.length,
    base64Sample: base64.substring(0, 100),
  });

  const pdfData = base64ToUint8Array(base64);
  console.log("PDF data conversion completed:", {
    pdfDataLength: pdfData.length,
    pdfDataType: typeof pdfData,
  });

  return {
    message: body.message || "Trimming completed",
    filename: body.filename || "trimmed-score.pdf",
    pdfData,
  };
}

// Use streaming API to execute trimming with progress
async function trimScoreWithProgress({
  title,
  pdfBytes,
  areas,
  password,
  includePages,
  pageSettings,
  orientation = "portrait",
  onProgress,
  language = "en",
}: TrimScoreParams): Promise<TrimScoreResponse> {
  // Simulate progress status
  const updateProgress = (stage: string, progress: number, message: string) => {
    onProgress?.({ stage, progress, message });
  };

  // 段階1: 初期化
  updateProgress("parsing", 10, "Validating PDF file...");
  await new Promise(resolve => setTimeout(resolve, 300));

  // 段階2: 準備
  updateProgress("parsing", 25, "Processing trimming areas...");
  await new Promise(resolve => setTimeout(resolve, 200));

  // Stage 3: Start processing
  updateProgress("processing", 40, "Processing PDF pages...");
  await new Promise(resolve => setTimeout(resolve, 300));

  // Use legacy API for actual processing
  const payload: {
    title: string;
    pdfFile: string;
    areas: CropAreaPayload[];
    orientation: string;
    password?: string;
    includePages?: number[];
    pageSettings?: PageTrimSettingPayload[];
  } = {
    title,
    pdfFile: await uint8ArrayToBase64(pdfBytes),
    areas: areas.map((area) => ({
      top: area.top,
      left: area.left,
      width: area.width,
      height: area.height,
    })),
    orientation,
  };

  if (password && password.trim().length > 0) {
    payload.password = password.trim();
  }

  if (includePages && includePages.length > 0) {
    payload.includePages = includePages;
  }

  if (pageSettings && pageSettings.length > 0) {
    payload.pageSettings = pageSettings.map((setting) => ({
      pageNumber: setting.pageNumber,
      areas: setting.areas.map((area) => ({
        top: area.top,
        left: area.left,
        width: area.width,
        height: area.height,
      })),
    }));
  }

  if (payload.pdfFile.length === 0) {
    console.error("PDF base64 is empty", {
      title,
      pdfBytesLength: pdfBytes.length,
      areasCount: areas.length,
    });
    throw new Error("Could not read PDF content");
  }

  // Stage 4: Server processing
  updateProgress("processing", 60, "Server is processing PDF...");

  const endpoint = `${baseUrl}/score.ScoreService/TrimScore`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "X-Language": language,
    },
    body: JSON.stringify(payload),
  });

  // Stage 5: Generating
  updateProgress("generating", 85, "Generating PDF...");
  await new Promise(resolve => setTimeout(resolve, 200));

  if (!response.ok) {
    const errorText = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(errorText);
    } catch {
      data = { message: errorText };
    }
    const message =
      (data as { error?: { message?: string } })?.error?.message ||
      (data as { message?: string })?.message;
    throw new Error(
      message ? `Trimming failed: ${message}` : `Trimming failed (HTTP ${response.status})`,
    );
  }

  const data = await response.json();
  const body = data as {
    message?: string;
    filename?: string;
    trimmedPdf?: string;
    trimmed_pdf?: string;
  };
  
  const base64 = body.trimmedPdf || body.trimmed_pdf;
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error("Failed to retrieve PDF data");
  }

  // Stage 6: Complete
  if (orientation === "landscape") {
    updateProgress("generating", 95, "Converting to slide format...");
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  updateProgress("complete", 100, "Generated trimmed PDF");

  const pdfData = base64ToUint8Array(base64);

  return {
    message: body.message || "Trimming completed",
    filename: body.filename || "trimmed-score.pdf",
    pdfData,
  };
}

type CropAreaPayload = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type PageTrimSettingPayload = {
  pageNumber: number;
  areas: CropAreaPayload[];
};