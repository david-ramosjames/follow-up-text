import { Activity, LogOut, MessageSquareText, ShieldOff, Users } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAdminAuth } from "./AdminAuth";

const links = [
  { to: "/", label: "Sequences", icon: MessageSquareText, end: true },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/contacts", label: "Contacts", icon: Users },
  { to: "/operators", label: "Operators", icon: ShieldOff },
];

export default function AppNav() {
  const auth = useAdminAuth();
  return (
    <div className="app-nav">
      <nav aria-label="Sections">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}><Icon size={15} /> {label}</NavLink>
        ))}
      </nav>
      <div className="app-user">
        <span>{auth.user?.email}</span>
        <button type="button" onClick={auth.signOut} title="Sign out"><LogOut size={16} /></button>
      </div>
    </div>
  );
}
