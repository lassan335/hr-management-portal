import ExcelJS from "exceljs";
import type { SalarySlipData } from "./payrollPdf";

/** One staff member's slip as a two-column (Details/Amount) worksheet,
 * matching the same line items as the PDF version. */
export async function buildSalarySlipExcel(data: SalarySlipData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Salary Slip");

  sheet.columns = [{ width: 4 }, { width: 40 }, { width: 18 }];

  sheet.addRow([`SALARY PARTICULARS - ${data.periodLabel}`]).font = { bold: true, size: 14 };
  sheet.addRow([data.schoolName]).font = { bold: true };
  sheet.addRow([data.schoolAddress]);
  sheet.addRow([]);
  sheet.addRow([`${data.staffName} (${data.nationalId})`]).font = { bold: true, underline: true };
  sheet.addRow([`Staff ID: ${data.staffCode}`]);
  sheet.addRow([`Designation: ${data.designation}`]);
  sheet.addRow([`Address: ${data.homeAddress}`]);
  sheet.addRow([`Bank Account: ${data.bankLine}`]);
  sheet.addRow([]);

  const headerRow = sheet.addRow(["#", "Details", "Amount (MVR)"]);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  });

  data.lines.forEach((line, i) => {
    // Most lines are plain amounts, but a couple (Payable Days, Attendance
    // Allowance Days) hold a non-numeric display string ("32 / 32") — write
    // those as text rather than forcing a numeric parse that yields NaN.
    const numeric = Number(line.value.replace(/,/g, ""));
    const cellValue = Number.isNaN(numeric) ? line.value : numeric;
    const row = sheet.addRow([line.bold ? "" : i + 1, line.label, cellValue]);
    if (!Number.isNaN(numeric)) row.getCell(3).numFmt = "#,##0.00";
    if (line.bold) {
      row.font = { bold: true };
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2F7" } };
      });
    }
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Every staff member's computed slip as one flat table — one row per
 * staff, matching the "payroll register" shape of the legacy spreadsheet
 * this feature was modeled on, rather than one page per person. */
export async function buildBulkSalarySlipExcel(
  slips: {
    staffCode: string;
    fullName: string;
    designation: string;
    basicSalary: number;
    payableDays: number;
    daysInPeriod: number;
    lateDeduction: number;
    absentDeduction: number;
    serviceDeduction: number;
    jobDeduction: number;
    salaryAfterLateAbsent: number;
    mibDeduction: number;
    pensionDeduction: number;
    otherDeduction: number;
    totalOtherDeduction: number;
    overtimeAllowance: number;
    daysPresent: number;
    attendanceAllowance: number;
    jobAllowanceNet: number;
    totalIncome: number;
    netPay: number;
    accountNumber: string;
    bankName: string;
  }[],
  periodLabel: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Salary Sheet");

  const columns: { header: string; key: string; width: number }[] = [
    { header: "#", key: "n", width: 5 },
    { header: "Staff ID", key: "staffCode", width: 12 },
    { header: "Name", key: "fullName", width: 24 },
    { header: "Designation", key: "designation", width: 24 },
    { header: "Basic Salary", key: "basicSalary", width: 14 },
    { header: "Payable Days", key: "payableDays", width: 12 },
    { header: "Deducted Late", key: "lateDeduction", width: 14 },
    { header: "Deducted Absent", key: "absentDeduction", width: 14 },
    { header: "Ded. Service Allow.", key: "serviceDeduction", width: 16 },
    { header: "Ded. Job Allow.", key: "jobDeduction", width: 14 },
    { header: "Salary After Late/Absent", key: "salaryAfterLateAbsent", width: 20 },
    { header: "Deducted MIB", key: "mibDeduction", width: 14 },
    { header: "Pension (7%)", key: "pensionDeduction", width: 14 },
    { header: "Deducted Others", key: "otherDeduction", width: 14 },
    { header: "Total Other Deduction", key: "totalOtherDeduction", width: 18 },
    { header: "Overtime Allowance", key: "overtimeAllowance", width: 16 },
    { header: "Attendance Days", key: "daysPresent", width: 14 },
    { header: "Attendance Allowance", key: "attendanceAllowance", width: 16 },
    { header: "Job Allowance", key: "jobAllowanceNet", width: 14 },
    { header: "Total Income", key: "totalIncome", width: 14 },
    { header: "Net Pay", key: "netPay", width: 14 },
    { header: "Bank", key: "bankName", width: 18 },
    { header: "Account Number", key: "accountNumber", width: 18 },
  ];

  sheet.addRow([`Kinbidhoo School — Salary Sheet — ${periodLabel}`]).font = { bold: true, size: 14 };
  sheet.addRow([]);
  // Only key/width here — assigning `.columns` with a `header` property also
  // auto-writes those headers into row 1, clobbering the title row above.
  // The header row is written explicitly below instead.
  sheet.columns = columns.map(({ key, width }) => ({ key, width }));

  const headerRow = sheet.getRow(3);
  columns.forEach((col, i) => (headerRow.getCell(i + 1).value = col.header));
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  });

  const moneyKeys = new Set([
    "basicSalary",
    "lateDeduction",
    "absentDeduction",
    "serviceDeduction",
    "jobDeduction",
    "salaryAfterLateAbsent",
    "mibDeduction",
    "pensionDeduction",
    "otherDeduction",
    "totalOtherDeduction",
    "overtimeAllowance",
    "attendanceAllowance",
    "jobAllowanceNet",
    "totalIncome",
    "netPay",
  ]);

  slips.forEach((s, i) => {
    const row = sheet.addRow({ n: i + 1, ...s });
    columns.forEach((col, ci) => {
      if (moneyKeys.has(col.key)) row.getCell(ci + 1).numFmt = "#,##0.00";
    });
  });

  const totalsRow = sheet.addRow({
    n: "",
    fullName: "Total",
    basicSalary: sum(slips, "basicSalary"),
    totalOtherDeduction: sum(slips, "totalOtherDeduction"),
    overtimeAllowance: sum(slips, "overtimeAllowance"),
    attendanceAllowance: sum(slips, "attendanceAllowance"),
    totalIncome: sum(slips, "totalIncome"),
    netPay: sum(slips, "netPay"),
  });
  totalsRow.font = { bold: true };
  columns.forEach((col, ci) => {
    if (moneyKeys.has(col.key)) totalsRow.getCell(ci + 1).numFmt = "#,##0.00";
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function sum<T extends Record<string, unknown>>(rows: T[], key: keyof T): number {
  return Math.round(rows.reduce((s, r) => s + Number(r[key] ?? 0), 0) * 100) / 100;
}
