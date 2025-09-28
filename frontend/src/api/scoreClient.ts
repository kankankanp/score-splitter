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

export type UploadScoreParams = {
  title: string;
  file: File;
};

export type UploadScoreResponse = {
  message: string;
  scoreId: string;
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
      pdf_file: pdfFile, // protobufのsnake_caseフィールド名を使用
    }),
  });

  if (!response.ok) {
    let details = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json();
      if (
        typeof errorBody?.message === "string" &&
        errorBody.message.length > 0
      ) {
        details = errorBody.message;
      }
    } catch (error) {
      if (error instanceof Error) {
        details = `${details}: ${error.message}`;
      }
    }
    throw new Error(`スコアのアップロードに失敗しました: ${details}`);
  }

  const data = (await response.json()) as {
    message?: string;
    scoreId?: string;
  };
  return {
    message: data.message ?? "",
    scoreId: data.scoreId ?? "",
  };
}
