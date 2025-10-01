import { type ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import TrimEditor from "./TrimEditor";
import PracticePage from "./PracticePage";
import { PracticeProvider } from "./practiceContext";

function App(): ReactElement {
  return (
    <PracticeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<TrimEditor />} />
          <Route path="/practice" element={<PracticePage />} />
        </Routes>
      </BrowserRouter>
    </PracticeProvider>
  );
}

export default App;
