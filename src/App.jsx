import { Navigate, Route, Routes } from "react-router-dom";
import AdminGuard from "./components/AdminGuard";
import ActivityPage from "./pages/ActivityPage";
import ContactsPage from "./pages/ContactsPage";
import LoginPage from "./pages/LoginPage";
import OperatorsPage from "./pages/OperatorsPage";
import SequenceEditorPage from "./pages/SequenceEditorPage";
import SequencesPage from "./pages/SequencesPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<AdminGuard><SequencesPage /></AdminGuard>} />
      <Route path="/sequences/:slug" element={<AdminGuard><SequenceEditorPage /></AdminGuard>} />
      <Route path="/activity" element={<AdminGuard><ActivityPage /></AdminGuard>} />
      <Route path="/contacts" element={<AdminGuard><ContactsPage /></AdminGuard>} />
      <Route path="/operators" element={<AdminGuard><OperatorsPage /></AdminGuard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
