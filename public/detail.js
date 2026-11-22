(() => {
  "use strict";

  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const text = value => esc(value ?? "—");
  const num = value => (typeof value === "number" || (typeof value === "string" && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
  const quotient = (a, b) => a != null && b != null && b !== 0 ? a / b : null;
  const difference = (a, b) => a != null && b != null ? a - b : null;
  const sum = (...args) => args.every(value => value != null) ? args.reduce((a, b) => a + b, 0) : null;
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
  const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const full = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
  const date = value => {
    const iso = String(value ?? "").match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    return iso ?? (value ? String(value) : "");
  };
  const dateLabel = value => {
    const iso = date(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "—";
    const parsed = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(parsed.valueOf()) ? iso : parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  };
  const human = key => String(key).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase()).replace(/\b(?:Eps|Ebitda|Ebit|Roic|Roa|Roe|Fcf|Cik|Isin|Cusip|Gaap|Ttm|Ppe)\b/g, value => value.toUpperCase());
  const safeURL = value => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  const link = (url, label) => safeURL(url) ? `<a href="${esc(safeURL(url))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);

  const metadata = new Set(["id", "symbol", "ticker", "provider", "source", "source_url", "currency", "reported_currency", "filing_date", "accepted_date", "fiscal_period", "fiscal_year", "fiscal_quarter", "fiscal_date_ending", "fiscal_period_end_date", "period", "period_end", "period_ending", "period_end_date", "calendar_year", "year", "quarter", "date", "updated_at", "link", "final_link", "cik", "timestamp", "url"]);
  const dateOf = row => date(row?.period_ending ?? row?.period_end_date ?? row?.fiscal_date_ending ?? row?.fiscal_period_end_date ?? row?.period_end ?? row?.date ?? row?.ex_dividend_date ?? row?.calendar_date ?? row?.filing_date ?? row?.published_at);
  const sorted = rows => [...rows].sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
  const latest = rows => sorted(rows).at(-1) ?? {};
  const kind = ctx => ({ fy: "annual", annual: "annual", yearly: "annual", quarter: "quarterly", quarterly: "quarterly", ttm: "ttm", trailing: "ttm" })[String(ctx.period ?? "annual").toLowerCase()] ?? "annual";

  function unwrap(value, period) {
    if (Array.isArray(value)) return value.filter(row => row && typeof row === "object");
    if (!value || typeof value !== "object") return [];
    const direct = value[period] ?? (period === "annual" ? value.yearly : null) ?? (period === "quarterly" ? value.quarter : null) ?? value.results ?? value.records ?? value.rows;
    if (Array.isArray(direct)) return unwrap(direct, period);
    if (["annual", "yearly", "quarterly", "quarter", "ttm"].some(key => key in value)) return [];
    return Object.keys(value).length ? [value] : [];
  }

  function section(sections, name, period) {
    const alternate = period === "quarterly" ? [name + "_q", name + "_quarter", name + "_quarterly", "quarterly_" + name] : period === "annual" ? [name + "_annual", "annual_" + name] : [];
    return alternate.map(key => sections[key]).find(Boolean) ?? sections[name] ?? {};
  }

  function records(sections, name, period) {
    const selected = section(sections, name, period);
    return unwrap(selected.data ?? selected.results ?? selected.data_rows, period);
  }

  function field(row, ...keys) {
    for (const key of keys.flat()) {
      const normalized = row[key];
      if (normalized != null && normalized !== "") return normalized;
    }
    return null;
  }

  const fields = {
    revenue: ["total_revenue", "revenue", "sales", "operating_revenue"],
    cost: ["total_cost_of_revenue", "cost_of_revenue", "cost_of_goods_sold", "cost_of_goods_and_services_sold", "operating_cost_of_revenue"],
    gross: ["total_gross_profit", "gross_profit"], op: ["total_operating_income", "operating_income", "income_from_operations", "ebit"],
    pretax: ["total_pretax_income", "total_pre_tax_income", "pretax_income", "income_before_tax", "income_before_taxes", "income_before_income_taxes"],
    tax: ["income_tax_expense", "tax_provision", "provision_for_income_taxes", "tax_expense"],
    net: ["net_income", "net_income_loss", "net_income_common_stockholders"],
    ebitda: ["ebitda", "normalized_ebitda"], eps: ["diluted_eps", "eps_diluted", "diluted_earnings_per_share", "basic_diluted_eps", "eps", "basic_eps", "eps_basic"],
    shares: ["weighted_ave_basic_shares_os", "weighted_ave_basic_diluted_shares_os", "basic_average_shares", "weighted_average_shares_outstanding", "weighted_average_basic_shares_outstanding", "weighted_average_basic_shares", "basic_weighted_average_shares", "weighted_average_shares", "ordinary_shares_number", "shares_outstanding", "common_shares_outstanding"],
    assets: ["total_assets", "assets"], liabilities: ["total_liabilities_net_minority_interest", "total_liabilities", "liabilities"],
    currentAssets: ["current_assets", "total_current_assets", "assets_current"], currentLiab: ["current_liabilities", "total_current_liabilities", "liabilities_current"],
    cash: ["cash_and_cash_equivalents", "cash_and_short_term_investments", "cash_cash_equivalents_and_short_term_investments", "cash_cash_equivalents", "cash_and_equivalents"],
    inventory: ["inventory", "inventories", "net_inventory"],
    da: ["depreciation_and_amortization", "depreciation_amortization_depletion", "depreciation_depletion_and_amortization", "reconciled_depreciation"],
    interest: ["interest_expense", "total_interest_expense", "interest_expense_non_operating"], equity: ["stockholders_equity", "total_equity", "total_stockholders_equity", "shareholders_equity", "total_equity_gross_minority_interest", "total_shareholders_equity", "common_stock_equity", "total_common_equity"],
    debt: ["total_debt", "total_debt_and_lease_obligation", "short_long_term_debt_total"],
    longDebt: ["long_term_debt", "long_term_debt_noncurrent", "long_term_debt_and_capital_lease_obligation"],
    shortDebt: ["current_debt", "short_term_debt", "current_debt_and_capital_lease_obligation"],
    ocf: ["operating_cash_flow", "net_cash_from_operating_activities", "net_cash_provided_by_operating_activities", "net_cash_provided_by_used_in_operating_activities"],
    capex: ["capital_expenditure", "capital_expenditures", "purchase_of_plant_property_and_equipment", "payments_to_acquire_property_plant_and_equipment", "capex"],
    fcf: ["free_cash_flow", "fcf"], dps: ["cash_dividends_per_share", "dividend_per_share", "dividends_per_share", "dividend_rate"],
    divs: ["cash_dividends_paid", "payment_of_dividends", "payments_of_dividends", "dividends_paid"],
    mcap: ["market_cap", "market_capitalization", "marketcap"], ev: ["enterprise_value", "enterprisevalue"],
    price: ["last_price", "price", "close", "last", "regular_market_price"],
    pe: ["pe_ratio", "price_to_earnings_ratio", "trailing_pe", "pe"],
  };
  const read = (row, name) => num(field(row, fields[name] ?? [name]));

  function cleanRows(rows) {
    const byDate = new Map();
    for (const row of rows) {
      const end = dateOf(row);
      if (end) byDate.set(end, row);
    }
    return sorted([...byDate.values()]);
  }

  function quarterlyTTM(rows, pointInTime) {
    if (pointInTime) return rows;
    return rows.flatMap((row, index) => {
      if (index < 3) return [];
      const four = rows.slice(index - 3, index + 1);
      const continuous = four.slice(1).every((current, i) => {
        const days = (Date.parse(dateOf(current)) - Date.parse(dateOf(four[i]))) / 86400000;
        return days >= 58 && days <= 126;
      });
      if (!continuous) return [];
      const currency = new Set(four.map(item => item.currency ?? item.reported_currency).filter(Boolean));
      if (currency.size > 1) return [];
      const ttm = Object.fromEntries(Object.entries(row).filter(([key]) => metadata.has(key)));
      Object.keys(row).filter(key => !metadata.has(key) && !/(?:^|_)(?:ratio|margin|yield|growth|percent|rate)(?:_|$)/i.test(key)).forEach(key => {
        const values = four.map(item => num(item[key]));
        if (/cash_(?:at_|position_)?beginning|beginning_cash/.test(key)) {
          if (values[0] != null) ttm[key] = values[0];
          return;
        }
        if (/cash_(?:at_|position_)?end|end_cash/.test(key)) {
          if (values[3] != null) ttm[key] = values[3];
          return;
        }
        if (/shares|headcount|employees/i.test(key)) {
          // Average counts over the quarters that have one: the backend blanks implausible share
          // counts, and one gap should not void the whole trailing year.
          const present = values.filter(value => value != null);
          if (present.length >= 3) ttm[key] = present.reduce((a, b) => a + b, 0) / present.length;
          return;
        }
        if (values.some(value => value == null)) return;
        ttm[key] = values.reduce((a, b) => a + b, 0);
      });
      return [ttm];
    });
  }

  function statement(sections, name, selected) {
    if (selected !== "ttm") return cleanRows(records(sections, name, selected));
    const explicitTTM = unwrap(sections[name]?.data?.ttm);
    if (explicitTTM.length) return cleanRows(explicitTTM);
    const qRows = cleanRows(records(sections, name, "quarterly"));
    return quarterlyTTM(qRows, name === "balance");
  }

  function fieldRows(rows, ordered) {
    const available = Array.from(new Set(rows.flatMap(row => Object.keys(row))))
      .filter(key => !metadata.has(key) && rows.some(row => num(row[key]) !== null));
    return [...ordered.filter(key => available.includes(key)), ...available.filter(key => !ordered.includes(key))];
  }

  function number(value, type, ctx = {}) {
    const n = num(value);
    if (n == null) return "—";
    if (type === "pct") return `${plain.format(n * 100)}%`;
    if (type === "multiple") return `${plain.format(n)}×`;
    if (type === "price") return plain.format(n);
    const format = String(ctx.format || "compact").toLowerCase();
    if (format === "full" || format === "absolute" || format === "raw") return full.format(n);
    if (format === "millions" || format === "million" || format === "mm") return plain.format(n / 1e6);
    if (format === "billions" || format === "billion" || format === "bn") return plain.format(n / 1e9);
    if (format === "thousands" || format === "thousand") return plain.format(n / 1e3);
    return compact.format(n);
  }

  function periodLabel(row, period) {
    const value = dateOf(row);
    const year = row.fiscal_year ?? row.calendar_year ?? value.slice(0, 4);
    const q = String(row.fiscal_period ?? row.fiscal_quarter ?? row.period ?? "").replace(/^(?:Q)?([1-4])(?:Q)?$/i, "Q$1");
    if (period === "ttm") return `TTM · ${value}`;
    if (period === "quarterly") return /^Q[1-4]$/i.test(q) ? `FY${year} ${q.toUpperCase()}` : value;
    return `FY ${year}`;
  }

  function sourceLabel(src) {
    if (!src) return "";
    if (typeof src === "string") return safeURL(src) ? link(src, new URL(src).hostname) : esc(src);
    const label = src.provider || src.name || src.label || src.command || "Source";
    return src.url ? link(src.url, label) : esc(label);
  }

  function foot(envelopes = []) {
    const labels = [...new Set(envelopes.map(item => sourceLabel(item?.source)).filter(Boolean))];
    const warnings = [...new Set(envelopes.flatMap(item => item?.warnings || []).map(item => typeof item === "string" ? item : item?.message).filter(Boolean))];
    return labels.length || warnings.length ? `<div class="section-meta">${labels.length ? `Source · ${labels.join(" · ")}` : ""}${warnings.length ? `<div>${warnings.map(esc).join(" · ")}</div>` : ""}</div>` : "";
  }

  function panel(title, body, opts = {}) {
    return `<section class="panel ${esc(opts.cls ?? "")}"><div class="panel-head"><h2>${esc(title)}</h2>${opts.meta ? `<span>${esc(opts.meta)}</span>` : ""}</div>${body}${foot(opts.sources)}</section>`;
  }

  function empty(message, result) {
    const error = typeof result?.error === "string" ? result.error : result?.error?.message;
    return `<div class="empty-state">${esc(result?.loading ? "Loading from OpenBB…" : message)}${error ? `<p>${esc(error)}</p>` : ""}</div>`;
  }

  function table(headers, rows, title, customize = false) {
    const selector = customize ? `<details class="table-customize"><summary>Customize view</summary><div>${rows.map((row, i) => `<label><input type="checkbox" data-detail-row="${i}" checked> ${esc(row[0])}</label>`).join("")}</div></details>` : "";
    return `${selector}<div class="table-scroll"><table class="metric-table" data-table-name="${esc(title)}"><thead><tr>${headers.map(item => `<th scope="col">${esc(item)}</th>`).join("")}</tr></thead><tbody>${rows.map((row, i) => `<tr data-detail-row-id="${i}">${row.map((value, j) => j === 0 ? `<th scope="row">${esc(value)}</th>` : `<td>${esc(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  const statementNames = { income: "Income Statement", balance: "Balance Sheet", cash: "Cash Flow Statement" };
  const order = {
    income: [fields.revenue, fields.cost, fields.gross, ["research_and_development", "selling_general_and_administration", "operating_expenses"], fields.op, ["interest_expense", "other_income_expense"], fields.pretax, fields.tax, fields.net, fields.ebitda, fields.eps, fields.shares],
    balance: [fields.cash, ["receivables", "accounts_receivable"], fields.inventory, fields.currentAssets, ["net_ppe", "goodwill", "other_intangible_assets", "total_non_current_assets"], fields.assets, ["accounts_payable"], fields.shortDebt, fields.currentLiab, fields.longDebt, fields.liabilities, fields.equity, fields.debt, ["net_debt", "working_capital"]],
    cash: [fields.net, ["depreciation_and_amortization", "depreciation_amortization_depletion", "stock_based_compensation", "change_in_working_capital"], fields.ocf, fields.capex, ["investing_cash_flow", "financing_cash_flow"], fields.divs, ["repurchase_of_capital_stock", "changes_in_cash", "end_cash_position"], fields.fcf]
  };

  function priorPeriod(rows, index) {
    const target = Date.parse(dateOf(rows[index]));
    const candidates = rows.slice(0, index).filter(row => {
      const diff = (target - Date.parse(dateOf(row))) / 86400000;
      return diff >= 340 && diff <= 390;
    });
    if (!candidates.length) return null;
    return candidates.reduce((closest, row) => Math.abs(target - Date.parse(dateOf(row)) - 365 * 86400000) < Math.abs(target - Date.parse(dateOf(closest)) - 365 * 86400000) ? row : closest);
  }

  function statementPanel(sections, name, ctx) {
    const period = kind(ctx);
    const rows = statement(sections, name, period);
    const income = statement(sections, "income", period);
    const rowShares = row => read(row, "shares") ?? read(income.find(item => dateOf(item) === dateOf(row)) ?? {}, "shares");
    const title = statementNames[name];
    const envelope = section(sections, name, period === "ttm" ? "quarterly" : period);
    if (!rows.length) return panel(title, empty(period === "ttm" ? "Four consecutive reported quarters are needed for a trailing twelve-month statement." : "No statements returned for this period.", envelope), { sources: [envelope] });
    const usesLimit = Number(ctx.years) > 0;
    const visible = usesLimit ? rows.slice(-Number(ctx.years) * (period === "quarterly" || period === "ttm" ? 4 : 1)) : rows;
    const reportedCurrency = row => row.reported_currency ?? row.currency;
    const currencies = [...new Set(visible.map(reportedCurrency).filter(Boolean))];
    const currency = currencies.length === 1 ? currencies[0] : currencies.length > 1 ? "Mixed currencies" : ctx.currency || "Reported currency";
    const scale = ["millions", "billions", "thousands"].includes(ctx.format) && !ctx.yoy && !ctx.perShare ? ` · in ${ctx.format}, except per share and ratios` : "";
    const currencyHint = ctx.displayCurrency && !["native", "reported", "LOCAL", currency].includes(ctx.displayCurrency) ? `<div class="section-meta">${esc(ctx.displayCurrency)} conversion is unavailable. Values retain their ${esc(currency)} reporting basis.</div>` : "";
    const keys = fieldRows(visible, order[name].flat());
    const values = keys.map(key => {
      const alreadyPerShare = /(^|_)eps($|_)|per_share/i.test(key);
      const dimensionless = /(^|_)(ratio|margin|yield|rate|growth|percent)(_|$)/i.test(key);
      const shareCount = /share(s|_count|_outstanding)/i.test(key) && !alreadyPerShare && !/(repurchase|capital_stock)/i.test(key);
      const perShare = ctx.perShare && !shareCount && !dimensionless && !alreadyPerShare;
      const normalize = row => {
        const value = num(row[key]);
        return perShare ? quotient(value, rowShares(row)) : value;
      };
      return [human(key) + (perShare ? " / share" : ""), ...visible.map(row => {
        const value = normalize(row);
        if (!ctx.yoy) return number(value, perShare || alreadyPerShare || dimensionless ? "price" : null, ctx);
        const prior = priorPeriod(rows, rows.indexOf(row));
        const comparable = prior && (!reportedCurrency(row) || !reportedCurrency(prior) || reportedCurrency(row) === reportedCurrency(prior));
        const base = comparable ? normalize(prior) : null;
        return number(base > 0 ? quotient(difference(value, base), base) : null, "pct", ctx);
      })];
    });
    values.unshift(["Period ended", ...visible.map(row => dateOf(row) || "—")]);
    if (currencies.length > 1) values.splice(1, 0, ["Reporting currency", ...visible.map(row => reportedCurrency(row) || "—")]);
    const note = period === "ttm" && name === "balance" ? `<div class="section-meta">Balance sheet values are point-in-time snapshots at the quarter end.</div>` : period === "ttm" ? `<div class="section-meta">Rolling four reported quarters. Share counts use the mean of the four quarters.</div>` : "";
    return panel(title, `${currencyHint}${table(["Line item", ...visible.map(row => periodLabel(row, period))], values, title, true)}${note}`, { meta: `${currency}${ctx.yoy ? " · YoY" : ctx.perShare ? " · per share" : scale}`, sources: [envelope] });
  }

  function align(rows, target) {
    const match = rows.find(row => dateOf(row) === dateOf(target));
    if (match) return match;
    // Providers date the same period differently (SEC 2026-01-25, Yahoo 2026-01-31).
    const near = rows.find(row => Math.abs(Date.parse(dateOf(row)) - Date.parse(dateOf(target))) <= 20 * 86400000);
    if (near) return near;
    const fiscalYear = target.fiscal_year ?? target.calendar_year;
    const fiscalPeriod = target.fiscal_period ?? target.period;
    if (fiscalYear == null || fiscalPeriod == null) return {};
    return rows.find(row => String(row.fiscal_year ?? row.calendar_year) === String(fiscalYear) && String(row.fiscal_period ?? row.period) === String(fiscalPeriod)) ?? {};
  }

  function fundamentals(sections, period) {
    const income = statement(sections, "income", period);
    const balance = statement(sections, "balance", period);
    const cash = statement(sections, "cash", period);
    // One entry per period: skip a date within 20 days of one already taken (same period, other provider).
    const dates = [];
    for (const row of sorted([...income, ...balance, ...cash])) {
      if (!dates.some(seen => Math.abs(Date.parse(dateOf(seen)) - Date.parse(dateOf(row))) <= 20 * 86400000)) dates.push(row);
    }
    return sorted(dates).map(base => ({
      date: dateOf(base), base, income: align(income, base), balance: align(balance, base), cash: align(cash, base)
    }));
  }

  function metrics(entry, prior, period) {
    const i = entry?.income ?? {}, b = entry?.balance ?? {}, c = entry?.cash ?? {};
    const revenue = read(i, "revenue"), gross = read(i, "gross"), op = read(i, "op"), net = read(i, "net"), pretax = read(i, "pretax"), tax = read(i, "tax");
    // SEC filings have no EBITDA line: use operating income plus depreciation and amortization
    // (income statement first, else the cash-flow add-back).
    const da = read(i, "da") ?? read(c, "da");
    const ebitda = read(i, "ebitda") ?? (op != null && da != null ? op + Math.abs(da) : null);
    const assets = read(b, "assets"), equity = read(b, "equity"), currentAssets = read(b, "currentAssets"), currentLiab = read(b, "currentLiab"), inventory = read(b, "inventory");
    // Total debt when not reported: long-term debt plus whichever short-term parts exist.
    // A missing part is zero (NVDA reports no short_term_debt), but long-term debt is required.
    const debtOf = row => read(row, "debt") ?? (read(row, "longDebt") == null ? null :
      read(row, "longDebt") + (read(row, "shortDebt") ?? 0) + (num(row.current_portion_of_long_term_debt) ?? 0));
    const debt = debtOf(b), cash = read(b, "cash");
    const ocf = read(c, "ocf"), capex = read(c, "capex"), fcf = read(c, "fcf") ?? (capex == null ? null : difference(ocf, Math.abs(capex)));
    const shares = read(i, "shares") ?? read(b, "shares");
    const avg = (name, end) => quotient(sum(read(prior?.balance ?? {}, name), end), 2);
    const cost = read(i, "cost"), avgInventory = avg("inventory", inventory);
    const taxRate = quotient(tax, pretax);
    const invested = row => difference(sum(read(row, "equity"), debtOf(row)), read(row, "cash"));
    const avgInvested = quotient(sum(invested(b), invested(prior?.balance ?? {})), 2);
    const avgCapital = quotient(sum(difference(assets, currentLiab), difference(read(prior?.balance ?? {}, "assets"), read(prior?.balance ?? {}, "currentLiab"))), 2);
    const fullYear = period !== "quarterly";
    return {
      revenue, gross, op, pretax, net, ebitda, tax, assets, equity, debt, cash, shares, eps: read(i, "eps"), ocf, capex, fcf,
      revenue_per_share: quotient(revenue, shares), book_per_share: quotient(equity, shares), free_cash_flow_per_share: quotient(fcf, shares),
      gross_margin: quotient(gross, revenue), operating_margin: quotient(op, revenue), pretax_margin: quotient(pretax, revenue), net_margin: quotient(net, revenue), ebitda_margin: quotient(ebitda, revenue), fcf_margin: quotient(fcf, revenue),
      current_ratio: quotient(currentAssets, currentLiab), quick_ratio: quotient(difference(currentAssets, inventory), currentLiab), cash_ratio: quotient(cash, currentLiab),
      working_capital: difference(currentAssets, currentLiab), net_debt: difference(debt, cash), debt_to_equity: equity > 0 ? quotient(debt, equity) : null,
      debt_to_assets: assets > 0 ? quotient(debt, assets) : null, debt_to_ebitda: fullYear && ebitda > 0 ? quotient(debt, ebitda) : null,
      return_on_equity: fullYear && avg("equity", equity) > 0 ? quotient(net, avg("equity", equity)) : null,
      return_on_assets: fullYear && avg("assets", assets) > 0 ? quotient(net, avg("assets", assets)) : null,
      return_on_invested_capital: fullYear && avgInvested > 0 && taxRate != null && taxRate >= 0 && taxRate <= 1 && op != null ? op * (1 - taxRate) / avgInvested : null,
      return_on_capital_employed: fullYear && avgCapital > 0 ? quotient(op, avgCapital) : null,
      asset_turnover: fullYear && avg("assets", assets) > 0 ? quotient(revenue, avg("assets", assets)) : null,
      inventory_turnover: fullYear && avgInventory > 0 && cost != null ? Math.abs(cost) / avgInventory : null,
      effective_tax_rate: taxRate,
      interest_coverage: read(i, "interest") ? quotient(op, Math.abs(read(i, "interest"))) : null,
      dps: read(i, "dps"), dividends_paid: read(c, "divs")
    };
  }

  const ratioDefinitions = {
    "Profitability": [["Gross margin", "gross_margin", "pct", "gross_profit_margin"], ["Operating margin", "operating_margin", "pct", "operating_profit_margin"], ["Pretax margin", "pretax_margin", "pct", "pretax_profit_margin"], ["Net margin", "net_margin", "pct", "net_profit_margin"], ["EBITDA margin", "ebitda_margin", "pct"], ["Free cash flow margin", "fcf_margin", "pct"], ["Return on equity", "return_on_equity", "pct", "roe"], ["Return on assets", "return_on_assets", "pct", "roa"], ["Return on invested capital", "return_on_invested_capital", "pct", "roic"], ["Return on capital employed", "return_on_capital_employed", "pct", "roce"]],
    "Liquidity": [["Current ratio", "current_ratio", "multiple"], ["Quick ratio", "quick_ratio", "multiple"], ["Cash ratio", "cash_ratio", "multiple"], ["Working capital", "working_capital"]],
    "Credit & Debt": [["Debt / Equity", "debt_to_equity", "multiple", "debt_equity_ratio"], ["Debt / Assets", "debt_to_assets", "multiple", "debt_ratio"], ["Debt / EBITDA", "debt_to_ebitda", "multiple"], ["Interest coverage", "interest_coverage", "multiple", "interest_coverage_ratio"], ["Net debt", "net_debt"]],
    "Working Capital & Efficiency": [["Asset turnover", "asset_turnover", "multiple"], ["Inventory turnover", "inventory_turnover", "multiple"], ["Receivables turnover", "receivables_turnover", "multiple"], ["Payables turnover", "payables_turnover", "multiple"], ["Cash conversion cycle", "cash_conversion_cycle"]],
    "Valuation & Yield": [["P/E", "pe_ratio", "multiple", "price_to_earnings_ratio", "price_earnings_ratio"], ["P/S", "price_to_sales_ratio", "multiple", "price_sales_ratio"], ["P/B", "price_to_book_ratio", "multiple", "price_book_value_ratio"], ["EV / EBITDA", "enterprise_value_to_ebitda", "multiple", "ev_to_ebitda", "enterprise_value_multiple"], ["Dividend yield", "dividend_yield", "pct"], ["Free cash flow yield", "free_cash_flow_yield", "pct"], ["Dividend payout ratio", "dividend_payout_ratio", "pct", "payout_ratio"]]
  };

  // ---------- Valuation history ----------
  // Multiples at each period end: the close on (or up to 10 days before) the period end, over that
  // period's figures. Prices are split-adjusted and statements are restated to the current share
  // basis by the backend, so per-share figures line up.
  function priceSeries(sections) {
    const source = ["chart_history", "returns", "history"].map(name => records(sections, name)).find(rows => rows.length) ?? [];
    return cleanRows(source).map(row => ({ date: dateOf(row), close: num(row.close) })).filter(point => point.close > 0);
  }

  function closeOn(prices, end) {
    let low = 0, high = prices.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (prices[middle].date <= end) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    if (found < 0 || Date.parse(end) - Date.parse(prices[found].date) > 10 * 86400000) return null;
    return prices[found].close;
  }

  function dividendsInYear(sections, end) {
    const stop = Date.parse(end), start = stop - 365 * 86400000;
    const amounts = records(sections, "dividends").filter(row => { const at = Date.parse(eventDate(row)); return at > start && at <= stop; })
      .map(row => num(field(row, "amount", "dividend", "dividend_per_share", "dividends")));
    return amounts.length && amounts.every(value => value != null) ? amounts.reduce((a, b) => a + b, 0) : null;
  }

  // Valuations need the price and the statements in one currency and on one share basis.
  function valuationCheck(sections, ctx) {
    const quoteCurrency = String(ctx.quoteCurrency || latest(records(sections, "quote")).currency || "").toUpperCase();
    const reporting = String(ctx.currency || "").toUpperCase();
    if (!reporting) return { ok: false, reason: "The reporting currency is unknown, so prices cannot be compared with the statements." };
    if (quoteCurrency && quoteCurrency !== reporting) return { ok: false, reason: `Prices are in ${quoteCurrency} and statements in ${reporting}, so historical multiples are not calculated.` };
    const bases = ["annual", "quarterly"].map(period => section(sections, "income", period).metadata?.split_adjustment?.basis).filter(Boolean);
    const lastSplit = orderedEvents(records(sections, "splits"))[0];
    // If restatement could not be confirmed, only periods after the latest split are comparable.
    const after = bases.some(basis => basis !== "current") && lastSplit ? eventDate(lastSplit) : null;
    return { ok: true, after, note: after ? `Periods before the ${dateLabel(after)} split are omitted because their per-share figures could not be restated.` : "" };
  }

  function valuationAt(entry, price, sections) {
    if (!(price > 0) || !entry) return {};
    const m = metrics(entry, null, "annual");
    // When reported EPS is missing (e.g. a blanked quarter), estimate it as net income / average shares.
    if (m.eps == null && m.net != null && m.shares > 0) m.eps = m.net / m.shares;
    const mcap = m.shares > 0 ? price * m.shares : null;
    const ev = mcap != null && m.debt != null && m.cash != null ? mcap + m.debt - m.cash : null;
    const dps = m.dps ?? dividendsInYear(sections, entry.date);
    return {
      price, market_cap: mcap,
      pe_ratio: m.eps > 0 ? price / m.eps : null,
      price_to_sales_ratio: mcap != null && m.revenue > 0 ? mcap / m.revenue : null,
      price_to_book_ratio: mcap != null && m.equity > 0 ? mcap / m.equity : null,
      enterprise_value_to_ebitda: ev != null && m.ebitda > 0 ? ev / m.ebitda : null,
      dividend_yield: dps != null ? dps / price : null,
      free_cash_flow_yield: mcap != null && m.fcf != null ? m.fcf / mcap : null,
      dividend_payout_ratio: dps != null && m.eps > 0 ? dps / m.eps : null
    };
  }

  // Map of period end -> valuation multiples, using TTM figures for quarterly and TTM views.
  function valuationByDate(sections, ctx, period) {
    const check = valuationCheck(sections, ctx);
    const prices = priceSeries(sections);
    if (!check.ok || !prices.length) return new Map();
    const entries = fundamentals(sections, period === "annual" ? "annual" : "ttm");
    return new Map(entries.filter(entry => !check.after || entry.date >= check.after)
      .map(entry => [entry.date, valuationAt(entry, closeOn(prices, entry.date), sections)]));
  }

  const valuationMetrics = [
    ["P/E", "pe_ratio", "multiple"], ["P/S", "price_to_sales_ratio", "multiple"], ["P/B", "price_to_book_ratio", "multiple"],
    ["EV / EBITDA", "enterprise_value_to_ebitda", "multiple"], ["Dividend yield", "dividend_yield", "pct"], ["Free cash flow yield", "free_cash_flow_yield", "pct"]
  ];

  function valuationHistory(sections, ctx) {
    const title = "Valuation history";
    const check = valuationCheck(sections, ctx);
    const sources = [sections.chart_history ?? sections.history, section(sections, "income", "quarterly"), section(sections, "income", "annual")];
    if (!check.ok) return panel(title, empty(check.reason), { sources });
    const prices = priceSeries(sections);
    if (!prices.length) return panel(title, empty("Price history is needed to value past periods.", sections.chart_history), { sources });
    // Prefer rolling TTM points (one per quarter); fall back to fiscal years when quarters are few.
    let basis = "TTM", entries = fundamentals(sections, "ttm").filter(entry => read(entry.income, "revenue") != null || read(entry.income, "eps") != null);
    const annual = fundamentals(sections, "annual").filter(entry => read(entry.income, "revenue") != null || read(entry.income, "eps") != null);
    if (entries.length < 8 && annual.length > entries.length) { basis = "FY"; entries = annual; }
    entries = entries.filter(entry => !check.after || entry.date >= check.after);
    const points = entries.map(entry => ({ date: entry.date, ...valuationAt(entry, closeOn(prices, entry.date), sections) })).filter(point => point.price);
    if (!points.length) return panel(title, empty("No period ends overlap the available price history.", sections.chart_history), { sources });
    const quotePrice = read(latest(records(sections, "quote")), "price");
    const current = valuationAt(entries.at(-1), quotePrice ?? prices.at(-1).close, sections);
    const lastDate = points.at(-1).date;
    const fiveYears = points.filter(point => Date.parse(lastDate) - Date.parse(point.date) < 5 * 365.25 * 86400000);
    const statsOf = key => {
      const values = fiveYears.map(point => point[key]).filter(value => Number.isFinite(value)).sort((a, b) => a - b);
      if (!values.length) return {};
      const middle = values.length >> 1;
      return { average: values.reduce((a, b) => a + b, 0) / values.length, median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
        low: values[0], high: values.at(-1), count: values.length };
    };
    const versus = (now, average) => {
      if (!Number.isFinite(now) || !(average > 0)) return "—";
      const change = now / average - 1;
      return Math.abs(change) < 0.005 ? "In line" : `${plain.format(Math.abs(change) * 100)}% ${change > 0 ? "above" : "below"}`;
    };
    const rows = valuationMetrics.map(([label, key, type]) => {
      const s = statsOf(key);
      return [label, number(current[key], type), number(s.average, type), number(s.median, type), number(s.low, type), number(s.high, type), versus(current[key], s.average)];
    });
    const span = fiveYears.length ? `${dateLabel(fiveYears[0].date)} to ${dateLabel(lastDate)}` : "";
    const summary = table(["Metric", "Current", "5Y average", "5Y median", "5Y low", "5Y high", "Current vs average"], rows, "Valuation history");
    // Charts show ten years so the five-year average line stays readable; sources sit on the summary only.
    const tenYears = points.filter(point => Date.parse(lastDate) - Date.parse(point.date) < 10 * 365.25 * 86400000);
    const chartOf = (label, key, type) => {
      const s = statsOf(key);
      const series = [{ label: `${label} (${basis})`, points: tenYears.map(point => ({ x: point.date, y: Number.isFinite(point[key]) ? point[key] : null })) }];
      if (s.average != null) series.push({ label: "5Y average", points: [{ x: fiveYears[0].date, y: s.average }, { x: lastDate, y: s.average }] });
      return panel(`${label} over time`, graph(series, { type, height: 210 }), { meta: basis === "TTM" ? "Quarter ends, trailing twelve months" : "Fiscal year ends" });
    };
    const notes = [
      `Each point uses the closing price at the period end over ${basis === "TTM" ? "trailing twelve-month" : "fiscal-year"} results. "Current" uses the latest price with the latest ${basis} results.`,
      "Averages cover the last five years of points; P/E excludes loss-making periods.", check.note
    ].filter(Boolean).join(" ");
    return panel(title, summary, { meta: span, sources }) +
      `<div class="detail-grid">${chartOf("P/E", "pe_ratio", "multiple")}${chartOf("EV / EBITDA", "enterprise_value_to_ebitda", "multiple")}</div>` +
      `<div class="detail-grid">${chartOf("P/S", "price_to_sales_ratio", "multiple")}${chartOf("Free cash flow yield", "free_cash_flow_yield", "pct")}</div>` +
      `<p class="section-meta">${esc(notes)}</p>`;
  }

  function ratioPanel(sections, ctx) {
    const period = kind(ctx);
    const statements = fundamentals(sections, period);
    const provider = cleanRows(period === "ttm" ? unwrap(sections.ratios?.data?.ttm) : records(sections, "ratios", period));
    const reported = new Map(provider.map(row => [dateOf(row), row]));
    const valuations = valuationByDate(sections, ctx, period);
    const calculated = new Map(statements.map((item, index) => {
      const prior = priorPeriod(statements.map(entry => entry.base), index, period);
      // Statement ratios plus price-based multiples at the same period end (TTM-based for quarters).
      return [item.date, { ...metrics(item, statements.find(entry => entry.date === dateOf(prior)), period), ...(valuations.get(item.date) ?? {}) }];
    }));
    const allDates = [...new Set([...reported.keys(), ...calculated.keys()])].sort();
    const dates = allDates.slice(-((Number(ctx.years) || 15) * (period === "annual" ? 1 : 4)));
    const sourcePeriod = period === "ttm" ? "quarterly" : period;
    const sources = ["ratios", "income", "balance", "cash"].map(name => section(sections, name, sourcePeriod));
    if (!dates.length) return panel("Financial ratios", empty("No reported ratios or comparable financial statements are available for this period.", sources[0]), { sources });
    const headers = ["Metric", ...dates.map(end => periodLabel(reported.get(end) ?? { date: end }, period))];
    const ratioValue = (end, key, type, alias) => {
      const report = reported.get(end) || {};
      const percent = type === "pct" ? num(field(report, [key, ...alias].map(name => `${name}_percent`))) : null;
      if (percent != null) return percent / 100;
      return num(field(report, [key, ...alias])) ?? calculated.get(end)?.[key] ?? null;
    };
    const dateRows = allDates.map(date => ({ date }));
    const display = (end, key, type, alias) => {
      const value = ratioValue(end, key, type, alias);
      if (!ctx.yoy) return number(value, type, ctx);
      const previous = priorPeriod(dateRows, allDates.indexOf(end));
      const base = previous ? ratioValue(previous.date, key, type, alias) : null;
      return number(base > 0 ? quotient(difference(value, base), base) : null, "pct");
    };
    const blocks = Object.entries(ratioDefinitions).map(([group, defs]) => {
      const rows = defs.map(([label, key, type, ...alias]) => [label, ...dates.map(end => display(end, key, type, alias))]);
      return panel(group, table(headers, rows, group, true), { meta: `${dates.length} periods${ctx.yoy ? " · YoY" : ""}`, sources });
    });
    const recognized = new Set(Object.values(ratioDefinitions).flatMap(group => group.flatMap(([, key, , ...alias]) => [key, ...alias].flatMap(name => [name, `${name}_percent`]))));
    const extras = fieldRows(provider, []).filter(key => !recognized.has(key));
    if (extras.length) blocks.push(panel("Additional reported ratios", table(headers, extras.map(key => [human(key), ...dates.map(end => display(end, key, "price", []))]), "Additional reported ratios", true), { sources: [sources[0]] }));
    return `${blocks.join("")}<p class="section-meta">Provider ratios take precedence. When calculated from statements, annual and TTM returns use average opening and closing balances. ROIC uses after-tax operating income over average debt plus equity less cash. The calculated quick ratio subtracts inventory from current assets. When EBITDA is not reported, it is operating income plus depreciation and amortization. Valuation multiples use the closing price at each period end; quarterly columns use trailing twelve-month results.</p>`;
  }

  function graph(series, { kind: style = "line", type = "price", height = 250, log = false } = {}) {
    const available = series.filter(item => item.points.some(point => point.y != null));
    if (!available.length) return empty("No comparable data to chart.");
    const points = available.flatMap(item => item.points).filter(point => point.y != null);
    const xs = points.map(point => Date.parse(point.x)).filter(Number.isFinite);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    if (!Number.isFinite(minX)) return empty("The provider did not return dates for this series.");
    const rawLow = Math.min(...points.map(point => point.y));
    const rawHigh = Math.max(...points.map(point => point.y));
    const logarithmic = log && rawLow > 0 && style !== "bar";
    const transform = logarithmic ? Math.log : value => value;
    const invert = logarithmic ? Math.exp : value => value;
    const scaledLow = transform(rawLow), scaledHigh = transform(rawHigh);
    const spread = scaledHigh - scaledLow || Math.max(Math.abs(scaledHigh) * 0.2, 1);
    const low = style === "bar" ? Math.min(0, scaledLow - (scaledLow < 0 ? spread * 0.06 : 0)) : scaledLow - spread * 0.09;
    const high = style === "bar" ? Math.max(0, scaledHigh + (scaledHigh > 0 ? spread * 0.06 : 0)) : scaledHigh + spread * 0.09;
    const width = 800, left = 66, right = 28, top = 15, bottom = 34;
    const area = width - left - right, tall = height - top - bottom;
    const x = value => left + (minX === maxX ? 0.5 : (Date.parse(value) - minX) / (maxX - minX)) * area;
    const y = value => top + tall * (1 - (transform(value) - low) / (high - low || 1));
    const priceLabel = n => number(n, type);
    const grid = Array.from({ length: 5 }, (_, i) => {
      const at = top + i * tall / 4;
      return `<line x1="${left}" x2="${width - right}" y1="${at}" y2="${at}" stroke="currentColor" opacity=".11"/><text x="${left - 12}" y="${at + 4}" text-anchor="end">${esc(priceLabel(invert(high - i * (high - low) / 4)))}</text>`;
    }).join("");
    const dates = Array.from({ length: minX === maxX ? 1 : 5 }, (_, i) => {
      const d = new Date(minX + i * (maxX - minX) / 4).toISOString().slice(0, 10);
      return `<text x="${x(d)}" y="${height - 10}" text-anchor="${i === 0 && minX !== maxX ? "start" : i === 4 ? "end" : "middle"}">${dateLabel(d)}</text>`;
    }).join("");
    const palette = ["#0f8a72", "#3478d5", "#9c5cc7", "#e09932"];
    const plots = available.map((item, i) => {
      const color = palette[i % palette.length];
      const source = item.points.filter(point => Number.isFinite(Date.parse(point.x)));
      const sampled = source.length > 750 ? source.filter((_, index) => index % Math.ceil(source.length / 750) === 0 || index === source.length - 1) : source;
      if (style === "bar") {
        const barWidth = Math.max(1, Math.min(27, area / Math.max(1, sampled.length) * 0.54 / available.length));
        return sampled.filter(point => point.y != null).map(point => `<rect x="${x(point.x) + (i - available.length / 2) * barWidth}" y="${Math.min(y(0), y(point.y))}" width="${barWidth}" height="${Math.abs(y(0) - y(point.y))}" fill="${color}" rx="1"><title>${esc(`${item.label} · ${dateLabel(point.x)} · ${priceLabel(point.y)}`)}</title></rect>`).join("");
      }
      let starts = true;
      const path = sampled.map(point => {
        if (point.y == null) { starts = true; return ""; }
        const command = starts ? "M" : "L";
        starts = false;
        return `${command}${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`;
      }).join(" ");
      const show = sampled.length <= 38;
      const markers = sampled.filter(point => point.y != null).map(point => `<circle cx="${x(point.x)}" cy="${y(point.y)}" r="${show ? 3 : 5}" fill="${color}"${show ? "" : ' fill-opacity="0"'}><title>${esc(`${item.label} · ${dateLabel(point.x)} · ${priceLabel(point.y)}`)}</title></circle>`).join("");
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>${markers}`;
    }).join("");
    const labels = available.map((item, i) => `<span style="--series-color:${palette[i % palette.length]}"><i aria-hidden="true"></i>${esc(item.label)}</span>`).join("");
    return `<figure class="chart-figure"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(available.map(item => item.label).join(", "))}" font-family="inherit" font-size="11" fill="currentColor">${grid}${dates}${plots}</svg><figcaption class="detail-chart-legend">${labels}${logarithmic ? "<span>Log scale</span>" : ""}</figcaption></figure>`;
  }

  function charts(sections, ctx) {
    const chartHistory = records(sections, "chart_history");
    const fullHistory = cleanRows(chartHistory.length ? chartHistory : records(sections, "history"));
    const cutoff = new Date(`${dateOf(fullHistory.at(-1))}T00:00:00Z`);
    if (Number(ctx.years) > 0) cutoff.setUTCFullYear(cutoff.getUTCFullYear() - Number(ctx.years));
    const price = fullHistory.filter(row => Number.isNaN(cutoff.valueOf()) || Date.parse(dateOf(row)) >= cutoff.valueOf());
    const period = "annual";
    const entries = fundamentals(sections, period).slice(-((Number(ctx.years) || 15) * (period === "annual" ? 1 : 4)));
    const metricRows = entries.map((item, index) => ({ date: item.date, ...metrics(item, entries.find(entry => entry.base === priorPeriod(entries.map(row => row.base), index, period)), period) }));
    metricRows.forEach((row, index) => {
      const prior = priorPeriod(metricRows, index, period);
      row.revenue_growth = prior?.revenue > 0 ? quotient(difference(row.revenue, prior.revenue), prior.revenue) : null;
      row.eps_growth = prior?.eps > 0 ? quotient(difference(row.eps, prior.eps), prior.eps) : null;
      row.payout = row.eps > 0 ? quotient(row.dps, row.eps) : null;
      row.net_debt = difference(row.debt, row.cash);
      row.absolute_capex = row.capex == null ? null : Math.abs(row.capex);
      row.low_multiple = row.eps > 0 ? row.eps * 12 : null;
      row.mid_multiple = row.eps > 0 ? row.eps * 15 : null;
      row.high_multiple = row.eps > 0 ? row.eps * 23 : null;
    });
    const timeSeries = (data, metricsList) => metricsList.map(([name, key]) => ({ label: name, points: data.map(row => ({ x: dateOf(row), y: num(row[key]) })) }));
    const priced = (title, list, opts) => panel(title, price.length ? graph(timeSeries(price, list), opts) : empty("No price history returned for this range.", sections.history), { meta: chartHistory.length ? `${ctx.years || "All available"} years` : ctx.range ? String(ctx.range) : ctx.currency, sources: [chartHistory.length ? sections.chart_history : sections.history] });
    const group = (title, list, opts) => panel(title, graph(timeSeries(metricRows, list), opts), { meta: period.toUpperCase(), sources: [sections.income, sections.cash, sections.balance] });
    const dividends = cleanRows(records(sections, "dividends")).slice(-50).map(row => ({ date: dateOf(row), yieldValue: num(field(row, "amount", "dividend", "dividend_per_share", "dividends")) }));
    const customMetrics = {
      revenue: ["Revenue", "number"], eps: ["Earnings per share", "price"], fcf: ["Free cash flow", "number"],
      return_on_invested_capital: ["Return on invested capital", "pct"], net_margin: ["Net margin", "pct"],
      debt: ["Interest-bearing debt", "number"], working_capital: ["Working capital", "number"]
    };
    const custom = customMetrics[ctx.chartMetric];
    return [
      priced("Historical closing price", [[ctx.symbol || "Stock", "close"]], { log: ctx.log }),
      group("Earnings multiple scenarios", [["12 × EPS", "low_multiple"], ["15 × EPS", "mid_multiple"], ["23 × EPS", "high_multiple"]]),
      `<div class="section-meta">Illustrative multiples of reported annual EPS. ${section(sections, "income", "annual").metadata?.split_adjustment?.basis === "current" ? "Per-share figures are restated to the current share basis." : "Historical per-share figures may use different share counts around stock splits."}</div>`,
      `<div class="detail-grid">${priced("Trading volume", [["Volume", "volume"]], { kind: "bar", type: "number" })}${group("Profitability trends", [["Gross", "gross_margin"], ["Operating", "operating_margin"], ["Net", "net_margin"]], { type: "pct" })}</div>`,
      `<div class="detail-grid">${group("Revenue and earnings", [["Revenue", "revenue"], ["Net income", "net"]], { type: "number" })}${group("Cash generation", [["Operating cash flow", "ocf"], ["Free cash flow", "fcf"]], { type: "number" })}</div>`,
      `<div class="detail-grid">${group("Growth rates", [["Revenue YoY", "revenue_growth"], ["EPS YoY", "eps_growth"]], { type: "pct" })}${group("Returns on capital", [["ROIC", "return_on_invested_capital"], ["ROE", "return_on_equity"], ["ROA", "return_on_assets"]], { type: "pct" })}</div>`,
      `<div class="detail-grid">${group("Cash, debt and net debt", [["Cash", "cash"], ["Debt", "debt"], ["Net debt", "net_debt"]], { type: "number" })}${group("Capital expenditure and cash flow", [["Capital expenditure", "absolute_capex"], ["Operating cash flow", "ocf"], ["Free cash flow", "fcf"]], { type: "number" })}</div>`,
      `<div class="detail-grid">${group("Weighted average shares", [["Shares", "shares"]], { type: "number" })}${group("Dividends as a share of EPS", [["Payout ratio", "payout"]], { type: "pct" })}</div>`,
      `<div class="detail-grid">${group("Earnings per share", [["EPS", "eps"]], { kind: "bar" })}${panel("Dividend history", graph(timeSeries(dividends, [["Dividend per share", "yieldValue"]]), { kind: "bar" }), { sources: [sections.dividends] })}</div>`,
      custom ? group(custom[0], [[custom[0], ctx.chartMetric]], { type: custom[1] }) : "",
      `<div hidden>${price.length ? table(["Date", "Open", "High", "Low", "Close", "Volume"], price.map(row => [dateOf(row), ...["open", "high", "low", "close", "volume"].map(key => row[key] ?? "")]), "Price History") : ""}${metricRows.length ? table(["Fiscal Period", "Revenue", "Net Income", "EPS", "OCF", "FCF", "Gross Margin", "Operating Margin", "Net Margin"], metricRows.map(row => [row.date, ...["revenue", "net", "eps", "ocf", "fcf", "gross_margin", "operating_margin", "net_margin"].map(key => row[key] ?? "")]), "Annual Financial Metrics") : ""}</div>`
    ].join("");
  }

  function eventDate(row) {
    return date(field(row, "date", "filing_date", "report_date", "published_date", "published_at", "earnings_date", "calendar_date", "ex_dividend_date", "execution_date", "fiscal_period_ending", "release_date", "accepted_date"));
  }

  function orderedEvents(rows) {
    return [...rows].sort((a, b) => eventDate(b).localeCompare(eventDate(a)));
  }

  function timeline(title, rows, envelope, make, message) {
    if (!rows.length) return panel(title, empty(message, envelope), { sources: [envelope] });
    const groups = new Map();
    for (const row of rows) {
      const year = row.fiscal_year ?? eventDate(row).match(/^\d{4}/)?.[0] ?? "Other periods";
      if (!groups.has(year)) groups.set(year, []);
      groups.get(year).push(row);
    }
    const content = [...groups].map(([year, items]) => `<div class="event-year"><h3>${esc(year)}</h3><div class="document-list">${items.map(make).join("")}</div></div>`).join("");
    return panel(title, content, { meta: `${rows.length} records`, sources: [envelope] });
  }

  function transcriptTab(sections, ctx) {
    const transcripts = orderedEvents(records(sections, "transcripts"));
    const calls = timeline("Earnings Call Transcripts", transcripts, sections.transcripts, row => {
      const fiscal = field(row, "fiscal_period", "quarter", "period");
      const raw = field(row, "transcript", "content", "body", "text");
      const title = field(row, "title", "name") ?? `${ctx.symbol || "Company"} ${fiscal != null ? `${String(fiscal).replace(/^([1-4])$/, "Q$1")} ` : ""}earnings call`;
      const url = field(row, "url", "link", "transcript_url", "source_url");
      const meta = `<time>${esc(dateLabel(eventDate(row)))}</time>`;
      if (typeof raw === "string" && raw.trim()) return `<details class="document-row"><summary>${esc(title)} ${meta}</summary><div class="transcript-body">${esc(raw)}</div></details>`;
      return `<div class="document-row">${link(url, title)}${meta}</div>`;
    }, "No earnings call transcripts are available from the connected provider.");
    const earnings = orderedEvents(records(sections, "earnings"));
    const history = earnings.map(row => [dateLabel(eventDate(row)),
      number(field(row, "eps_actual", "actual_eps", "reported_eps", "eps"), "price"), number(field(row, "eps_estimated", "eps_estimate", "estimated_eps", "estimate"), "price"),
      number(field(row, "surprise_percent", "eps_surprise_percent"), "pct")]);
    return calls + panel("Reported Earnings", history.length ? table(["Report date", "Actual EPS", "Estimated EPS", "Surprise"], history, "Reported Earnings") : empty("No earnings history returned.", sections.earnings), { sources: [sections.earnings] });
  }

  function documents(sections) {
    const rows = orderedEvents(records(sections, "filings"));
    return timeline("Company Documents & Filings", rows, sections.filings, row => {
      const form = field(row, "form_type", "form", "type", "filing_type", "report_type");
      const name = field(row, "title", "description", "filing_title", "primary_doc_description") ?? form ?? "Company filing";
      const url = field(row, "report_url", "filing_url", "url", "final_link", "link", "primary_doc_url", "filing_detail_url", "filing_details_url");
      return `<article class="document-row"><div>${link(url, name)}${form && form !== name ? `<span class="section-meta"> · ${esc(form)}</span>` : ""}</div><time>${esc(dateLabel(eventDate(row)))}</time></article>`;
    }, "No company documents were returned for this listing.");
  }

  function splitRatio(row) {
    const to = num(field(row, "numerator", "split_to", "to_factor", "to", "split_numerator", "new_shares", "split_ratio_numerator"));
    const from = num(field(row, "denominator", "split_from", "from_factor", "from", "split_denominator", "old_shares", "split_ratio_denominator"));
    if (to > 0 && from > 0) return { label: `${to}:${from}`, multiple: to / from };
    const value = field(row, "ratio", "split_ratio", "stock_splits", "split", "split_factor");
    const pair = String(value ?? "").match(/^\s*([\d.]+)\s*[:/]\s*([\d.]+)\s*$/);
    if (pair && Number(pair[1]) > 0 && Number(pair[2]) > 0) return { label: `${pair[1]}:${pair[2]}`, multiple: Number(pair[1]) / Number(pair[2]) };
    const factor = num(value);
    if (factor >= 1) return { label: `${plain.format(factor)}:1`, multiple: factor };
    if (factor > 0) return { label: `1:${plain.format(1 / factor)}`, multiple: factor };
    return { label: "—", multiple: null };
  }

  function splits(sections, ctx) {
    const source = sections.splits;
    const rows = orderedEvents(records(sections, "splits"));
    if (!rows.length) return panel("Stock Split History", empty("No split events were returned for this listing.", source), { sources: [source] });
    const top = rows[0], current = splitRatio(top);
    const move = current.multiple == null ? "" : current.multiple > 1 ? "Forward split" : current.multiple < 1 ? "Reverse split" : "No change";
    const hero = `<div class="split-highlight"><strong>${esc(current.label)}</strong><div>${esc(dateLabel(eventDate(top)))}${move ? `<span> · ${move}</span>` : ""}</div></div>`;
    const history = rows.map(row => {
      const ratio = splitRatio(row);
      return [dateLabel(eventDate(row)), ratio.label, number(field(row, "price_before_split", "before", "price_before", "before_price"), "price"), number(field(row, "price_after_split", "after", "price_after", "after_price"), "price"), ratio.multiple == null ? "—" : ratio.multiple > 1 ? "Forward" : ratio.multiple < 1 ? "Reverse" : "No change"];
    });
    return panel("Latest Stock Split", hero, { sources: [source] }) + panel("Stock Split History", table(["Effective date", "New : old shares", "Price before", "Price after", "Type"], history, "Stock Split History"), { meta: ctx.currency, sources: [source] });
  }

  function periodMetrics(sections, standardPeriod) {
    let period = standardPeriod;
    let entries = fundamentals(sections, period);
    const hasIncome = entries.some(row => read(row.income, "revenue") != null || read(row.income, "net") != null);
    if (!hasIncome && period === "ttm") {
      period = "annual";
      entries = fundamentals(sections, period);
    }
    let entry = entries.at(-1);
    let balanceAsOf = null;
    // If the latest period has no balance sheet (statements from different providers), use the
    // most recent balance sheet within 100 days and report its date.
    if (entry && !Object.keys(entry.balance ?? {}).length) {
      const source = entries.filter(row => Object.keys(row.balance ?? {}).length && row.date <= entry.date &&
        Date.parse(entry.date) - Date.parse(row.date) <= 100 * 86400000).at(-1);
      if (source) {
        entry = { ...entry, balance: source.balance };
        balanceAsOf = source.date;
      }
    }
    const previous = entry && priorPeriod(entries.map(row => row.base), entries.length - 1, period);
    const prior = entries.find(row => row.base === previous);
    return { metrics: metrics(entry, prior, period), entry, period, balanceAsOf };
  }

  function statistics(sections, ctx) {
    const snapshot = periodMetrics(sections, "ttm");
    const m = snapshot.metrics;
    const q = latest(records(sections, "quote"));
    const p = latest(records(sections, "profile"));
    const sourceMetrics = latest(records(sections, "metrics", "annual"));
    const sourceRatios = latest(records(sections, "ratios", "annual"));
    const mark = (row, keys) => num(field(row, keys));
    const rp = key => mark(sourceRatios, [key]);
    const marketCap = read(q, "mcap") ?? read(p, "mcap");
    const price = read(q, "price");
    const enterpriseValue = read(q, "ev") ?? read(p, "ev") ?? sum(marketCap, m.net_debt);
    const longHistory = records(sections, "returns");
    const hist = cleanRows(longHistory.length ? longHistory : records(sections, "history")).filter(row => num(row.close) != null);
    const asOf = hist.at(-1);
    const start52 = asOf && hist.filter(row => Date.parse(dateOf(row)) <= Date.parse(dateOf(asOf)) - 364 * 86400000).at(-1);
    const oneYear = start52 && quotient(difference(num(asOf.close), num(start52.close)), num(start52.close));
    const mean = days => hist.length >= days ? hist.slice(-days).reduce((value, row) => value + num(row.close), 0) / days : null;
    const now = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); // US exchange date
    const future = records(sections, "earnings_calendar").filter(row => eventDate(row) >= now).sort((a, b) => eventDate(a).localeCompare(eventDate(b)))[0];
    const lastSplit = orderedEvents(records(sections, "splits"))[0];
    const employees = mark(p, ["employees", "full_time_employees", "full_time_employee_count"]);
    const dividends = orderedEvents(records(sections, "dividends"));
    const knownAmounts = dividends.filter(row => eventDate(row) <= now && Date.parse(eventDate(row)) > Date.parse(now) - 365 * 86400000).map(row => num(field(row, "amount", "dividend", "dividend_per_share", "dividends")));
    const currencyCodes = new Set([ctx.currency, q.currency, p.currency, sourceMetrics.currency, snapshot.entry?.income?.reported_currency, snapshot.entry?.income?.currency, snapshot.entry?.cash?.reported_currency, snapshot.entry?.cash?.currency].filter(Boolean).map(code => String(code).toUpperCase()));
    // Blank market-to-statement ratios when currencies differ or the reporting currency is unknown.
    const currencyUnknown = !ctx.currency;
    const crossCurrency = currencyCodes.size > 1 || currencyUnknown;
    // Dividend history is paid in the listing's (price's) currency; statement DPS is in the
    // reporting currency. Across currencies only the history can be divided by the price.
    const paidLastYear = knownAmounts.length && knownAmounts.every(value => value != null) ? knownAmounts.reduce((a, b) => a + b, 0) : null;
    const dividendYear = crossCurrency ? paidLastYear : m.dps ?? paidLastYear;
    const value = (a, b) => b > 0 ? quotient(a, b) : null;
    const fiscal = snapshot.entry ? `${snapshot.period === "ttm" ? "TTM" : "FY"} · ${dateLabel(snapshot.entry.date)}${snapshot.balanceAsOf ? ` · balance sheet ${dateLabel(snapshot.balanceAsOf)}` : ""}` : "";
    const blocks = [
      ["Total Valuation", [["Market capitalization", marketCap], ["Enterprise value", enterpriseValue]], [sections.quote, sections.profile, sections.balance]],
      ["Important Dates", [["Next earnings", future ? dateLabel(eventDate(future)) : field(p, "earnings_date", "next_earnings_date"), "text"]], [sections.earnings_calendar]],
      ["Share Statistics", [["Shares outstanding", mark(q, ["shares_outstanding"]) ?? mark(p, ["shares_outstanding"]) ?? read(snapshot.entry?.balance ?? {}, "shares")], ["Float", mark(p, ["float_shares", "shares_float"])], ["Beta", mark(p, ["beta"]) ?? mark(q, ["beta"]), "price"]], [sections.quote, sections.profile, sections.balance]],
      ["Valuation Ratios", [["P/E", read(q, "pe") ?? read(p, "pe") ?? value(price, m.eps), "multiple"], ["P/S", value(marketCap, m.revenue), "multiple"], ["P/B", value(marketCap, m.equity), "multiple"], ["P/FCF", value(marketCap, m.fcf), "multiple"], ["P/OCF", value(marketCap, m.ocf), "multiple"], ["EV / EBITDA", value(enterpriseValue, m.ebitda), "multiple"], ["EV / Sales", value(enterpriseValue, m.revenue), "multiple"]], [sections.quote, sections.profile, sections.income, sections.balance, sections.cash]],
      ["Financial Position", [["Current ratio", m.current_ratio, "multiple"], ["Quick ratio", m.quick_ratio, "multiple"], ["Debt / Equity", m.debt_to_equity, "multiple"], ["Debt / EBITDA", m.debt_to_ebitda, "multiple"]], [sections.income, sections.balance]],
      ["Financial Efficiency", [["Return on equity", m.return_on_equity, "pct"], ["Return on assets", m.return_on_assets, "pct"], ["Return on invested capital", m.return_on_invested_capital, "pct"], ["Return on capital employed", m.return_on_capital_employed, "pct"], ["Revenue per employee", quotient(m.revenue, employees)], ["Employees", employees], ["Inventory turnover", m.inventory_turnover, "multiple"]], [sections.income, sections.balance, sections.profile]],
      ["Taxes", [["Income tax", m.tax], ["Effective tax rate", m.effective_tax_rate, "pct"]], [sections.income]],
      ["Stock Price Statistics", [["52-week closing price change", oneYear, "pct"], ["50-session moving average", mean(50), "price"], ["200-session moving average", mean(200), "price"], ["52-week high", mark(q, ["year_high", "fifty_two_week_high", "week_52_high"]), "price"], ["52-week low", mark(q, ["year_low", "fifty_two_week_low", "week_52_low"]), "price"]], [longHistory.length ? sections.returns : sections.history, sections.quote]],
      ["Income Statement", [["Revenue", m.revenue], ["Gross profit", m.gross], ["Operating income", m.op], ["Pretax income", m.pretax], ["Net income", m.net], ["EBITDA", m.ebitda], ["EPS", m.eps, "price"]], [sections.income]],
      ["Balance Sheet", [["Cash and equivalents", m.cash], ["Total debt", m.debt], ["Net debt", m.net_debt], ["Equity", m.equity], ["Book value per share", m.book_per_share, "price"], ["Working capital", m.working_capital]], [sections.balance]],
      ["Cash Flow", [["Operating cash flow", m.ocf], ["Capital expenditures", m.capex], ["Free cash flow", m.fcf], ["FCF per share", m.free_cash_flow_per_share, "price"]], [sections.cash]],
      ["Margins", [["Gross margin", m.gross_margin, "pct"], ["Operating margin", m.operating_margin, "pct"], ["Pretax margin", m.pretax_margin, "pct"], ["Net margin", m.net_margin, "pct"], ["EBITDA margin", m.ebitda_margin, "pct"]], [sections.income]],
      ["Dividends & Yields", [["Annual-period dividend per share", dividendYear, "price"], ["Dividend yield", value(dividendYear, price), "pct"], ["Payout ratio", value(dividendYear, m.eps), "pct"], ["Shareholder yield (provider)", rp("shareholder_yield"), "pct"], ["Free cash flow yield", value(m.fcf, marketCap), "pct"]], [sections.dividends, sections.ratios, sections.cash]],
      ["Stock Splits", [["Latest split date", lastSplit ? dateLabel(eventDate(lastSplit)) : null, "text"], ["Split ratio", lastSplit ? splitRatio(lastSplit).label : null, "text"]], [sections.splits]],
      ["Scores", [["Altman Z-Score (provider)", mark(sourceMetrics, ["altman_z_score", "altman_zscore"]) ?? rp("altman_z_score"), "price"], ["Piotroski F-Score (provider)", mark(sourceMetrics, ["piotroski_score", "piotroski_f_score"]), "price"]], [sections.metrics, sections.ratios]]
    ];
    if (crossCurrency) {
      for (const title of ["Total Valuation", "Valuation Ratios", "Dividends & Yields"]) {
        const block = blocks.find(item => item[0] === title);
        for (const item of block[1]) {
          if (["Enterprise value", "P/E", "P/S", "P/B", "P/FCF", "P/OCF", "EV / EBITDA", "EV / Sales", "Free cash flow yield", "Payout ratio"].includes(item[0])) item[1] = null;
        }
      }
    }
    const currentPeriod = snapshot.period === "ttm" ? "quarterly" : "annual";
    const normalizedSources = ["income", "balance", "cash"].map(key => section(sections, key, currentPeriod));
    const cards = blocks.map(([title, values, sources]) => panel(title, `<dl class="stat-list">${values.map(([label, val, type]) => `<div><dt>${esc(label)}</dt><dd>${type === "text" ? text(val) : esc(number(val, type, { format: "compact" }))}</dd></div>`).join("")}</dl>`, { meta: ["Important Dates", "Total Valuation", "Stock Splits"].includes(title) ? "" : title === "Stock Price Statistics" && asOf ? dateLabel(dateOf(asOf)) : fiscal, sources: sources.filter(Boolean).length ? sources : normalizedSources }));
    const extra = [
      ["estimates", "Analyst EPS Estimates"], ["revenue_estimates", "Analyst Revenue Estimates"],
      ["targets", "Analyst Price Targets"], ["recommendations", "Analyst Recommendations"],
      ["holders", "Institutional Holdings"], ["insiders", "Insider Transactions"], ["segments", "Reported Revenue Segments"]
    ].filter(([key]) => sections[key]).map(([key, name]) => extraData(sections, key, name));
    const currencyNote = currencyUnknown ? "The reporting currency is unknown. Ratios that combine market and statement values are left blank." :
      currencyCodes.size > 1 ? "Market and reported currencies differ. Cross-currency estimates are left blank." : "";
    return `${currencyNote ? `<p class="section-meta">${esc(currencyNote)}</p>` : ""}<div class="detail-grid statistics-grid">${cards.join("")}</div>${extra.join("")}`;
  }

  function extraData(sections, key, name) {
    const envelope = sections[key];
    const rows = records(sections, key).slice(0, 45);
    if (!rows.length) return panel(name, empty("No records returned by the connected provider.", envelope), { sources: [envelope] });
    const keys = [...new Set(rows.flatMap(Object.keys))].filter(key => {
      return !["symbol", "provider", "source", "id"].includes(key) && rows.some(row => {
        const val = row[key];
        return val != null && ["string", "number", "boolean"].includes(typeof val) && String(val).length < 180;
      });
    });
    if (!keys.length) return panel(name, empty("The provider returned nested data for this dataset."), { sources: [envelope] });
    const display = (value, key) => typeof value === "number" ? number(value, /yield|percent|margin|^growth$/.test(key) ? "pct" : null) : String(value ?? "—");
    return panel(name, table(keys.map(human), rows.map(row => keys.map(key => display(row[key], key))), name), { meta: `${rows.length} displayed`, sources: [envelope] });
  }

  const classicData = [
    ["Revenue per share", "revenue_per_share", "price"], ["Earnings per share", "eps", "price"], ["Free cash flow per share", "free_cash_flow_per_share", "price"], ["Dividend per share", "dps", "price"], ["Book value per share", "book_per_share", "price"], ["Weighted shares", "shares"], ["Revenue", "revenue"], ["Operating margin", "operating_margin", "pct"], ["Net income", "net"], ["Effective tax rate", "effective_tax_rate", "pct"], ["Profit margin", "net_margin", "pct"], ["Working capital", "working_capital"], ["Total debt", "debt"], ["Shareholder equity", "equity"], ["Return on invested capital", "return_on_invested_capital", "pct"], ["Return on capital employed", "return_on_capital_employed", "pct"], ["Return on equity", "return_on_equity", "pct"]
  ];

  function classic(sections, ctx) {
    const yearEntries = fundamentals(sections, "annual");
    const view = yearEntries.slice(-(Number(ctx.years) || 16));
    const snapshot = periodMetrics(sections, "ttm");
    const includeTTM = snapshot.period === "ttm" && snapshot.entry != null;
    // When the statements carry no dividends per share, total the dividend history's ex-dates
    // in the year ending at the period end, as the Summary tab does.
    const dividendRows = records(sections, "dividends");
    const paidInYear = end => {
      const stop = Date.parse(end), start = stop - 365 * 86400000;
      const amounts = dividendRows.filter(row => { const at = Date.parse(eventDate(row)); return at > start && at <= stop; })
        .map(row => num(field(row, "amount", "dividend", "dividend_per_share", "dividends")));
      return amounts.length && amounts.every(value => value != null) ? amounts.reduce((a, b) => a + b, 0) : null;
    };
    const facts = view.map(item => {
      const prior = priorPeriod(yearEntries.map(entry => entry.base), yearEntries.indexOf(item), "annual");
      const row = metrics(item, yearEntries.find(entry => entry.base === prior), "annual");
      return { ...row, dps: row.dps ?? paidInYear(item.date) };
    });
    if (includeTTM) facts.push({ ...snapshot.metrics, dps: snapshot.metrics.dps ?? paidInYear(snapshot.entry.date) });
    const title = "Classic Research Report";
    const p = latest(records(sections, "profile"));
    const q = latest(records(sections, "quote"));
    const price = read(q, "price");
    const intro = `<div class="classic-header"><strong>${text(field(p, "name", "company_name", "long_name") ?? ctx.symbol)}</strong><span>${esc(ctx.symbol || "")} · ${esc(ctx.currency || "")}</span><span>Price ${esc(number(price, "price"))} · P/E ${esc(number(read(q, "pe") ?? read(p, "pe"), "multiple"))}</span></div>`;
    const series = [{ label: `${ctx.symbol || "Stock"} close`, points: cleanRows(records(sections, "history")).map(row => ({ x: dateOf(row), y: num(row.close) })) }];
    const ledger = facts.length ? table(["Metric", ...view.map(row => periodLabel(row.base, "annual")), ...(includeTTM ? ["TTM"] : [])], classicData.map(([name, key, type]) => [name, ...facts.map(row => number(row[key], type, ctx))]), title, true) : empty("No comparable statements returned for this company.");
    const annualSources = ["income", "balance", "cash"].map(name => section(sections, name, "annual"));
    const quarterSources = includeTTM ? ["income", "balance", "cash"].map(name => section(sections, name, "quarterly")) : [];
    return panel(title, intro + graph(series) + ledger, { sources: [sections.quote, sections.history, ...annualSources, ...quarterSources] });
  }

  function csvCell(cell) {
    // Check before trimming: a leading tab or carriage return also starts a formula in spreadsheets.
    let value = cell.replace(/^[ \n]+|\s+$/g, "");
    if (/^[=+@\-\t\r]/.test(value) && !/^[+-]?\d[\d,.]*[%×]?$/.test(value)) value = `'${value}`;
    return `"${value.replaceAll('"', '""')}"`;
  }

  function exportTables(container, filename = "analysis") {
    if (!container) return false;
    const tables = [...container.querySelectorAll("table[data-table-name]")];
    if (!tables.length) return false;
    const csv = tables.map(tableElement => {
      const rows = [...tableElement.rows].filter(row => !row.hidden).map(row => [...row.cells].map(cell => csvCell(cell.textContent)).join(","));
      return [csvCell(tableElement.dataset.tableName), ...rows].join("\r\n");
    }).join("\r\n\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${String(filename).replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/\.csv$/i, "")}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  document.addEventListener("change", event => {
    const checkbox = event.target.closest("input[data-detail-row]");
    if (!checkbox) return;
    const row = checkbox.closest(".panel")?.querySelector(`tr[data-detail-row-id="${checkbox.dataset.detailRow}"]`);
    if (row) row.hidden = !checkbox.checked;
  });

  function render(tab, sections = {}, ctx = {}) {
    switch (tab) {
      case "financials": return ["income", "balance", "cash"].map(name => statementPanel(sections, name, ctx)).join("");
      case "ratios": return valuationHistory(sections, ctx) + ratioPanel(sections, ctx);
      case "transcripts": return transcriptTab(sections, ctx);
      case "documents": return documents(sections);
      case "charts": return charts(sections, ctx);
      case "classic": return classic(sections, ctx);
      case "statistics": return statistics(sections, ctx);
      case "splits": case "stock-splits": return splits(sections, ctx);
      default: return "";
    }
  }

  window.StockDetail = { render, exportTables };
})();
