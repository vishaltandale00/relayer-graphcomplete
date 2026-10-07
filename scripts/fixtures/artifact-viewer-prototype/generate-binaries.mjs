// PROTOTYPE fixture generator (issue #684). Regenerates the binary artifacts in
// thread-folder/ — PDF, PNG, video and Office files — so they are reproducible.
// Run: node scripts/fixtures/artifact-viewer-prototype/generate-binaries.mjs
// Needs: Playwright's Chromium, ffmpeg, python3 (a scratch venv is created for Office files).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const folder = join(here, "thread-folder");
const scratch = mkdtempSync(join(tmpdir(), "artifact-viewer-fixture-"));

const page = (body, css = "") => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#1d2a2a}${css}</style></head><body>${body}</body></html>`;

const browser = await chromium.launch();
try {
  // Investor brief: five A4 pages.
  const brief = await browser.newPage();
  const sections = [
    ["Tidewater Coffee", "Investor brief · Q4 2026", "A harbour roaster growing a subscription business with 41% repeat revenue."],
    ["The market", "Specialty coffee subscriptions", "UK subscription coffee grew 18% year on year. Customers churn when freshness drops; we roast weekly and ship within 72 hours."],
    ["Traction", "Revenue and retention", "1,240 active subscribers · £31k monthly recurring revenue · 3.1% monthly churn · 62 wholesale cafés."],
    ["The plan", "Use of funds", "£400k seed: a second roaster (40%), cold-chain fulfilment (25%), café wholesale team (20%), brand (15%)."],
    ["The ask", "Seed round", "£400k at a £3.2m pre-money valuation. Closing 15 January 2027. Contact: founders@tidewater.example"],
  ];
  await brief.setContent(page(sections.map(([title, kicker, text], index) => `
    <section class="sheet"><p class="kicker">${kicker}</p><h1>${title}</h1><p class="text">${text}</p>
    <div class="bar"><span style="width:${30 + index * 15}%"></span></div><p class="foot">Page ${index + 1} of ${sections.length}</p></section>`).join(""), `
    .sheet{height:297mm;padding:34mm 24mm;page-break-after:always;background:linear-gradient(160deg,#f6efe4 0%,#fffaf2 60%,#cfe8e3 100%);position:relative}
    .kicker{text-transform:uppercase;letter-spacing:.14em;color:#0f6e6a;font-size:13px}h1{font-size:54px;letter-spacing:-.03em;margin:8px 0 24px}
    .text{font-size:22px;line-height:1.5;max-width:150mm;color:#36504c}.bar{margin-top:30mm;height:14px;border-radius:7px;background:#e3d8c6}
    .bar span{display:block;height:100%;border-radius:7px;background:#d9783b}.foot{position:absolute;bottom:18mm;left:24mm;color:#7b8a87;font-size:13px}`));
  await brief.pdf({ path: join(folder, "docs/investor-brief.pdf"), format: "A4", printBackground: true });

  // Hero image.
  const hero = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await hero.setContent(page(`<div class="hero"><div class="sun"></div><div class="wave w1"></div><div class="wave w2"></div><div class="cup"></div><h1>Tidewater</h1><p>Roasted on the harbour</p></div>`, `
    .hero{width:1600px;height:900px;position:relative;overflow:hidden;background:linear-gradient(180deg,#f3c9a8 0%,#f6efe4 55%,#0f6e6a 55%,#10302f 100%)}
    .sun{position:absolute;width:300px;height:300px;border-radius:50%;background:#d9783b;left:1080px;top:240px;opacity:.9}
    .wave{position:absolute;left:-10%;width:120%;height:120px;border-radius:50%;border-top:10px solid #fffaf2;opacity:.5}.w1{top:520px}.w2{top:600px;opacity:.3}
    .cup{position:absolute;left:220px;top:330px;width:220px;height:200px;background:#fffaf2;border-radius:0 0 90px 90px;box-shadow:inset 0 30px 0 #6b3e1f}
    h1{position:absolute;left:520px;top:250px;font-size:150px;margin:0;color:#10302f;letter-spacing:-.04em}
    p{position:absolute;left:530px;top:440px;font-size:42px;margin:0;color:#36504c}`));
  await hero.screenshot({ path: join(folder, "brand/hero.png") });

  // Promo video: four chapters of five seconds, one frame per second.
  const frame = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const chapters = [["Roast", "#d9783b"], ["Pack", "#0f6e6a"], ["Ship", "#10302f"], ["Sip", "#6b3e1f"]];
  let index = 0;
  for (const [name, colour] of chapters) {
    for (let second = 0; second < 5; second += 1) {
      const t = index;
      await frame.setContent(page(`<div class="f"><p class="ch">Chapter ${chapters.findIndex(([n]) => n === name) + 1}</p><h1>${name}</h1><p class="t">0:${String(t).padStart(2, "0")}</p><div class="p"><span style="width:${(t + 1) * 5}%"></span></div></div>`, `
        .f{width:1280px;height:720px;background:${colour};color:#fffaf2;padding:90px}.ch{font-size:28px;letter-spacing:.2em;text-transform:uppercase;opacity:.75}
        h1{font-size:180px;margin:0;letter-spacing:-.04em}.t{font-size:48px;font-variant-numeric:tabular-nums}.p{position:absolute;left:90px;right:90px;bottom:80px;height:12px;background:rgba(255,255,255,.25);border-radius:6px}.p span{display:block;height:100%;background:#fffaf2;border-radius:6px}`));
      await frame.screenshot({ path: join(scratch, `frame-${String(index).padStart(3, "0")}.png`) });
      index += 1;
    }
  }
} finally {
  await browser.close();
}

execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", join(scratch, "frame-%03d.png"), "-c:v", "libvpx-vp9", "-b:v", "300k", "-r", "24", "-pix_fmt", "yuv420p", join(folder, "media/promo.webm")]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", join(scratch, "frame-%03d.png"), "-c:v", "libx264", "-crf", "30", "-r", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(folder, "media/promo.mp4")]);

// Office files through a throwaway Python venv.
const venv = join(scratch, "venv");
execFileSync("python3", ["-m", "venv", venv]);
execFileSync(join(venv, "bin/pip"), ["install", "--quiet", "python-docx", "openpyxl", "python-pptx"]);
const python = join(scratch, "office.py");
writeFileSync(python, `
import sys
from docx import Document
from docx.shared import Pt
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt as PPt
folder = sys.argv[1]

doc = Document()
doc.add_heading("Wholesale proposal: Harbour Hotel", 0)
doc.add_paragraph("Prepared by Tidewater Coffee for the Harbour Hotel food and beverage team.")
doc.add_heading("What we propose", 1)
for item in ["Weekly delivery of 18 kg espresso and filter blends", "Barista training for 6 staff, twice a year", "Free grinder servicing and a loan espresso machine"]:
    doc.add_paragraph(item, style="List Bullet")
doc.add_heading("Pricing", 1)
table = doc.add_table(rows=1, cols=3)
table.style = "Light Grid Accent 1"
for cell, text in zip(table.rows[0].cells, ["Blend", "Per kg", "Weekly"]):
    cell.text = text
for row in [["Harbour Espresso", "£19.50", "12 kg"], ["Low Tide Decaf", "£21.00", "2 kg"], ["Seasonal Filter", "£23.00", "4 kg"]]:
    cells = table.add_row().cells
    for cell, text in zip(cells, row):
        cell.text = text
doc.add_heading("Next steps", 1)
doc.add_paragraph("Tasting session on 4 November, then a four-week trial at the lobby café.")
doc.save(f"{folder}/docs/wholesale-proposal.docx")

wb = Workbook()
ws = wb.active
ws.title = "Budget"
ws.append(["Line", "Q1", "Q2", "Q3", "Q4"])
for row in [["Green beans", 21000, 23500, 24800, 27200], ["Packaging", 4200, 4600, 4900, 5300], ["Fulfilment", 6100, 6600, 7200, 8100], ["Marketing", 3000, 5500, 4000, 7000]]:
    ws.append(row)
ws.append(["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)", "=SUM(E2:E5)"])
for cell in ws[1]:
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="0F6E6A")
for cell in ws[6]:
    cell.font = Font(bold=True)
chart = BarChart()
chart.title = "Quarterly costs"
chart.add_data(Reference(ws, min_col=2, min_row=1, max_col=5, max_row=5), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=5))
ws.add_chart(chart, "G2")
wb.save(f"{folder}/docs/budget-2027.xlsx")

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
slide = prs.slides.add_slide(prs.slide_layouts[0])
slide.shapes.title.text = "Tidewater Coffee"
slide.placeholders[1].text = "Seed pitch · 2026"
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "Why now"
body = slide.placeholders[1].text_frame
body.text = "Subscriptions grew 18% this year"
for line in ["Freshness is the #1 churn reason", "We ship within 72 hours of roasting", "41% of revenue is repeat"]:
    body.add_paragraph().text = line
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Subscribers by quarter"
data = CategoryChartData()
data.categories = ["Q1", "Q2", "Q3", "Q4"]
data.add_series("Subscribers", (420, 690, 980, 1240))
slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1.5), Inches(1.6), Inches(10), Inches(5.4), data)
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "The ask"
slide.placeholders[1].text = "£400k seed at £3.2m pre-money"
prs.save(f"{folder}/docs/seed-pitch.pptx")
`);
execFileSync(join(venv, "bin/python"), [python, folder], { stdio: "inherit" });

rmSync(scratch, { recursive: true, force: true });
for (const file of ["docs/investor-brief.pdf", "brand/hero.png", "media/promo.webm", "media/promo.mp4", "docs/wholesale-proposal.docx", "docs/budget-2027.xlsx", "docs/seed-pitch.pptx"]) {
  if (!existsSync(join(folder, file))) throw new Error(`Missing generated ${file}`);
}
console.log("Generated fixture binaries in", folder);
