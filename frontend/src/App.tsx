import { useState, type ChangeEvent, type FormEvent } from "react";
import { uploadScore } from "./api/scoreClient";

type UploadState = "idle" | "running";

function App() {
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [uploadState, setUploadState] = useState<UploadState>("idle");

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] ?? null;
    setFile(selectedFile);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage("");
    setStatusMessage("");

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setErrorMessage("タイトルを入力してください");
      return;
    }
    if (!file) {
      setErrorMessage("PDFファイルを選択してください");
      return;
    }

    setUploadState("running");
    try {
      const result = await uploadScore({ title: trimmedTitle, file });
      const baseMessage = result.message || "アップロードが完了しました";
      const scoreInfo = result.scoreId ? ` (ID: ${result.scoreId})` : "";
      setStatusMessage(`${baseMessage}${scoreInfo}`);
      setErrorMessage("");
      setTitle("");
      setFile(null);
      event.currentTarget.reset();
    } catch (error) {
      const fallback = "アップロード中にエラーが発生しました";
      setStatusMessage("");
      console.error("Upload failed:", error); // デバッグ用

      if (error instanceof TypeError && error.message.includes("fetch")) {
        setErrorMessage(
          "サーバーに接続できませんでした。バックエンドが起動中か通信環境をご確認ください。"
        );
      } else if (error instanceof Error) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(`${fallback}: ${String(error)}`);
      }
    } finally {
      setUploadState("idle");
    }
  };

  return (
    <main className="w-full max-w-xl space-y-6 px-6 py-10">
      <div className="space-y-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-100">
          スコアアップロード
        </h1>
        <p className="text-sm text-slate-400">
          楽譜PDFとタイトルをアップロードして、簡単に共有できます。
        </p>
      </div>
      <form
        className="rounded-3xl bg-slate-900/50 p-6 shadow-2xl shadow-slate-950/40 backdrop-blur"
        onSubmit={handleSubmit}
      >
        <fieldset
          className="flex flex-col gap-5"
          disabled={uploadState === "running"}
        >
          <label className="flex flex-col gap-2 text-sm text-slate-200">
            <span className="font-semibold text-slate-100">タイトル</span>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例: モルダウ"
              className="w-full rounded-xl border border-slate-700/50 bg-slate-900/60 px-4 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
              required
            />
          </label>
          <label className="flex flex-col gap-2 text-sm text-slate-200">
            <span className="font-semibold text-slate-100">PDFファイル</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              className="w-full cursor-pointer rounded-xl border border-dashed border-slate-600/60 bg-slate-900/60 px-4 py-3 text-base text-slate-100 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-500 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:border-indigo-500/60"
              required
            />
          </label>
          <button
            type="submit"
            className="ml-auto inline-flex items-center justify-center rounded-full bg-gradient-to-r from-indigo-500 via-indigo-400 to-violet-500 px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition-transform duration-150 hover:scale-105 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
          >
            {uploadState === "running" ? "アップロード中…" : "アップロード"}
          </button>
        </fieldset>
      </form>
      <div className="space-y-3 text-sm">
        {statusMessage && (
          <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 font-medium text-emerald-300">
            {statusMessage}
          </p>
        )}
        {errorMessage && (
          <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-medium text-rose-300">
            {errorMessage}
          </p>
        )}
      </div>
    </main>
  );
}

export default App;
