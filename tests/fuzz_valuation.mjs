import fs from "node:fs"; import vm from "node:vm";
const g = { console, Intl, Date, Math, Number, String, Array, Object, Set, Map, JSON, URL, RegExp, document: { addEventListener() {} } };
g.window = g; vm.createContext(g); vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), g); const D = g.StockDetail;
const env = (data, extra = {}) => ({ data, source: "T", warnings: [], ...extra });
const results = []; const check = (n, c, d = "") => results.push([n, !!c, d]);
// 12 quarters 2023Q1..2025Q4; each quarter: revenue 250, net 25 (EPS 0.25), 100 shares; equity 1000; debt 300, cash 100; D&A 5, op 30
const qEnds = []; for (const y of [2023, 2024, 2025]) for (const md of ["03-31", "06-30", "09-30", "12-31"]) qEnds.push(`${y}-${md}`);
const inc = qEnds.map(d => ({ period_ending: d, total_revenue: 250, net_income: 25, total_operating_income: 30, depreciation_and_amortization: 5, diluted_eps: 0.25, weighted_ave_basic_shares_os: 100, cash_dividends_per_share: 0.1 }));
const bal = qEnds.map(d => ({ period_ending: d, total_equity: 1000, long_term_debt: 300, cash_and_cash_equivalents: 100, total_assets: 2000 }));
const cf = qEnds.map(d => ({ period_ending: d, operating_cash_flow: 30, capital_expenditure: -10 }));
// Daily prices: 20 through 2023, 30 through 2024, 40 in 2025; quote 50
const prices = []; for (let t = Date.parse("2023-01-01"); t <= Date.parse("2025-12-31"); t += 86400000) { const d = new Date(t).toISOString().slice(0, 10); prices.push({ date: d, close: d < "2024" ? 20 : d < "2025" ? 30 : 40 }); }
const sections = { quote: env([{ last_price: 50, currency: "USD" }]), income_quarter: env(inc, { metadata: { split_adjustment: { basis: "current" } } }), balance_quarter: env(bal), cash_quarter: env(cf),
  income_annual: env([2023, 2024, 2025].map(y => ({ period_ending: `${y}-12-31`, total_revenue: 1000, net_income: 100, total_operating_income: 120, depreciation_and_amortization: 20, diluted_eps: 1, weighted_ave_basic_shares_os: 100 })), { metadata: { split_adjustment: { basis: "current" } } }),
  balance_annual: env([2023, 2024, 2025].map(y => ({ period_ending: `${y}-12-31`, total_equity: 1000, long_term_debt: 300, cash_and_cash_equivalents: 100 }))),
  cash_annual: env([2023, 2024, 2025].map(y => ({ period_ending: `${y}-12-31`, operating_cash_flow: 120, capital_expenditure: -40 }))),
  chart_history: env(prices) };
const ctx = { symbol: "T", currency: "USD", quoteCurrency: "USD", years: 10, period: "annual" };
const html = D.render("ratios", sections, ctx);
const row = (title, label) => { const t = html.split(`data-table-name="${title}"`)[1]?.split("</table>")[0]; const r = t?.split("<tr").find(x => x.includes(`<th scope="row">${label}</th>`)); return r ? [...r.matchAll(/<td>([^<]*)<\/td>/g)].map(m => m[1]) : undefined; };
// TTM points at quarter ends from 2023-12-31 (first full TTM) : EPS 1.00, revenue 1000, mcap = price*100
// 2023-12-31 price 20 -> P/E 20; 2024 ends price 30 -> 30; 2025 price 40 -> 40. Current: 50/1 = 50.
const pe = row("Valuation history", "P/E");
check("Current P/E = 50", pe?.[0] === "50×", JSON.stringify(pe));
// 5Y points: 2023-12-31 (20), 2024 Q1-Q4 (30 x4), 2025 Q1-Q4 (40 x4) => avg (20+120+160)/9 = 33.33
check("5Y average P/E = 33.33", pe?.[1] === "33.33×", JSON.stringify(pe));
check("5Y low/high 20/40", pe?.[3] === "20×" && pe?.[4] === "40×", JSON.stringify(pe));
check("vs average 50% above", pe?.[5] === "50% above", JSON.stringify(pe));
const ps = row("Valuation history", "P/S"); check("Current P/S = 5000/1000 = 5", ps?.[0] === "5×", JSON.stringify(ps));
const pb = row("Valuation history", "P/B"); check("Current P/B = 5000/1000 = 5", pb?.[0] === "5×", JSON.stringify(pb));
const ev = row("Valuation history", "EV / EBITDA"); check("Current EV/EBITDA = (5000+200)/140 = 37.14", ev?.[0] === "37.14×", JSON.stringify(ev));
const dy = row("Valuation history", "Dividend yield"); check("Current yield = 0.4/50 = 0.8%", dy?.[0] === "0.8%", JSON.stringify(dy));
const fcf = row("Valuation history", "Free cash flow yield"); check("Current FCF yield = 80/5000 = 1.6%", fcf?.[0] === "1.6%", JSON.stringify(fcf));
// Annual Valuation & Yield table: FY2023 price 20 EPS 1 -> 20; FY2024 30; FY2025 40
const annualPe = row("Valuation &amp; Yield", "P/E"); check("Annual P/E 20/30/40", JSON.stringify(annualPe) === JSON.stringify(["20×", "30×", "40×"]), JSON.stringify(annualPe));
// Quarterly view uses TTM figures
const qhtml = D.render("ratios", sections, { ...ctx, period: "quarterly" });
const qrow = qhtml.split('data-table-name="Valuation &amp; Yield"')[1]?.split("</table>")[0].split("<tr").find(x => x.includes('<th scope="row">P/E</th>'));
check("Quarterly P/E uses TTM EPS (last = 40)", qrow && [...qrow.matchAll(/<td>([^<]*)<\/td>/g)].map(m => m[1]).at(-1) === "40×", qrow && [...qrow.matchAll(/<td>([^<]*)<\/td>/g)].map(m => m[1]).join(","));
// Currency mismatch blanks everything
const tw = D.render("ratios", sections, { ...ctx, currency: "TWD" });
check("TWD vs USD: valuation history explains", /Prices are in USD and statements in TWD/.test(tw));
check("TWD vs USD: no P/E in table", !row.call(null, "Valuation &amp; Yield", "P/E") || !/[0-9]×/.test((tw.split('data-table-name="Valuation &amp; Yield"')[1] || "").split("</table>")[0].split("P/E</th>")[1]?.split("</tr>")[0] || ""));
// Unconfirmed split basis: drop periods before the split
const s2 = { ...sections, income_quarter: env(inc, { metadata: { split_adjustment: { basis: "partial" } } }), splits: env([{ date: "2025-01-15", numerator: 2, denominator: 1 }]) };
const sp = D.render("ratios", s2, ctx);
check("partial basis: note shown", /before the Jan 15, 2025 split are omitted/.test(sp));
// Loss-making: P/E blank, others still computed
const s3 = { ...sections, income_quarter: env(inc.map(r => ({ ...r, net_income: -25, diluted_eps: -0.25 }))) };
const loss = D.render("ratios", s3, ctx);
const lpe = loss.split('data-table-name="Valuation history"')[1]?.split("</table>")[0].split("<tr").find(x => x.includes(">P/E<"));
check("loss: current P/E blank", lpe && [...lpe.matchAll(/<td>([^<]*)<\/td>/g)][0][1] === "—", lpe);
// No history: explains
check("no price history: explains", /Price history is needed/.test(D.render("ratios", { ...sections, chart_history: env([]) }, ctx)));
check("no NaN/Infinity", !/NaN|Infinity/.test(html + qhtml + loss));
for (const [n, ok, d] of results) console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : "  | " + d));
