import { Navigate, useLocation } from "react-router-dom";
import { useAdminAuth } from "./AdminAuth";

export default function AdminGuard({ children }) {
  const auth = useAdminAuth();
  const location = useLocation();
  if (auth.loading) return <main className="page-state">Checking access...</main>;
  if (!auth.configured || !auth.session || !auth.isAdmin) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}
