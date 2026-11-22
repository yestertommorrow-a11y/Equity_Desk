// Feed synthetic sections to detail.js (window.StockDetail.render) and check outputs.
import fs from "node:fs";
import vm from "node:vm";

const file = process.argv[2];
const listeners = [];
const ctxGlobal = {
  window: {}, console, Intl, Date, Math, Number, String, Array, Object, Set, Map, JSON, URL, RegExp, isFinite, parseFloat,
  document: { addEventListener: (...a) => listeners.push(a) },
};
ctxGlobal.window = ctxGlobal;
vm.createContext(ctxGlobal);
vm.runInContext(fs.readFileSync(file, "utf8"), ctxGlobal);
const D = ctxGlobal.StockDetail;

const results = [];
const check = (name, cond, detail = "") => results.push([name, !!cond, detail]);
const env = (data, extra = {}) => ({ data, source: "OpenBB · Test", warnings: [], ...extra });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
// Pull a stat-list value: "<dt>Label</dt><dd>value</dd>"
const stat = (html, label) => {
  const m = html.match(new RegExp("<dt>" + label.replace(/[()/]/g, "\\$&") + "</dt><dd>([^<]*)</dd>"));
  return m ? m[1] : undefined;
};
const tableRow = (html, title, label) => {
  const t = html.split(`data-table-name="${title}"`)[1];
  if (!t) return undefined;
  const row = t.split("</table>")[0].split("<tr").find((r) => r.includes(`<th scope="row">${label}</th>`));
  return row ? [...row.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]) : undefined;
};
function safe(name, fn) {
  try { fn(); } catch (e) { results.push([name, false, "EXCEPTION " + e.message + " @ " + (e.stack || "").split("\n")[1]]); }
}

// Four contiguous quarters + one-year-earlier balance.
const q = (date, rev, ni, extra = {}) => ({ period_ending: date, total_revenue: rev, net_income: ni, total_operating_income: ni * 1.2,
  total_pretax_income: ni * 1.25, income_tax_expense: ni * 0.25, diluted_eps: ni / 100, weighted_ave_basic_shares_os: 100, ...extra });
const bal = (date, extra = {}) => ({ period_ending: date, total_assets: 1000, total_current_assets: 400, total_current_liabilities: 200,
  inventory: 50, total_equity: 500, long_term_debt: 300, cash_and_cash_equivalents: 100, ...extra });
const cf = (date, ocf, capex) => ({ period_ending: date, operating_cash_flow: ocf, capital_expenditure: capex });

const baseSections = () => ({
  quote: env([{ last_price: 50, currency: "USD", market_cap: 5000 }]),
  profile: env([{ name: "Test Co" }]),
  income_quarter: env([q("2024-03-31", 100, 10), q("2024-06-30", 110, 11), q("2024-09-30", 120, 12), q("2024-12-31", 130, 13)]),
  balance_quarter: env([bal("2023-12-31", { total_equity: 400 }), bal("2024-12-31")]),
  cash_quarter: env([cf("2024-03-31", 20, -5), cf("2024-06-30", 20, -5), cf("2024-09-30", 20, -5), cf("2024-12-31", 20, -5)]),
  income_annual: env([q("2023-12-31", 380, 38), q("2024-12-31", 460, 46)]),
  balance_annual: env([bal("2023-12-31", { total_equity: 400 }), bal("2024-12-31")]),
  cash_annual: env([cf("2023-12-31", 70, -20), cf("2024-12-31", 80, -20)]),
  history: env([{ date: "2024-12-31", close: 50 }]),
});
const ctx = (extra = {}) => ({ symbol: "TEST", period: "annual", years: 10, format: "millions", currency: "USD", ...extra });

// ---------- Statistics TTM math ----------
safe("statistics TTM", () => {
  const s = baseSections();
  const html = D.render("statistics", s, ctx());
  check("TTM revenue = 460", stat(html, "Revenue") === "460", stat(html, "Revenue"));
  check("TTM net = 46", stat(html, "Net income") === "46", stat(html, "Net income"));
  check("TTM EPS = 0.46", stat(html, "EPS") === "0.46", stat(html, "EPS"));
  check("P/S = 5000/460 = 10.87×", stat(html, "P/S") === "10.87×", stat(html, "P/S"));
  check("P/E = 50/0.46 = 108.7×", stat(html, "P/E") === "108.7×", stat(html, "P/E"));
  check("ROE = 46/avg(400,500)=10.22%", stat(html, "Return on equity") === "10.22%", stat(html, "Return on equity"));
  check("FCF = 4*(20-5)=60", stat(html, "Free cash flow") === "60", stat(html, "Free cash flow"));
  check("Quick ratio (400-50)/200=1.75×", stat(html, "Quick ratio") === "1.75×", stat(html, "Quick ratio"));
});

// ---------- Missing quarter breaks TTM ----------
safe("TTM gap", () => {
  const s = baseSections();
  s.income_quarter = env([q("2024-03-31", 100, 10), q("2024-09-30", 120, 12), q("2024-12-31", 130, 13), q("2025-03-31", 140, 14)]);
  const html = D.render("financials", s, ctx({ period: "ttm" }));
  check("TTM with a missing quarter not shown", /Four consecutive reported quarters/.test(html) || !/TTM · 2025-03-31/.test(html), "renders TTM across a gap");
});

// ---------- Zero / negative denominators ----------
safe("negatives", () => {
  const s = baseSections();
  s.balance_quarter = env([bal("2023-12-31", { total_equity: -100 }), bal("2024-12-31", { total_equity: -50 })]);
  s.income_quarter = env([q("2024-03-31", 0, -10), q("2024-06-30", 0, -11), q("2024-09-30", 0, -12), q("2024-12-31", 0, -13)]);
  const html = D.render("statistics", s, ctx());
  check("negative equity: ROE blank", stat(html, "Return on equity") === "—", stat(html, "Return on equity"));
  check("negative equity: P/B blank", stat(html, "P/B") === "—", stat(html, "P/B"));
  check("zero revenue: P/S blank", stat(html, "P/S") === "—", stat(html, "P/S"));
  check("zero revenue: margins blank", stat(html, "Net margin") === "—", stat(html, "Net margin"));
  check("loss: P/E blank", stat(html, "P/E") === "—", stat(html, "P/E"));
  check("no NaN/Infinity anywhere", !/NaN|Infinity|∞/.test(text(html)), (text(html).match(/.{20}(NaN|Infinity|∞).{10}/) || [""])[0]);
});

// ---------- Strings, junk, nulls ----------
safe("junk values", () => {
  const s = baseSections();
  s.income_annual = env([{ period_ending: "2024-12-31", total_revenue: "1e3", net_income: "", diluted_eps: true, weighted_ave_basic_shares_os: "12abc" },
    { period_ending: "not-a-date", total_revenue: 5 }, null, "row", { total_revenue: 7 }]);
  const html = D.render("financials", s, ctx());
  check("junk rows render without NaN", !/NaN|undefined|\[object/.test(text(html)), (text(html).match(/.{30}(NaN|undefined|\[object).{10}/) || [""])[0]);
  const rev = tableRow(html, "Income Statement", "Total Revenue");
  check("numeric string '1e3' parsed", rev && rev.some((v) => v === "0"), JSON.stringify(rev));
  check("boolean EPS not shown as 1", !(tableRow(html, "Income Statement", "Diluted EPS") || []).includes("1"), JSON.stringify(tableRow(html, "Income Statement", "Diluted EPS")));
  const labels = [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
  check("undated/invalid rows excluded from columns", !labels.some((l) => /not-a-date|FY undefined|FY null/.test(l)), JSON.stringify(labels));
});

// ---------- XSS via provider text ----------
safe("xss", () => {
  const s = baseSections();
  const evil = `<img src=x onerror=alert(1)>`;
  s.filings = env([{ filing_date: "2024-01-01", form_type: evil, title: evil, report_url: "javascript:alert(1)" }]);
  s.splits = env([{ date: "2024-01-01", split_ratio: evil, numerator: 2, denominator: 1 }]);
  s.insiders = env([{ owner_name: evil, filing_date: "2024-01-01" }]);
  s.profile = env([{ name: evil }]);
  const docs = D.render("documents", s, ctx());
  const stats = D.render("statistics", s, ctx());
  const classic = D.render("classic", s, ctx());
  const all = docs + stats + classic + D.render("splits", s, ctx());
  check("no raw <img onerror>", !/<img/i.test(all), "raw tag rendered");
  check("javascript: URL not linked", !/href="javascript:/i.test(all));
  check("evil key names escaped", !/<script/i.test(D.render("statistics", { ...s, holders: env([{ ["<script>x</script>"]: 1 }]) }, ctx())));
});

// ---------- Ratios: YoY with negative base ----------
safe("ratios yoy", () => {
  const s = baseSections();
  s.income_annual = env([q("2022-12-31", 300, -5), q("2023-12-31", 380, 38), q("2024-12-31", 460, 46)]);
  s.balance_annual = env([bal("2022-12-31"), bal("2023-12-31", { total_equity: 400 }), bal("2024-12-31")]);
  const html = D.render("ratios", s, ctx({ yoy: true }));
  check("ratios YoY renders", /Profitability/.test(html));
  check("no NaN in YoY", !/NaN|Infinity/.test(text(html)));
});

// ---------- Splits parsing ----------
safe("split parsing", () => {
  const s = baseSections();
  s.splits = env([{ date: "2024-06-10", numerator: 10, denominator: 1 }, { date: "2021-01-01", split_ratio: "1:8" }, { date: "2020-01-01", split_ratio: "0.125" }, { date: "2019-01-01", split_ratio: "3/2" }]);
  const html = D.render("splits", s, ctx());
  check("10:1 forward", /10:1/.test(html) && /Forward/.test(html));
  check("1:8 reverse", (html.match(/Reverse/g) || []).length >= 2, (html.match(/Reverse/g) || []).length + " reverse labels");
  check("3:2 forward", /3:2/.test(html));
});

// ---------- Charts with one row / zero ----------
safe("charts edge", () => {
  const s = baseSections();
  s.history = env([{ date: "2024-12-31", close: 0, volume: 0 }]);
  s.chart_history = env([]);
  const html = D.render("charts", s, ctx({ log: true }));
  check("charts render without NaN coords", !/NaN/.test(html), (html.match(/.{40}NaN.{10}/) || [""])[0]);
  const html2 = D.render("charts", { ...s, history: env([{ date: "2024-12-31", close: 10 }, { date: "2024-12-31", close: 11 }]) }, ctx({ log: true }));
  check("single-date series no NaN", !/NaN/.test(html2), (html2.match(/.{40}NaN.{10}/) || [""])[0]);
  const html3 = D.render("charts", { ...s, history: env([{ date: "2024-01-01", close: 5 }, { date: "2024-06-01", close: 5 }]) }, ctx());
  check("flat series no NaN", !/NaN/.test(html3));
});

// ---------- TTM perShare / units ----------
safe("financials per share", () => {
  const s = baseSections();
  const html = D.render("financials", s, ctx({ period: "ttm", perShare: true }));
  const rev = tableRow(html, "Income Statement", "Total Revenue / share");
  check("TTM revenue per share = 460/100 = 4.6", rev && rev.at(-1) === "4.6", JSON.stringify(rev));
  const sh = tableRow(html, "Income Statement", "Weighted Ave Basic Shares Os");
  check("share count not divided by itself", sh && sh.at(-1) !== "1", JSON.stringify(sh));
});

// ---------- Statistics with currencies mixed ----------
safe("currency guard", () => {
  const s = baseSections();
  const html = D.render("statistics", s, ctx({ currency: "TWD" }));
  check("TWD vs USD: P/S blank", stat(html, "P/S") === "—", stat(html, "P/S"));
  check("TWD vs USD: dividend yield guarded?", stat(html, "Dividend yield") === "—", "dividend yield = " + stat(html, "Dividend yield"));
});

// ---------- Dividend yield uses dps in reporting currency ----------
safe("dividend yield", () => {
  const s = baseSections();
  s.income_quarter = env(s.income_quarter.data.map((r) => ({ ...r, cash_dividends_per_share: 0.25 })));
  const html = D.render("statistics", s, ctx());
  check("annual DPS = 1.00 (4 x 0.25)", stat(html, "Annual-period dividend per share") === "1", stat(html, "Annual-period dividend per share"));
  check("yield = 1/50 = 2%", stat(html, "Dividend yield") === "2%", stat(html, "Dividend yield"));
});

// ---------- CSV export cell guard ----------
safe("csv", () => {
  const cells = [];
  const fakeTable = { dataset: { tableName: "=T" }, rows: [{ hidden: false, cells: [{ textContent: "=1+1" }, { textContent: "-5%" }, { textContent: "@SUM(A1)" }] }] };
  let blobParts;
  ctxGlobal.Blob = function (parts) { blobParts = parts; };
  ctxGlobal.URL = Object.assign(function () {}, { createObjectURL: () => "blob:x", revokeObjectURL() {} });
  ctxGlobal.document.createElement = () => ({ click() {} });
  ctxGlobal.setTimeout = () => {};
  D.exportTables({ querySelectorAll: () => [fakeTable] }, "a.csv");
  const csv = blobParts ? blobParts[1] : "";
  check("csv guards formulas", csv.includes(`"'=1+1"`) && csv.includes(`"'@SUM(A1)"`) && csv.includes(`"-5%"`) && csv.includes(`"'=T"`), csv);
});

const bad = results.filter((r) => !r[1]);
for (const [n, ok, d] of results) if (!ok) console.log("FAIL " + n + (d ? "  | " + d : ""));
console.log(`${results.length - bad.length} passed, ${bad.length} failed`);
