import PDFDocument from "pdfkit";

export interface SalarySlipLine {
  label: string;
  value: string;
  bold?: boolean;
}

export interface SalarySlipData {
  schoolName: string;
  schoolAddress: string;
  periodLabel: string;
  staffName: string;
  staffCode: string;
  nationalId: string;
  designation: string;
  homeAddress: string;
  bankLine: string;
  lines: SalarySlipLine[];
}

const MARGIN = 40;

function drawSlip(doc: PDFKit.PDFDocument, data: SalarySlipData) {
  doc.font("Helvetica-Bold").fontSize(18).text(`SALARY PARTICULARS - ${data.periodLabel}`, MARGIN, MARGIN);
  doc.moveDown(0.8);

  doc.font("Helvetica-Bold").fontSize(13).text(data.schoolName);
  doc.font("Helvetica").fontSize(10).fillColor("#555555").text(data.schoolAddress);
  doc.fillColor("#000000");
  doc.moveDown(0.8);

  doc.font("Helvetica-Bold").fontSize(12).text(`${data.staffName} (${data.nationalId})`, { underline: true });
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(10);
  doc.text(`Staff ID: ${data.staffCode}`);
  doc.text(`Designation: ${data.designation}`);
  doc.text(`Address: ${data.homeAddress}`);
  doc.text(`Bank Account: ${data.bankLine}`);
  doc.moveDown(0.8);

  const colWidths = [30, 350, 130];
  const startX = MARGIN;
  let y = doc.y;
  const rowHeight = 20;

  function drawRow(cells: string[], opts: { header?: boolean; bold?: boolean } = {}) {
    let x = startX;
    if (opts.header) {
      doc.rect(startX, y, colWidths.reduce((s, w) => s + w, 0), rowHeight).fill("#f1f5f9");
      doc.fillColor("#000000");
    }
    doc.font(opts.bold || opts.header ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    cells.forEach((cell, i) => {
      doc.text(cell, x + 4, y + 6, { width: colWidths[i] - 8, align: i === 2 ? "right" : "left" });
      x += colWidths[i];
    });
    y += rowHeight;
  }

  drawRow(["#", "Details", "Amount (MVR)"], { header: true });
  data.lines.forEach((line, i) => {
    if (line.bold) {
      doc.rect(startX, y, colWidths.reduce((s, w) => s + w, 0), rowHeight).fill("#eef2f7");
      doc.fillColor("#000000");
      drawRow(["", line.label, line.value], { bold: true });
    } else {
      drawRow([String(i + 1), line.label, line.value]);
    }
  });

  y += 10;
  doc.moveTo(startX, y).lineTo(startX + colWidths.reduce((s, w) => s + w, 0), y).stroke();
}

/** One staff member's salary slip as a standalone single-page PDF. */
export function buildSalarySlipPdf(data: SalarySlipData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    drawSlip(doc, data);
    doc.end();
  });
}

/** Every staff member's slip in one combined PDF, one per page — the
 * "generate salary sheet in one click" bulk export. */
export function buildBulkSalarySlipPdf(slips: SalarySlipData[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    slips.forEach((slip, i) => {
      if (i > 0) doc.addPage();
      drawSlip(doc, slip);
    });
    doc.end();
  });
}
