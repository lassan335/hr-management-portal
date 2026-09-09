import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Users, Clock, Timer, CalendarDays, Wallet, CalendarOff, Bell, Sun, Moon, LogOut, Search, Menu, X } from "lucide-react";
import { Role } from "@hr/shared";
import { useAuth } from "../lib/AuthContext";
import { useTheme } from "../lib/ThemeContext";
import logo from "../assets/kinbidhoo-school-logo.png";

const NAV_ITEMS: { to: string; label: string; icon: typeof LayoutDashboard; roles?: Role[] }[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/staff", label: "Staff Directory", icon: Users },
  { to: "/attendance", label: "Attendance", icon: Clock },
  { to: "/overtime", label: "Overtime", icon: Timer },
  { to: "/leave", label: "Leave", icon: CalendarDays },
  { to: "/payroll", label: "Payroll", icon: Wallet },
  { to: "/holidays", label: "Holidays", icon: CalendarOff },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-screen flex">
      {drawerOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 bg-black/40 z-30 md:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-brand-800 dark:bg-brand-900 flex flex-col transition-transform duration-200 md:static md:translate-x-0 md:shrink-0 ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <img src={logo} alt="Kinbidhoo School" className="h-10 w-10 object-contain shrink-0 rounded-md bg-white p-0.5" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-white leading-tight truncate">Kinbidhoo School</p>
            <p className="text-xs text-brand-200 leading-tight">HR Portal</p>
          </div>
          <button
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="md:hidden text-brand-200 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 px-2 py-2 flex flex-col gap-1 overflow-y-auto">
          {NAV_ITEMS.filter((item) => !item.roles || (user && item.roles.includes(user.role))).map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                onClick={() => setDrawerOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-white/15 text-white"
                      : "text-brand-100 hover:bg-white/10 hover:text-white"
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
        <div className="px-4 py-4 border-t border-white/10 flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-white text-brand-700 text-xs font-semibold flex items-center justify-center shrink-0">
            {user ? initials(user.fullName) : ""}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white truncate">{user?.fullName}</p>
            <p className="text-xs text-brand-200">{user?.role}</p>
          </div>
          <button
            onClick={() => logout()}
            title="Sign out"
            className="text-brand-200 hover:text-red-300 shrink-0"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 md:px-8 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <button
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
            className="md:hidden p-2 -ml-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="relative flex-1 max-w-sm hidden sm:block">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              placeholder="Search…"
              className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="flex-1" />
          <button
            onClick={toggle}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
          >
            {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <button
            title="Notifications"
            className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
          >
            <Bell className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 pl-2 sm:border-l border-slate-200 dark:border-slate-800 shrink-0">
            <div className="h-8 w-8 rounded-full bg-brand-600 text-white text-xs font-semibold flex items-center justify-center">
              {user ? initials(user.fullName) : ""}
            </div>
            <div className="hidden sm:block leading-tight">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{user?.fullName}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{user?.googleEmail}</p>
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 md:p-8 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
