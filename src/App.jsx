import { Navigate, Route, Routes } from "react-router-dom";
import { RequireSession } from "./components/Session";
import ActivityPage from "./pages/ActivityPage";
import ContactsPage from "./pages/ContactsPage";
import DashboardPage from "./pages/DashboardPage";
import HelpPage from "./pages/HelpPage";
import LeadsPage from "./pages/LeadsPage";
import LoginPage from "./pages/LoginPage";
import OperatorsPage from "./pages/OperatorsPage";
import SequenceEditorPage from "./pages/SequenceEditorPage";
import SequencesPage from "./pages/SequencesPage";
import SettingsPage from "./pages/SettingsPage";

const guarded = (element) => <RequireSession>{element}</RequireSession>;

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={guarded(<DashboardPage />)} />
      <Route path="/sequences" element={guarded(<SequencesPage />)} />
      <Route path="/sequences/:slug" element={guarded(<SequenceEditorPage />)} />
      <Route path="/leads" element={guarded(<LeadsPage />)} />
      <Route path="/activity" element={guarded(<ActivityPage />)} />
      <Route path="/contacts" element={guarded(<ContactsPage />)} />
      <Route path="/operators" element={guarded(<OperatorsPage />)} />
      <Route path="/settings" element={guarded(<SettingsPage />)} />
      <Route path="/help" element={guarded(<HelpPage />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
