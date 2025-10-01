import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

export type PracticeData = {
  pdfData: Uint8Array;
  title: string;
  filename: string;
};

export type PracticeContextValue = {
  practiceData: PracticeData | null;
  setPracticeData: (data: PracticeData | null) => void;
};

const PracticeContext = createContext<PracticeContextValue | undefined>(undefined);

export function PracticeProvider({ children }: { children: ReactNode }): ReactElement {
  const [practiceData, setPracticeData] = useState<PracticeData | null>(null);

  const value = useMemo<PracticeContextValue>(
    () => ({ practiceData, setPracticeData }),
    [practiceData],
  );

  return <PracticeContext.Provider value={value}>{children}</PracticeContext.Provider>;
}

export function usePractice(): PracticeContextValue {
  const context = useContext(PracticeContext);
  if (!context) {
    throw new Error("usePractice must be used within a PracticeProvider");
  }
  return context;
}
