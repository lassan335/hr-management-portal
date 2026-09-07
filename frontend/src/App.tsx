import { Routes, Route } from "react-router-dom";
import { AuthProvider } from "./lib/AuthContext";
import { ThemeProvider } from "./lib/ThemeContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { StaffPage } from "./pages/staff/StaffPage";
import { StaffDetailPage } from "./pages/staff/StaffDetailPage";
import { AttendancePage } from "./pages/attendance/AttendancePage";
import { OvertimePage } from "./pages/overtime/OvertimePage";
import { LeavePage } from "./pages/leave/LeavePage";
import { PayrollPage } from "./pages/payroll/PayrollPage";
import { HolidaysPage } from "./pages/holidays/HolidaysPage";

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/staff" element={<StaffPage />} />
              <Route path="/staff/:id" element={<StaffDetailPage />} />
              <Route path="/attendance" element={<AttendancePage />} />
              <Route path="/overtime" element={<OvertimePage />} />
              <Route path="/leave" element={<LeavePage />} />
              <Route path="/payroll" element={<PayrollPage />} />
              <Route path="/holidays" element={<HolidaysPage />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </ThemeProvider>
  );
}
