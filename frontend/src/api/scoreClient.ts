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
  password?: string | null;
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
  return blobToBase64(new Blob([buffer]));
}

async function uint8ArrayToBase64(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0) {
    return "";
  }
  // Clone to avoid issues with detached buffers.
  const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : new Uint8Array(bytes);
  return blobToBase64(new Blob([copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)]));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        const [, base64 = ""] = result.split(",");
        resolve(base64);
      } else {
        resolve("");
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Base64変換に失敗しました"));
    };
    reader.readAsDataURL(blob);
  });
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
      message ? `アップロードに失敗しました: ${message}` : `アップロードに失敗しました (HTTP ${response.status})`,
    );
  }

  const body = data as {
    message?: string;
    scoreId?: string;
  };
  return {
    message: body.message || "アップロードが完了しました",
    scoreId: body.scoreId || "",
  };
}

export async function trimScore({
  title,
  pdfBytes,
  areas,
  password,
}: TrimScoreParams): Promise<TrimScoreResponse> {
  if (areas.length === 0) {
    throw new Error("トリミングエリアを指定してください");
  }

  const payload: {
    title: string;
    pdfFile: string;
    areas: CropAreaPayload[];
    password?: string;
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

  if (password && password.length > 0) {
    payload.password = password;
  }

  if (payload.pdfFile.length === 0) {
    console.error("PDF base64 is empty", {
      title,
      pdfBytesLength: pdfBytes.length,
      areasCount: areas.length,
    });
    throw new Error("PDFの内容を読み取れませんでした");
  }

  if (import.meta.env.DEV) {
    console.log("trimScore payload", {
      pdfBytesLength: pdfBytes.length,
      base64Length: payload.pdfFile.length,
      areas: payload.areas.length,
      passwordIncluded: Boolean(payload.password),
    });
    console.log("trimScore request body sample", JSON.stringify(payload).slice(0, 200));
  }

  if (import.meta.env.DEV) {
    console.debug("trimScore request", {
      base64Length: payload.pdfFile.length,
      areas: payload.areas.length,
    });
  }

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
