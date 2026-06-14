import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HistoryPage } from "./pages/History";
import { ReportPage } from "./pages/Report";
import { RunProgressPage } from "./pages/RunProgress";
import { UploadPage } from "./pages/Upload";

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/runs/:runId" element={<RunProgressPage />} />
        <Route path="/runs/:runId/report" element={<ReportPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default App;
