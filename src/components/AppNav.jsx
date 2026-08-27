import { Activity, CircleHelp, Inbox, LayoutDashboard, LogOut, MessageSquareText, Settings, Users, UserCog } from "lucide-react";
import { NavLink } from "react-router-dom";
import BrandBar from "./BrandBar";
import { useFirm } from "./Firm";
import { useSession } from "./Session";

const links = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/sequences", label: "Sequences", icon: MessageSquareText },
  { to: "/leads", label: "Leads", icon: Inbox },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/contacts", label: "Contacts", icon: Users },
  { to: "/operators", label: "Access", icon: UserCog },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/help", label: "Help", icon: CircleHelp },
];

export default function AppNav() {
  const session = useSession();
  const firm = useFirm();
  return (
    <>
      <BrandBar />
      <div className="app-nav">
        <nav aria-label="Sections">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}><Icon size={15} /> {label}</NavLink>
          ))}
        </nav>
        <div className="app-user">
          {firm?.firms?.length > 0 && (
            <label className="firm-switch">
              <span>Firm</span>
              <select
                value={firm.current?.id ?? ""}
                onChange={(event) => firm.switchFirm(event.target.value)}
                aria-label="Switch firm"
              >
                {firm.firms.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
          )}
          <span>{session.user?.displayName || session.user?.email || "Signed in"}</span>
          <button type="button" onClick={session.signOut} title="Sign out"><LogOut size={16} /></button>
        </div>
      </div>
    </>
  );
}
