import fs from "node:fs"; import vm from "node:vm";
const g = { console, Intl, Date, Math, Number, String, Array, Object, Set, Map, JSON, URL, RegExp, document: { addEventListener() {} } };
g.window = g; vm.createContext(g); vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), g); const D = g.StockDetail;
const env = (data) => ({ data, source: "T", warnings: [] });
const stat = (h, l) => (h.match(new RegExp("<dt>" + l.replace(/[()/]/g, "\$&") + "</dt><dd>([^<]*)</dd>")) || [])[1];
const q = (d, rev, ni, x = {}) => ({ period_ending: d, total_revenue: rev, net_income: ni, total_operating_income: ni * 1.2, total_pretax_income: ni * 1.25, income_tax_expense: ni * .25, diluted_eps: ni / 100, weighted_ave_basic_shares_os: 100, ...x });
const bal = (d, x = {}) => ({ period_ending: d, total_assets: 1000, total_current_assets: 400, total_current_liabilities: 200, total_equity: 500, long_term_debt: 300, cash_and_cash_equivalents: 100, ...x });
const base = () => ({ quote: env([{ last_price: 50, currency: "USD", market_cap: 5000 }]), profile: env([{}]),
  income_quarter: env(["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"].map((d, i) => q(d, 100 + i * 10, 10 + i, { cash_dividends_per_share: 10 }))),
  balance_quarter: env([bal("2023-12-31"), bal("2024-12-31")]), income_annual: env([q("2024-12-31", 460, 46)]), balance_annual: env([bal("2024-12-31")]) });
const out = [];
// 1. Dividend yield across currencies: DPS 40 TWD/yr vs USD price 50
let h = D.render("statistics", { ...base(), metrics: env([{ currency: "TWD" }]) }, { symbol: "T", currency: "TWD" });
out.push(["Dividend yield TWD DPS / USD price", stat(h, "Dividend yield")]);
out.push(["Annual DPS shown", stat(h, "Annual-period dividend per share")]);
// 2. Shareholder-yield / FCF yield etc. same currency baseline
h = D.render("statistics", base(), { symbol: "T", currency: "USD" });
out.push(["USD Dividend yield (40/50)", stat(h, "Dividend yield")]);
// 3. TTM shares when one quarter lacks shares
const b = base(); b.income_quarter.data[1].weighted_ave_basic_shares_os = null;
h = D.render("financials", b, { symbol: "T", period: "ttm", perShare: true, years: 10, format: "millions", currency: "USD" });
out.push(["TTM per-share with a missing share count", (h.match(/Total Revenue \/ share<\/th>(.*?)<\/tr>/) || [])[1]]);
// 4. Quarterly 'quarterly' ROE should be blank, not annualised wrong
h = D.render("ratios", base(), { symbol: "T", period: "quarterly", years: 10, currency: "USD" });
out.push(["Quarterly ROE row", (h.match(/Return on equity<\/th>(.*?)<\/tr>/) || [])[1]]);
// 5. Statistics 52-week change with history shorter than a year
h = D.render("statistics", { ...base(), history: env([{ date: "2024-11-01", close: 40 }, { date: "2024-12-31", close: 50 }]) }, { symbol: "T", currency: "USD" });
out.push(["52-week change with 2 months history", stat(h, "52-week closing price change")]);
out.push(["50-session MA with 2 rows", stat(h, "50-session moving average")]);
// 6. EV when net debt negative
h = D.render("statistics", base(), { symbol: "T", currency: "USD" });
out.push(["EV = 5000 + (300-100)", stat(h, "Enterprise value")]);
// 7. Classic TTM label & columns
h = D.render("classic", base(), { symbol: "T", currency: "USD", years: 10 });
out.push(["Classic headers", [...h.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map(m => m[1]).join(",")]);
// 8. Interest coverage when interest expense is negative (some filers sign it negative)
const c = base(); c.income_annual.data[0].total_interest_expense = -10;
h = D.render("ratios", c, { symbol: "T", period: "annual", years: 10, currency: "USD" });
out.push(["Interest coverage with negative interest (55.2/10)", (h.match(/Interest coverage<\/th>(.*?)<\/tr>/) || [])[1]]);
// 9. Earnings tab surprise percent units
h = D.render("transcripts", { earnings: env([{ report_date: "2024-01-01", eps_actual: 1.1, eps_estimated: 1.0, surprise_percent: 10 }]) }, { symbol: "T" });
out.push(["Surprise 10 (points) displayed as", (h.match(/<td>([^<]*%)<\/td>/) || [])[1]]);
for (const [k, v] of out) console.log(k.padEnd(48), "→", v);
