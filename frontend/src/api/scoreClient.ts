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
  // 開発環境では空文字列を返してプロキシを使用
  return "";
}

const baseUrl = resolveBaseUrl();
const UPLOAD_ENDPOINT = `${baseUrl}/score.ScoreService/UploadScore`;
const TRIM_ENDPOINT = `${baseUrl}/score.ScoreService/TrimScore`;

export type UploadScoreParams = {
  title: string;
  file: File;
};

export type UploadScoreResponse = {
  message: string;
  scoreId: string;
};

export type CropAreaPayload = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type TrimScoreParams = {
  title: string;
  pdfBytes: Uint8Array;
  areas: CropAreaPayload[];
};

export type TrimScoreResponse = {
  message: string;
  filename: string;
  pdfData: Uint8Array;
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    return "";
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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
  const pdfFile = arrayBufferToBase64(pdfBuffer);

  const response = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: CONNECT_HEADERS,
    body: JSON.stringify({
      title,
      pdfFile,
    }),
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
      message ? `アップロードに失敗しました: ${message}` : `アップロードに失敗しました (HTTP ${response.status})`,
    );
  }

  const body = data as { message?: string; scoreId?: string };
  return {
    message: body.message || "アップロードが完了しました",
    scoreId: body.scoreId || "",
  };
}

export async function trimScore({
  title,
  pdfBytes,
  areas,
}: TrimScoreParams): Promise<TrimScoreResponse> {
  if (areas.length === 0) {
    throw new Error("トリミングエリアを指定してください");
  }

  const payload = {
    title,
    pdfFile: uint8ArrayToBase64(pdfBytes),
    areas: areas.map((area) => ({
      top: area.top,
      left: area.left,
      width: area.width,
      height: area.height,
    })),
  };

  const response = await fetch(TRIM_ENDPOINT, {
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
      console.error("Trim response parse error", error, text);
    }
  }

  if (!response.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message ||
      (data as { message?: string })?.message;
    throw new Error(
      message ? `トリミングに失敗しました: ${message}` : `トリミングに失敗しました (HTTP ${response.status})`,
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
    throw new Error("生成されたPDFを取得できませんでした");
  }

  return {
    message: body.message || "トリミングが完了しました",
    filename: body.filename || "trimmed-score.pdf",
    pdfData: base64ToUint8Array(base64),
  };
}
