import { type ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import TrimEditor from "./TrimEditor";
import PracticePage from "./PracticePage";
import { PracticeProvider } from "./practiceContext";
import "./i18n";

function App(): ReactElement {
  return (
    <PracticeProvider>
      <BrowserRouter>
        <Routes>
          {/* English routes */}
          <Route path="/" element={<TrimEditor />} />
          <Route path="/practice" element={<PracticePage />} />
          
          {/* Japanese routes */}
          <Route path="/ja" element={<TrimEditor />} />
          <Route path="/ja/practice" element={<PracticePage />} />
        </Routes>
      </BrowserRouter>
    </PracticeProvider>
  );
}

export default App;
