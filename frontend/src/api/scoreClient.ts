const DEFAULT_BASE_URL = 'http://localhost:8085';

const baseUrl = (() => {
  const raw = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_BASE_URL;
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
})();

const UPLOAD_ENDPOINT = `${baseUrl}/score.ScoreService/UploadScore`;

export type UploadScoreParams = {
  title: string;
  file: File;
};

export type UploadScoreResponse = {
  message: string;
  scoreId: string;
};

const CONNECT_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Connect-Protocol-Version': '1',
} as const;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function uploadScore({ title, file }: UploadScoreParams): Promise<UploadScoreResponse> {
  const pdfBuffer = await file.arrayBuffer();
  const pdfFile = arrayBufferToBase64(pdfBuffer);

  const response = await fetch(UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: CONNECT_HEADERS,
    body: JSON.stringify({
      title,
      pdfFile,
    }),
  });

  if (!response.ok) {
    let details = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json();
      if (typeof errorBody?.message === 'string' && errorBody.message.length > 0) {
        details = errorBody.message;
      }
    } catch (error) {
      if (error instanceof Error) {
        details = `${details}: ${error.message}`;
      }
    }
    throw new Error(`スコアのアップロードに失敗しました: ${details}`);
  }

  const data = (await response.json()) as { message?: string; scoreId?: string };
  return {
    message: data.message ?? '',
    scoreId: data.scoreId ?? '',
  };
}
