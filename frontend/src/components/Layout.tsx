import { NavLink, Outlet } from "react-router-dom";
import { Role } from "@hr/shared";
import { useAuth } from "../lib/AuthContext";
import logo from "../assets/kinbidhoo-school-logo.png";

const NAV_ITEMS: { to: string; label: string; roles?: Role[] }[] = [
  { to: "/", label: "Dashboard" },
  { to: "/staff", label: "Staff Directory" },
  { to: "/attendance", label: "Attendance" },
  { to: "/overtime", label: "Overtime" },
  { to: "/leave", label: "Leave" },
];

export function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <aside className="md:w-64 bg-white border-b md:border-b-0 md:border-r border-slate-200 flex md:flex-col">
        <div className="flex items-center gap-2 px-4 py-4">
          <img src={logo} alt="Kinbidhoo School" className="h-10 w-10 object-contain" />
          <div>
            <p className="font-semibold text-brand-700 leading-tight">Kinbidhoo School</p>
            <p className="text-xs text-slate-500 leading-tight">HR Portal</p>
          </div>
        </div>
        <nav className="flex-1 px-2 py-2 flex md:flex-col gap-1 overflow-x-auto">
          {NAV_ITEMS.filter((item) => !item.roles || (user && item.roles.includes(user.role))).map(
            (item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap ${
                    isActive
                      ? "bg-brand-50 text-brand-700"
                      : "text-slate-600 hover:bg-slate-100"
                  }`
                }
              >
                {item.label}
              </NavLink>
            )
          )}
        </nav>
        <div className="px-4 py-4 border-t border-slate-100 hidden md:block">
          <p className="text-sm font-medium">{user?.fullName}</p>
          <p className="text-xs text-slate-500">{user?.role}</p>
          <button
            onClick={() => logout()}
            className="mt-2 text-sm text-brand-600 hover:underline"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}
