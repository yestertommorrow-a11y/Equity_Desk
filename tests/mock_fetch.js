// Injected into the Equity Desk page: serves a synthetic company "MOCK" with known answers.
(() => {
  const env = (data, extra = {}) => ({ data, source: "OpenBB · Mock", error: null, warnings: [], fetched_at: "2026-11-22T00:00:00+00:00", ...extra });
  const days = (from, to) => { const out = []; for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); return out; };
  // Price doubles every 2 years: 1Y return = 41.42%, 3Y = 182.84%, 5Y = 465.69% (approx, trading-day grid)
  const priceAt = (iso) => 50 * Math.pow(2, (Date.parse(iso) - Date.parse("2021-11-20")) / (2 * 365.25 * 86400000));
  const hist = days("2019-11-01", "2026-11-20").map((d) => ({ date: d, open: priceAt(d), high: priceAt(d), low: priceAt(d), close: priceAt(d), volume: 1e6 }));
  const spy = days("2019-11-01", "2026-11-20").map((d) => ({ date: d, close: 400 }));
  const fy = [2021, 2022, 2023, 2024, 2025];
  // Annual: revenue 1000*1.1^n, net 10% margin, 100M shares
  const incomeA = fy.map((y, n) => ({ period_ending: `${y}-12-31`, fiscal_year: y, fiscal_period: "FY", total_revenue: 1e9 * 1.1 ** n,
    net_income: 1e8 * 1.1 ** n, total_operating_income: 1.5e8 * 1.1 ** n, total_pretax_income: 1.25e8 * 1.1 ** n, income_tax_expense: 0.25e8 * 1.1 ** n,
    diluted_eps: 1.1 ** n, basic_eps: 1.1 ** n, weighted_ave_basic_shares_os: 1e8, reported_currency: "USD" }));
  // Quarters 2024Q1..2026Q3, each quarter revenue 300M, net 30M (EPS 0.30), dps 0.25
  const qEnds = ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"];
  const incomeQ = qEnds.map((d) => ({ period_ending: d, fiscal_year: +d.slice(0, 4), fiscal_period: "Q" + Math.ceil(+d.slice(5, 7) / 3),
    total_revenue: 3e8, net_income: 3e7, total_operating_income: 4.5e7, total_pretax_income: 3.75e7, income_tax_expense: 7.5e6,
    diluted_eps: 0.3, basic_eps: 0.3, weighted_ave_basic_shares_os: 1e8, cash_dividends_per_share: 0.25, reported_currency: "USD" }));
  const bal = (d, equity) => ({ period_ending: d, total_assets: 2e9, total_current_assets: 8e8, total_current_liabilities: 4e8, net_inventory: 1e8,
    total_equity: equity, long_term_debt: 5e8, current_portion_of_long_term_debt: 5e7, cash_and_equivalents: 2e8, reported_currency: "USD" });
  const balanceA = fy.map((y, n) => bal(`${y}-12-31`, 1e9 + n * 1e8));
  const balanceQ = qEnds.map((d, n) => bal(d, 1.2e9 + n * 1e7));
  const cashA = fy.map((y) => ({ period_ending: `${y}-12-31`, operating_cash_flow: 2e8, capital_expenditure: -5e7, depreciation_and_amortization: 3e7, payment_of_dividends: -1e8 }));
  const cashQ = qEnds.map((d) => ({ period_ending: d, operating_cash_flow: 5e7, capital_expenditure: -1.25e7, depreciation_and_amortization: 7.5e6 }));
  // Dividends: 0.25 ex-dates in the middle month of each quarter
  const dividends = qEnds.map((d) => ({ ex_dividend_date: d.slice(0, 5) + String(+d.slice(5, 7) - 1).padStart(2, "0") + "-15", amount: 0.25 })).reverse();
  const data = {
    quote: env([{ symbol: "MOCK", name: "Mock Industries", last_price: 120, price: 120, prev_close: 100, previous_close: 100, change: 20, change_percent: 0.2, change_percent_points: 20,
      currency: "USD", exchange: "NMS", exchange_name: "NASDAQ", market_cap: 1.2e10, year_high: 130, year_low: 80 }]),
    profile: env([{ name: "Mock Industries <b>bold</b>", sector: "Testing", industry: "Synthetic", country: "United States", website: "javascript:alert(1)", description: "<img src=x onerror=alert(1)>" }]),
    metrics: env([{ currency: "USD" }]),
    history: env(hist.slice(-260), { metadata: { interval: "1d" } }),
    benchmark: env(spy.slice(-260)),
    income: { annual: env([...incomeA].reverse(), { metadata: { split_adjustment: { basis: "current" } } }), quarter: env([...incomeQ].reverse(), { metadata: { split_adjustment: { basis: "current" } } }) },
    balance: { annual: env([...balanceA].reverse()), quarter: env([...balanceQ].reverse()) },
    cash: { annual: env([...cashA].reverse()), quarter: env([...cashQ].reverse()) },
    dividends: env(dividends),
    splits: env([{ date: "2020-08-31", numerator: 4, denominator: 1 }]),
    earnings: env([{ report_date: "2026-10-30", eps_actual: 0.33, eps_estimated: 0.30, surprise_percent: 10 }]),
    earnings_calendar: env([{ report_date: "2027-01-28" }]),
    news: env([{ title: "<script>alert(1)</script> Mock news", url: "javascript:alert(1)", date: "2026-11-01" }]),
    filings: env([{ filing_date: "2026-10-31", form_type: "10-Q", report_url: "https://example.com/10q" }]),
  };
  const realFetch = window.__realFetch || window.fetch;
  window.__realFetch = realFetch;
  window.__mockLog = [];
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    const p = url.searchParams;
    if (url.pathname === "/api/search") {
      window.__mockLog.push("search:" + p.get("q"));
      return new Response(JSON.stringify(env([], { results: [] })), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/section" && p.get("symbol") === "MOCK") {
      const section = p.get("section"), period = p.get("period"), range = p.get("range");
      window.__mockLog.push(`${section}:${period}:${range}${p.get("refresh") ? ":refresh" : ""}`);
      let body = data[section];
      if (body && !Array.isArray(body.data) && body[period]) body = body[period];
      if (section === "history" && range === "5Y") body = env(hist.filter((r) => r.date >= "2021-11-20"), { metadata: { interval: "1d" } });
      if (section === "history" && range === "MAX") body = env(hist, { metadata: { interval: "1d" } });
      if (section === "benchmark" && range === "5Y") body = env(spy.filter((r) => r.date >= "2021-11-20"));
      body = body || env([], { error: "No OpenBB " + section + " feed is configured for this listing." });
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  };
  return "mock installed";
})();
