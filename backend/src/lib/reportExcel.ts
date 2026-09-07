import ExcelJS from "exceljs";

export interface ReportColumn {
  header: string;
  key: string;
  width: number;
  money?: boolean;
}

/**
 * Generic "school report" workbook — title row, header row, one row per
 * record, and a totals row — used for the Overtime Report and Attendance
 * Report bulk exports. Mirrors buildTablePdf's shape (lib/pdf.ts) so the
 * Excel and PDF versions of the same report show the same columns.
 */
export async function buildReportExcel(params: {
  title: string;
  subtitle?: string;
  sheetName: string;
  columns: ReportColumn[];
  rows: Record<string, string | number>[];
  totalsRow?: Record<string, string | number>;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(params.sheetName);

  sheet.addRow([params.title]).font = { bold: true, size: 14 };
  if (params.subtitle) sheet.addRow([params.subtitle]).font = { color: { argb: "FF555555" } };
  sheet.addRow([]);

  // Only key/width here (no `header`) — assigning a `header` on
  // worksheet.columns auto-writes it into row 1, which would clobber the
  // title row already added above. The header row is added explicitly below.
  sheet.columns = params.columns.map(({ key, width }) => ({ key, width }));

  const headerRow = sheet.addRow(Object.fromEntries(params.columns.map((c) => [c.key, c.header])));
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  });

  params.rows.forEach((row) => {
    const excelRow = sheet.addRow(row);
    params.columns.forEach((col, i) => {
      if (col.money) excelRow.getCell(i + 1).numFmt = "#,##0.00";
    });
  });

  if (params.totalsRow) {
    const totalsRow = sheet.addRow(params.totalsRow);
    totalsRow.font = { bold: true };
    params.columns.forEach((col, i) => {
      if (col.money) totalsRow.getCell(i + 1).numFmt = "#,##0.00";
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
