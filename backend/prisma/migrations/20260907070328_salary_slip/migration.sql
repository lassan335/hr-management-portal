-- Payroll figures for the salary slip feature, encrypted like the rest of
-- StaffBankDetail. Nullable — a staff member with none set simply can't have
-- a slip generated yet.
ALTER TABLE "StaffBankDetail"
  ADD COLUMN "basicSalaryEnc" TEXT,
  ADD COLUMN "serviceAllowanceEnc" TEXT,
  ADD COLUMN "jobAllowanceEnc" TEXT;

-- Manual per-staff, per-pay-period payroll inputs with no other source of
-- truth in this system (third-party loan deductions, HR-confirmed absence
-- deductions, the attendance-allowance daily rate).
CREATE TABLE "SalarySlipAdjustment" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "mibDeduction" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "otherDeduction" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "absentDeduction" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "attendanceAllowancePerDay" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalarySlipAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SalarySlipAdjustment_staffId_month_year_key" ON "SalarySlipAdjustment"("staffId", "month", "year");

ALTER TABLE "SalarySlipAdjustment" ADD CONSTRAINT "SalarySlipAdjustment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
