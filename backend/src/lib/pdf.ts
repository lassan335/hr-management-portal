import PDFDocument from "pdfkit";

/**
 * Simple tabular PDF generator — used for the timesheet and overtime-summary
 * exports the spec calls for alongside CSV. Deliberately basic (title, a
 * plain table, a totals line) rather than a full reporting engine: this is
 * a printable record for payroll, not a design deliverable.
 */
export function buildTablePdf(params: {
  title: string;
  subtitle?: string;
  columns: { header: string; width: number }[];
  rows: (string | number)[][];
  totalsRow?: (string | number)[];
  /** "Checked by" / "Approved by" style sign-off blocks at the bottom. */
  signoff?: { label: string; name?: string; designation?: string }[];
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).text(params.title, { align: "left" });
    if (params.subtitle) {
      doc.moveDown(0.2);
      doc.fontSize(10).fillColor("#555555").text(params.subtitle);
      doc.fillColor("#000000");
    }
    doc.moveDown(1);

    const startX = doc.x;
    let y = doc.y;
    const rowHeight = 20;

    function drawRow(cells: (string | number)[], opts: { bold?: boolean; header?: boolean } = {}) {
      let x = startX;
      if (opts.header) {
        doc.rect(startX, y, params.columns.reduce((s, c) => s + c.width, 0), rowHeight).fill("#f1f5f9");
        doc.fillColor("#000000");
      }
      doc.font(opts.bold || opts.header ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      params.columns.forEach((col, i) => {
        doc.text(String(cells[i] ?? ""), x + 4, y + 6, { width: col.width - 8, ellipsis: true });
        x += col.width;
      });
      y += rowHeight;
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = doc.y;
      }
    }

    drawRow(params.columns.map((c) => c.header), { header: true });
    for (const row of params.rows) drawRow(row);
    if (params.totalsRow) {
      y += 4;
      drawRow(params.totalsRow, { bold: true });
    }

    if (params.signoff && params.signoff.length > 0) {
      y += 30;
      if (y > doc.page.height - 100) {
        doc.addPage();
        y = doc.y;
      }
      const blockWidth = params.columns.reduce((s, c) => s + c.width, 0) / params.signoff.length;
      params.signoff.forEach((block, i) => {
        const x = startX + i * blockWidth;
        doc.font("Helvetica").fontSize(9);
        doc.text("Sign: _______________________", x, y, { width: blockWidth - 10 });
        doc.text(`Name: ${block.name ?? "_______________________"}`, x, y + 20, { width: blockWidth - 10 });
        doc.text(`${block.label}${block.designation ? `: ${block.designation}` : ""}`, x, y + 36, { width: blockWidth - 10 });
      });
    }

    doc.end();
  });
}
