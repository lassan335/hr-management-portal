import { useAuth } from "../lib/AuthContext";

export function Dashboard() {
  const { user } = useAuth();
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-800">Welcome, {user?.fullName}</h1>
      <p className="text-slate-500 mt-1">
        Role: {user?.role} — use the sidebar to reach Staff Directory, Attendance,
        Overtime, and Leave.
      </p>
    </div>
  );
}
