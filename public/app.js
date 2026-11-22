(() => {
"use strict";

const $ = (value) => document.querySelector(value);
const html = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const value = (row, ...keys) => keys.map((key) => row?.[key]).find((v) => v != null && v !== "");
const number = (v) => v == null || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Number(v);
const amount = (row, ...keys) => number(value(row, ...keys));
const ratio = (a, b) => a == null || b == null || b === 0 ? null : a / b;
const subtract = (a, b) => a == null || b == null ? null : a - b;
const scaled = (n, units = 1) => n == null ? null : n / units;
const textNumber = (v, digits = 2) => number(v) == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(v);
const fixed = (v, digits = 2) => number(v) == null ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
const compact = (v) => v == null ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
const percent = (v) => v == null ? "—" : fixed(v) + "%";
// Same rule as the backend's _symbol(): optional "EXCHANGE:" prefix, then a ticker of letters,
// digits, "." and "-". Index symbols like ^GSPC are not supported by the configured feeds.
const symbolPattern = /^(?:[A-Z0-9][A-Z0-9.-]{0,19}:)?[A-Z0-9][A-Z0-9.-]{0,19}$/;
const tabs = ["summary", "financials", "ratios", "peers", "transcripts", "documents", "charts", "classic", "statistics", "splits"];
const searchInput = $("#search");
function loadSetting(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveSetting(key, setting) {
  try { localStorage.setItem(key, JSON.stringify(setting)); } catch { /* this browser disallows storage */ }
}
const preferences = loadSetting("equity-desk-preferences", {});
const params = new URLSearchParams(location.search);
const initialSymbol = (params.get("symbol") || "AAPL").toUpperCase();
const state = {
  symbol: symbolPattern.test(initialSymbol) ? initialSymbol : "AAPL",
  tab: location.hash.slice(1), range: "1Y", period: "annual", years: 10,
  format: "millions", perShare: false, yoy: false, log: false, compare: false,
  chartMetric: "",
  displayCurrency: "reported", sections: {}, pending: new Map(), generation: 0,
  watch: loadSetting("equity-desk-watchlist", []),
  columns: Array.isArray(preferences.columns) ? preferences.columns : null,
  theme: preferences.theme === "dark" ? "dark" : "light", metricsOpen: false, fiscalQuarter: "", documentPeriod: "",
  chartStyle: preferences.chartStyle === "candles" ? "candles" : "area", ma50: preferences.ma50 === true, ma200: preferences.ma200 === true, chartView: null,
  peerSort: { key: "market_cap", dir: -1 }, peerMessage: ""
};
if (!tabs.includes(state.tab)) state.tab = "summary";

// Fast sections first: requests run six at a time, and SEC statements can take tens of seconds.
const summarySections = ["history", "peers", "income_annual", "balance_annual", "cash_annual", "metrics_annual",
  "income_quarter", "balance_quarter", "cash_quarter", "returns", "benchmark_returns", "ratios_annual",
  "dividends", "news"];
const requirements = {
  summary: summarySections,
  financials: ["income_annual", "cash_annual", "balance_annual", "income_quarter", "cash_quarter", "balance_quarter"],
  ratios: ["ratios_annual", "ratios_quarter", "metrics_annual", "metrics_quarter", "income_annual", "cash_annual", "balance_annual", "income_quarter", "cash_quarter", "balance_quarter",
    "chart_history", "dividends", "splits"],
  transcripts: ["transcripts", "earnings", "earnings_calendar", "filings"],
  documents: ["filings", "earnings"],
  charts: ["history", "chart_history", "income_annual", "cash_annual", "balance_annual", "ratios_annual", "metrics_annual", "dividends"],
  classic: ["history", "income_annual", "cash_annual", "balance_annual", "income_quarter", "cash_quarter", "balance_quarter", "ratios_annual", "dividends"],
  statistics: ["history", "returns", "income_annual", "cash_annual", "balance_annual", "income_quarter", "cash_quarter", "balance_quarter", "ratios_annual", "metrics_annual", "dividends", "splits", "earnings_calendar", "earnings", "estimates", "revenue_estimates", "targets", "recommendations", "holders", "insiders", "segments"],
  splits: ["splits", "history"],
  peers: ["peers"]
};

async function json(path, signal) {
  const response = await fetch(path, { signal });
  const data = await response.json();
  if (!response.ok && !data.error) throw new Error("Request failed.");
  return data;
}
let scheduledRender = 0;
const requestQueue = [];
let activeRequests = 0;
function drainQueue() {
  while (activeRequests < 6 && requestQueue.length) {
    const { controller, run } = requestQueue.shift();
    if (controller.signal.aborted) continue;
    activeRequests += 1;
    run().finally(() => {
      activeRequests -= 1;
      drainQueue();
    });
  }
}
function queueRender() {
  clearTimeout(scheduledRender);
  scheduledRender = setTimeout(render, 55);
}
function load(name) {
  if (state.sections[name] || state.pending.has(name)) return;
  const controller = new AbortController();
  const current = state.generation;
  // "metrics_annual@NVDA" loads a section for another company (the Peers tab) into the same store.
  const [key, otherSymbol] = name.split("@");
  const match = /^(.*)_(annual|quarter)$/.exec(key);
  const section = match ? match[1] : ({ returns: "history", benchmark_returns: "benchmark", chart_history: "history" }[key] || key);
  const period = match?.[2] || "annual";
  const range = key === "chart_history" ? "MAX" : ["returns", "benchmark_returns"].includes(key) ? "5Y" : state.range;
  state.pending.set(name, controller);
  const query = new URLSearchParams({ symbol: otherSymbol || state.symbol, section, period, range });
  if (state.refreshGeneration === current) query.set("refresh", "1");
  const run = () => json("/api/section?" + query, controller.signal).then((result) => {
    if (current === state.generation && !controller.signal.aborted) state.sections[name] = result;
  }).catch(() => {
    if (current === state.generation && !controller.signal.aborted) {
      state.sections[name] = { data: [], error: "Could not reach the dashboard data service." };
    }
  }).finally(() => {
    if (state.pending.get(name) === controller) {
      state.pending.delete(name);
      queueRender();
    }
  });
  requestQueue.push({ controller, run });
  drainQueue();
}
function loadTab() {
  [...new Set(["quote", "profile", "metrics_annual", ...requirements[state.tab], "earnings_calendar"])].forEach(load);
  if (state.tab === "summary" && state.compare) load("benchmark");
  if (state.tab === "peers") peerSymbols().forEach(loadPeer);
}
function setSymbol(symbol, label, refresh = false) {
  symbol = symbol.trim().toUpperCase();
  if (!symbolPattern.test(symbol)) return;
  state.pending.forEach((controller) => controller.abort());
  state.pending.clear();
  state.sections = {};
  state.generation += 1;
  // Refresh asks the server to bypass its cache for every section this symbol loads.
  state.refreshGeneration = refresh ? state.generation : -1;
  state.symbol = symbol;
  state.selectedName = label || "";
  state.fiscalQuarter = "";
  state.documentPeriod = "";
  state.peerMessage = "";
  searchInput.value = "";
  closeSearch();
  $("#watch-menu").hidden = true;
  $("#watch-toggle").setAttribute("aria-expanded", "false");
  const target = new URL(location.href);
  target.searchParams.set("symbol", symbol);
  history.replaceState(null, "", target);
  render();
  loadTab();
}

let searchTimer, controller, searchRows = [], searchedFor = "";
function closeSearch() {
  clearTimeout(searchTimer);
  controller?.abort();
  $("#search-results").hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
}
function searchMarkup(rows, empty) {
  return rows.length ? rows.map((row) => '<button class="search-result" data-stock="' + html(row.symbol) +
    '" data-company="' + html(row.name) + '" type="button"><strong>' + html(row.symbol) + "</strong><span>" +
    html(row.name || row.symbol) + "</span><small>" + html(value(row, "exchange", "exchange_name", "market") || "") +
    "</small></button>").join("") : '<div class="search-note">' + html(empty) + "</div>";
}
// Fetch and show results for q. Resolves true once searchRows holds q's results, false if a newer
// keystroke or Escape cancelled it.
async function runSearch(q) {
  clearTimeout(searchTimer);
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const menu = $("#search-results");
  try {
    const result = await json("/api/search?" + new URLSearchParams({ q }), request.signal);
    if (request.signal.aborted) return false;
    searchRows = (result.results || result.data || []).filter((row) => symbolPattern.test(String(row.symbol || "").toUpperCase())).slice(0, 10);
    menu.innerHTML = searchMarkup(searchRows, unsupportedHint(q) || result.error || "No matching companies. Enter an exact provider ticker to look it up.");
  } catch {
    if (request.signal.aborted) return false;
    searchRows = [];
    menu.innerHTML = searchMarkup([], "Search unavailable. You can enter an exact ticker.");
  }
  searchedFor = q;
  return true;
}
searchInput.addEventListener("input", () => {
  closeSearch();
  searchRows = [];
  searchedFor = "";
  const q = searchInput.value.trim();
  if (!q) return;
  const menu = $("#search-results");
  menu.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
  menu.innerHTML = '<div class="search-note">Searching OpenBB…</div>';
  searchTimer = setTimeout(() => runSearch(q), 280);
});
// Index (^GSPC), currency/futures (EURUSD=X, ES=F) and crypto pair (BTC/USD) symbols look valid
// to a user but the configured feeds only cover listed equities and ETFs.
function unsupportedHint(query) {
  return /[\^=/]/.test(query) ? "Index, currency and futures symbols such as ^GSPC or EURUSD=X aren't supported. " +
    "Try an ETF that tracks it, such as SPY for the S&P 500 or QQQ for the Nasdaq-100." : "";
}
$("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const typed = searchInput.value.trim();
  const query = typed.toUpperCase();
  // Enter before results arrived: a name such as "apple" must not open the ticker APPLE, so search
  // now and decide from the results. A ticker with an exchange or suffix (RY.TO, NASDAQ:MSFT) opens at once.
  if (typed && searchedFor !== typed && !/[.:-]/.test(query) && !unsupportedHint(query)) {
    const menu = $("#search-results");
    menu.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
    menu.innerHTML = '<div class="search-note">Searching OpenBB…</div>';
    if (!(await runSearch(typed)) || searchInput.value.trim() !== typed) return;
  }
  // An exact match wins; a typed ticker is used as-is (so RY.TO never becomes RY);
  // the first result is only a fallback for company-name queries such as "apple".
  const match = searchRows.find((row) => row.symbol.toUpperCase() === query);
  const hint = unsupportedHint(query);
  if (match) setSymbol(match.symbol, match.name);
  else if (!hint && symbolPattern.test(query) && (/[.:-]/.test(query) || !searchRows.length)) setSymbol(query);
  // For an index or currency symbol, explain rather than open whichever unrelated result is first.
  else if (!hint && searchRows[0]) setSymbol(searchRows[0].symbol, searchRows[0].name);
  else if (query) {
    // Nothing to open: say why instead of silently ignoring Enter.
    clearTimeout(searchTimer);
    controller?.abort();
    const menu = $("#search-results");
    menu.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
    menu.innerHTML = searchMarkup(searchRows, hint || "No match. Enter a ticker such as AAPL, RY.TO or NASDAQ:MSFT.");
  }
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") $("#search-results button")?.focus();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
  if (event.key === "Escape") {
    closeSearch();
    $("#watch-menu").hidden = true;
    $("#watch-toggle").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("click", (event) => {
  const stock = event.target.closest("[data-stock]");
  if (stock) setSymbol(stock.dataset.stock, stock.dataset.company);
  if (!event.target.closest(".search-wrap")) closeSearch();
  if (!event.target.closest("#watch-toggle,#watch-menu")) {
    $("#watch-menu").hidden = true;
    $("#watch-toggle").setAttribute("aria-expanded", "false");
  }
});

const rows = (name) => {
  const data = state.sections[name]?.data;
  return Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
};
const top = (name) => rows(name)[0] || {};
const stamp = (r) => String(value(r, "date", "period_ending", "fiscal_date_ending", "fiscal_period_end_date", "period_end_date", "end_date", "report_date", "calendar_date") || "").slice(0, 10);
function ordered(name) {
  return [...rows(name)].sort((a, b) => stamp(a).localeCompare(stamp(b)));
}
function dateLabel(v) {
  const day = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
}
const profile = () => top("profile");
const quote = () => top("quote");
const companyName = () => value(profile(), "name", "company_name", "company", "long_name") || value(quote(), "name", "company_name") || state.selectedName || state.symbol;
const quoteCurrency = () => value(quote(), "currency", "currency_code") || value(profile(), "currency", "currency_code") || "";
// Reporting currency of the statements. Never assume the quote currency: ADRs and
// cross-listings trade in one currency and report in another. Empty means unknown.
const currency = () => value(top("income_annual"), "currency", "reported_currency", "currency_code") ||
  value(top("balance_annual"), "currency", "reported_currency", "currency_code") ||
  value(top("metrics_annual"), "currency", "reported_currency", "financial_currency") || "";
const sourceText = (key) => {
  const section = state.sections[key];
  return section?.source ? html(section.source) : "";
};
function sourceStrip(...keys) {
  const labels = [...new Set(keys.map(sourceText).filter(Boolean))];
  const warning = [...new Set(keys.flatMap((key) => state.sections[key]?.warnings || []))].slice(0, 2);
  return labels.length || warning.length ? '<div class="section-meta">' + labels.join(" · ") +
    (warning.length ? '<span class="warn"> · ' + html(warning.join(" · ")) + "</span>" : "") + "</div>" : "";
}
function unavailable(keys, message) {
  const pending = keys.some((k) => state.pending.has(k));
  const errors = [...new Set(keys.map((k) => state.sections[k]?.error).filter(Boolean))];
  return '<div class="empty-state" role="status">' + (pending ?
    '<span><i class="loading"></i>Loading OpenBB data…</span>' :
    "<p>" + html(message || "No data returned for this selection.") + "</p>" +
    (errors.length ? "<p>" + html(errors[0]) + "</p>" : "")) + "</div>";
}
function safeLink(href) {
  try {
    const url = new URL(href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function renderHeader() {
  const p = profile(), q = quote(), m = top("metrics_annual"), last = ordered("history").at(-1);
  const price = amount(q, "last_price", "price", "last", "regular_market_price", "close") ?? amount(last, "close");
  const change = amount(q, "change", "change_price", "regular_market_change") ?? subtract(price, amount(q, "previous_close", "prev_close"));
  const rawChange = amount(q, "change_percent", "percent_change", "regular_market_change_percent");
  const changePct = amount(q, "change_percent_points") ??
    (rawChange != null && sourceText("quote").endsWith("Cboe") ? rawChange * 100 : rawChange);
  const name = companyName(), exchange = value(q, "exchange_name", "exchange") || value(p, "exchange_name", "exchange");
  const ticker = exchange && !state.symbol.includes(":") ? exchange + ":" + state.symbol : state.symbol;
  const summary = ordered("income_annual").at(-1);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); // earnings dates are US exchange dates
  const e = rows("earnings_calendar").map((r) => value(r, "date", "report_date", "earnings_date", "calendar_date")).filter((v) => v && v >= today).sort()[0];
  const calendarWindow = state.sections.earnings_calendar?.metadata?.window_days;
  const earnings = e ? dateLabel(e) : calendarWindow ? "None in " + calendarWindow + " days" : "—";
  // EPS and P/E must describe the same period. Provider P/E is trailing, so prefer a trailing EPS
  // (provider, else the last four reported quarters) and fall back to the fiscal year, labelled.
  const providerPe = amount(q, "pe", "pe_ratio", "trailing_pe", "price_to_earnings") ??
    amount(m, "pe", "pe_ratio", "trailing_pe", "price_to_earnings", "price_to_earnings_ratio");
  // The provider's trailing EPS, else the one its P/E implies, so EPS and P/E cover the same
  // quarters (the provider can be a quarter ahead of the filed statements) and the same currency.
  const providerEps = amount(q, "eps", "eps_ttm", "trailing_eps") ?? amount(m, "eps", "eps_ttm", "trailing_eps", "earnings_per_share_ttm") ??
    (providerPe > 0 && price != null ? price / providerPe : null);
  const statementTtm = providerEps == null ? trailingSummary(buildColumns("quarter"))?.dilutedEps : null;
  const shownEps = providerEps ?? statementTtm ?? metric(summary, "eps");
  // Statement EPS is in the reporting currency; only divide the price by it when they match.
  const sameCurrency = currency() && currency() === quoteCurrency();
  const pe = providerPe ?? (sameCurrency && shownEps > 0 ? ratio(price, shownEps) : null);
  const fromStatements = providerEps == null && shownEps != null;
  const stats = [
    ["EPS (" + (providerEps != null || statementTtm != null ? "TTM" : "FY") +
      (fromStatements && currency() && quoteCurrency() && !sameCurrency ? ", " + currency() : "") + ")", fixed(shownEps)],
    [providerPe != null || statementTtm != null ? "P/E (TTM)" : "P/E (FY)", fixed(pe)],
    ["Market cap", compact(amount(q, "market_cap", "market_capitalization") ?? amount(p, "market_cap", "market_capitalization") ??
      amount(m, "market_cap", "market_capitalization"))],
    [e ? "Next earnings (est.)" : "Next earnings", earnings]
  ];
  const priceDate = value(q, "date", "timestamp", "last_timestamp", "last_sale_time") || (!Object.keys(q).length ? stamp(last) : "");
  const quoteCaption = Object.keys(q).length ? "Provider quote" : price != null ? "Latest available daily close" :
    state.pending.has("quote") ? "Loading quote…" : "Quote unavailable";
  $("#hero").innerHTML = '<div class="identity"><div class="company-mark" aria-hidden="true">' +
    html(state.symbol.split(":").at(-1).slice(0, 4)) + '</div><div><h1>' + html(name) +
    '</h1><div class="ticker-meta"><span class="ticker">' + html(ticker) + "</span>" +
    [value(p, "sector"), value(p, "industry")].filter(Boolean).map((label) => "<span>" + html(label) + "</span>").join('<span aria-hidden="true">·</span>') +
    '</div></div></div><div><div class="price-row"><strong class="price">' + fixed(price) +
    '</strong><span class="currency">' + html(quoteCurrency()) + "</span>" +
    (change != null || changePct != null ? '<span class="change ' + ((changePct ?? change) >= 0 ? "positive" : "negative") + '">' +
      (change != null ? (change > 0 ? "+" : "") + fixed(change) : "") + (changePct != null ? " (" + percent(changePct) + ")" : "") + "</span>" : "") +
    '</div><div class="status">' + html(quoteCaption + (priceDate ? " · " + dateLabel(priceDate) : "")) +
    (Object.keys(q).length && sourceText("quote") ? " · " + sourceText("quote") : "") +
    '</div></div><div class="quote-stats">' + stats.map(([label,v]) => "<div><small>" + html(label) +
      "</small><strong>" + html(v) + "</strong></div>").join("") + "</div>";
  const crumbs = ["Equities", value(p, "country", "country_name"), value(p, "industry")].filter(Boolean);
  $("#breadcrumbs").innerHTML = crumbs.map((label) => "<span>" + html(label) + '</span><span aria-hidden="true">›</span>').join("") +
    "<strong>" + html(state.symbol) + "</strong>";
  const pinned = state.watch.some((r) => r.symbol === state.symbol);
  $("#pin").setAttribute("aria-pressed", pinned);
  $("#pin").innerHTML = '<span aria-hidden="true">' + (pinned ? "★</span> Watching" : "☆</span> Watch");
}

function series(name) {
  const result = new Map();
  const intraday = state.sections[name]?.metadata?.interval === "5m";
  for (const r of ordered(name)) {
    const date = intraday ? String(r.date || "") : stamp(r);
    const close = amount(r, "adjusted_close", "adj_close", "close", "price");
    if (Number.isFinite(Date.parse(date)) && close > 0) result.set(date, close);
  }
  return [...result].sort(([a], [b]) => Date.parse(a) - Date.parse(b)).map(([date, close]) => ({ date, close }));
}
function periodReturn(points, years) {
  const latest = points.at(-1);
  if (!latest) return null;
  const target = new Date(latest.date + "T00:00:00Z");
  target.setUTCFullYear(target.getUTCFullYear() - years);
  const start = points.find((point) => point.date >= target.toISOString().slice(0, 10));
  if (!start || (Date.parse(start.date) - Number(target)) > 10 * 86400000) return null;
  return (latest.close / start.close - 1) * 100;
}
function marketPanel() {
  const interval = state.sections.history?.metadata?.interval;
  const intraday = interval === "5m";
  const cadence = intraday ? "5-minute bars · UTC" : "Daily history";
  const flag = (name, label, disabled = false, title = "") => '<label' + (title ? ' title="' + html(title) + '"' : "") + '><input type="checkbox" data-flag="' + name + '"' +
    (state[name] ? " checked" : "") + (disabled ? " disabled" : "") + "> " + label + "</label>";
  const styleSeg = '<div class="seg" aria-label="Chart style">' + [["area", "Area"], ["candles", "Candles"]].map(([key, label]) =>
    '<button type="button" data-chart-style="' + key + '" aria-pressed="' + (state.chartStyle === key) + '"' +
    (key === "candles" && state.compare ? ' disabled title="Candles are not shown while comparing with SPY"' : "") + ">" + label + "</button>").join("") + "</div>";
  return '<section class="panel"><div class="panel-head"><div><h2>Price performance</h2><p>' + cadence +
    (state.compare ? " · rebased to 100" : "") + '</p></div><div class="tools"><div class="seg" aria-label="Chart range">' +
    ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "MAX"].map((range) => '<button type="button" data-range="' + range +
      '" aria-pressed="' + (state.range === range) + '">' + (range === "MAX" ? "Max" : range) + "</button>").join("") +
    "</div>" + styleSeg + flag("compare", "SPY") + flag("log", "Log", state.compare, state.compare ? "Log scale is off while comparing with SPY" : "") +
    flag("ma50", "50D MA", intraday || state.compare) + flag("ma200", "200D MA", intraday || state.compare) + "</div></div>" +
    '<div class="chart-legend"><span><i></i>' + html(state.symbol) + "</span>" +
    (state.compare ? '<span class="benchmark"><i></i>SPY · S&P 500 ETF</span>' : "") +
    (state.ma50 && !intraday && !state.compare ? '<span class="ma50"><i></i>50-day average</span>' : "") +
    (state.ma200 && !intraday && !state.compare ? '<span class="ma200"><i></i>200-day average</span>' : "") +
    '<span class="chart-zoom" role="group" aria-label="Zoom"><button type="button" class="ghost" data-zoom="in" aria-label="Zoom in" title="Zoom in (or Ctrl + scroll)">+</button>' +
    '<button type="button" class="ghost" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>' +
    '<button type="button" class="ghost" data-zoom="reset" title="Show the whole range">Reset</button></span></div>' +
    '<div class="chart-area">' + (series("history").length ?
      '<div id="price-host" class="price-host" role="img" aria-label="' + html(state.symbol + " price history, " + state.range + " range") + '"></div>' +
      '<div id="price-legend" class="price-legend"></div>' :
      unavailable(["history"], "Price history is unavailable for this ticker.")) + "</div>" + sourceStrip("history", ...(state.compare ? ["benchmark"] : [])) + "</section>";
}

// ---------- Interactive price chart (TradingView Lightweight Charts, Apache-2.0, /vendor) ----------
let chartLibrary, priceChart, priceChartTeardown;
function loadChartLibrary() {
  // Loaded on first use only; on failure the original canvas chart is drawn instead.
  chartLibrary ??= import("/vendor/lightweight-charts-5.2.1.js").catch((error) => {
    console.warn("Interactive chart unavailable; using the basic chart.", error);
    return null;
  });
  return chartLibrary;
}
function removePriceChart() {
  priceChartTeardown?.();
  priceChartTeardown = null;
  priceChart?.remove();
  priceChart = null;
}
// Unique, ascending bars. Daily bars use "YYYY-MM-DD" times; 5-minute bars use UTC seconds.
function ohlcRows(name) {
  const intraday = state.sections[name]?.metadata?.interval === "5m";
  const bars = new Map();
  for (const r of ordered(name)) {
    const close = amount(r, "close", "price");
    if (!(close > 0)) continue;
    const time = intraday ? Math.floor(Date.parse(r.date) / 1000) : stamp(r);
    if (intraday ? !Number.isFinite(time) : !/^\d{4}-\d{2}-\d{2}$/.test(time)) continue;
    const open = amount(r, "open"), high = amount(r, "high"), low = amount(r, "low");
    const ohlc = open > 0 && high > 0 && low > 0;
    bars.set(time, { time, close, ohlc, volume: amount(r, "volume"), open: ohlc ? open : close,
      high: ohlc ? Math.max(high, open, close) : close, low: ohlc ? Math.min(low, open, close) : close });
  }
  return [...bars.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
// Simple moving average over daily closes. The 5-year series is merged in so a 200-day line
// covers short ranges (1M, 6M) from their first day.
function movingAverage(bars, days) {
  const closes = new Map();
  for (const r of ordered("returns")) {
    const close = amount(r, "close"), day = stamp(r);
    if (close > 0 && day) closes.set(day, close);
  }
  for (const bar of bars) closes.set(bar.time, bar.close);
  const dates = [...closes.keys()].sort();
  const averages = new Map();
  let total = 0;
  dates.forEach((day, index) => {
    total += closes.get(day);
    if (index >= days) total -= closes.get(dates[index - days]);
    if (index >= days - 1) averages.set(day, total / days);
  });
  return bars.filter((bar) => averages.has(bar.time)).map((bar) => ({ time: bar.time, value: averages.get(bar.time) }));
}
const withAlpha = (color, alpha) => /^#[0-9a-f]{6}$/i.test(color) ? color + Math.round(alpha * 255).toString(16).padStart(2, "0") : color;
async function chart() {
  removePriceChart();
  const host = $("#price-host");
  if (!host) return;
  const bars = ohlcRows("history");
  if (!bars.length) return;
  const lib = await loadChartLibrary();
  if (!host.isConnected) return; // the page re-rendered while the library loaded
  if (!lib) return basicChart(host);
  try {
    buildPriceChart(lib, host, bars);
  } catch (error) {
    // A build or data error must not leave a half-drawn chart: fall back to the canvas chart.
    console.warn("Interactive chart failed; using the basic chart.", error);
    removePriceChart();
    basicChart(host);
  }
}
function basicChart(host) {
  host.outerHTML = '<canvas id="price-chart" aria-label="Price history chart" role="img"></canvas><div id="chart-tooltip" class="chart-tooltip" hidden></div>';
  $("#price-legend")?.remove();
  legacyChart();
}
function buildPriceChart(lib, host, bars) {
  const css = getComputedStyle(document.documentElement);
  const col = (name) => css.getPropertyValue(name).trim();
  const intraday = state.sections.history?.metadata?.interval === "5m";
  const benchmark = state.compare ? ohlcRows("benchmark").filter((bar) => bar.time >= bars[0].time && bar.time <= bars.at(-1).time) : [];
  const compare = benchmark.length > 0;
  const candles = state.chartStyle === "candles" && !compare && bars.some((bar) => bar.ohlc);
  const up = col("--good"), down = col("--bad"), brand = col("--brand-strong");
  const mode = compare ? lib.PriceScaleMode.IndexedTo100 : state.log ? lib.PriceScaleMode.Logarithmic : lib.PriceScaleMode.Normal;
  const chartView = lib.createChart(host, {
    autoSize: true,
    layout: { background: { type: lib.ColorType.Solid, color: "transparent" }, textColor: col("--dim"), fontSize: 11, fontFamily: col("--mono") || "monospace" },
    grid: { vertLines: { visible: false }, horzLines: { color: col("--line") } },
    rightPriceScale: { borderVisible: false, mode, scaleMargins: { top: 0.12, bottom: 0.24 } },
    timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false, rightOffset: 3, fixLeftEdge: true, fixRightEdge: true },
    crosshair: { mode: lib.CrosshairMode.Normal },
    // Plain wheel and vertical swipes keep scrolling the page; zoom is pinch, Ctrl + wheel or the buttons.
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true }
  });
  priceChart = chartView;
  const main = candles
    ? chartView.addSeries(lib.CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false })
    : compare
      ? chartView.addSeries(lib.LineSeries, { color: brand, lineWidth: 2 })
      : chartView.addSeries(lib.AreaSeries, { lineColor: brand, lineWidth: 2, topColor: withAlpha(brand, 0.28), bottomColor: withAlpha(brand, 0.02) });
  main.setData(candles ? bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })) : bars.map((bar) => ({ time: bar.time, value: bar.close })));
  const byTime = new Map(bars.map((bar, index) => [bar.time, { bar, previous: bars[index - 1] }]));
  if (!compare && bars.some((bar) => bar.volume > 0)) {
    const volume = chartView.addSeries(lib.HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chartView.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volume.setData(bars.filter((bar) => bar.volume != null).map((bar, index, list) => ({ time: bar.time, value: bar.volume,
      color: withAlpha((bar.ohlc ? bar.close >= bar.open : bar.close >= (list[index - 1]?.close ?? bar.close)) ? up : down, 0.45) })));
  }
  const averages = {};
  if (!intraday && !compare) {
    for (const [days, key, color] of [[50, "ma50", col("--amber")], [200, "ma200", col("--muted")]]) {
      if (!state[key]) continue;
      const points = movingAverage(bars, days);
      if (!points.length) continue;
      chartView.addSeries(lib.LineSeries, { color, lineWidth: 1, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false }).setData(points);
      averages[key] = new Map(points.map((point) => [point.time, point.value]));
    }
  }
  const benchmarkByTime = new Map(benchmark.map((bar) => [bar.time, bar.close]));
  if (compare) chartView.addSeries(lib.LineSeries, { color: col("--benchmark"), lineWidth: 2 }).setData(benchmark.map((bar) => ({ time: bar.time, value: bar.close })));

  // Readout of the bar under the crosshair (the latest bar otherwise).
  const legend = $("#price-legend");
  const timeLabel = (time) => intraday
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(time * 1000)) + " UTC"
    : dateLabel(time);
  const firstBench = benchmark[0]?.close, firstClose = bars[0].close;
  function showLegend(time) {
    const entry = byTime.get(time) ?? byTime.get(bars.at(-1).time);
    if (!legend || !entry) return;
    const { bar, previous } = entry;
    const change = previous ? (bar.close / previous.close - 1) * 100 : null;
    const item = (label, value, cls = "") => "<span" + (cls ? ' class="' + cls + '"' : "") + "><b>" + label + "</b> " + value + "</span>";
    const parts = [item("", timeLabel(bar.time))];
    if (compare) {
      parts.push(item(html(state.symbol), fixed(100 * bar.close / firstClose)));
      const bench = benchmarkByTime.get(bar.time);
      if (bench != null) parts.push(item("SPY", fixed(100 * bench / firstBench)));
    } else if (bar.ohlc) {
      parts.push(item("O", fixed(bar.open)), item("H", fixed(bar.high)), item("L", fixed(bar.low)), item("C", fixed(bar.close)));
    } else {
      parts.push(item("Close", fixed(bar.close)));
    }
    if (change != null && !compare) parts.push(item("", (change > 0 ? "+" : "") + fixed(change) + "%", change >= 0 ? "positive" : "negative"));
    if (bar.volume != null && !compare) parts.push(item("Vol", compact(bar.volume)));
    if (averages.ma50?.has(bar.time)) parts.push(item("MA50", fixed(averages.ma50.get(bar.time)), "ma50"));
    if (averages.ma200?.has(bar.time)) parts.push(item("MA200", fixed(averages.ma200.get(bar.time)), "ma200"));
    legend.innerHTML = parts.join("");
  }
  showLegend(null);
  chartView.subscribeCrosshairMove((param) => showLegend(param.time ?? null));

  // Keep the zoom when the page re-renders as other sections finish loading.
  const timeScale = chartView.timeScale();
  const viewKey = [state.symbol, state.range, intraday, compare, bars.length].join("|");
  if (state.chartView?.key === viewKey && state.chartView.range) timeScale.setVisibleLogicalRange(state.chartView.range);
  else timeScale.fitContent();
  const remember = (range) => { if (range) state.chartView = { key: viewKey, range }; };
  timeScale.subscribeVisibleLogicalRangeChange(remember);
  const wheel = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    zoomPriceChart(event.deltaY < 0 ? 0.8 : 1.25);
  };
  host.addEventListener("wheel", wheel, { passive: false });
  priceChartTeardown = () => {
    timeScale.unsubscribeVisibleLogicalRangeChange(remember);
    host.removeEventListener("wheel", wheel);
  };
}
function zoomPriceChart(factor) {
  if (!priceChart) return;
  const timeScale = priceChart.timeScale();
  if (factor == null) { timeScale.fitContent(); return; }
  const range = timeScale.getVisibleLogicalRange();
  if (!range) return;
  const center = (range.from + range.to) / 2, half = Math.max(5, (range.to - range.from) * factor / 2);
  timeScale.setVisibleLogicalRange({ from: center - half, to: center + half });
}
function legacyChart() {
  const canvas = $("#price-chart");
  if (!canvas) return;
  const tip = $("#chart-tooltip");
  const ctx = canvas.getContext("2d");
  const stock = series("history"), bench = state.compare ? series("benchmark") : [];
  const intraday = state.sections.history?.metadata?.interval === "5m";
  const labels = new Intl.DateTimeFormat("en-US", intraday ? { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" } :
    { month: "short", ...(state.range === "5D" || state.range === "1M" ? { day: "numeric" } : { year: "2-digit" }), timeZone: "UTC" });
  const colors = getComputedStyle(document.documentElement);
  const col = (name) => colors.getPropertyValue(name).trim();
  let hovered = -1;
  let metrics;
  const start = Date.parse(stock[0].date), end = Date.parse(stock.at(-1).date);
  const relevantBench = bench.filter((point) => Date.parse(point.date) >= start && Date.parse(point.date) <= end);
  const transform = (raw, base) => {
    const v = state.compare ? 100 * raw / base : raw;
    return state.log ? Math.log(v) : v;
  };
  const stockValues = stock.map((p) => transform(p.close, stock[0].close));
  const benchmarkValues = relevantBench.map((p) => transform(p.close, relevantBench[0].close));
  const combined = [...stockValues, ...benchmarkValues];
  const min = Math.min(...combined), max = Math.max(...combined), spread = max - min || max * .04 || 1;
  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);
    const left = 9, right = w - 53, upper = 14, lower = h - 29;
    if (right <= left) return;
    const low = min - spread * .09, high = max + spread * .09;
    const x = (date) => left + (Date.parse(date) - start) / (end - start || 1) * (right - left);
    const y = (n) => lower - (n - low) / (high - low) * (lower - upper);
    metrics = { x, left, right, upper, lower, width: w };
    ctx.font = '10px "IBM Plex Mono", Consolas, monospace';
    ctx.fillStyle = col("--dim");
    ctx.strokeStyle = col("--stroke");
    ctx.lineWidth = 1;
    for (let step = 0; step < 5; step += 1) {
      const val = low + (high - low) * step / 4, line = y(val);
      ctx.beginPath(); ctx.moveTo(left, line); ctx.lineTo(right, line); ctx.stroke();
      ctx.fillText(textNumber(state.log ? Math.exp(val) : val, 1), right + 6, line + 3);
    }
    const ticks = w > 620 ? 7 : 4;
    for (let step = 0; step < ticks; step += 1) {
      const point = left + (right - left) * step / (ticks - 1);
      const tick = labels.format(new Date(start + (end - start) * step / (ticks - 1)));
      ctx.fillText(tick, Math.min(Math.max(left, point - 19), right - 23), h - 9);
    }
    function line(points, values, color, fill) {
      if (!points.length) return;
      ctx.beginPath();
      points.forEach((point, index) => index ? ctx.lineTo(x(point.date), y(values[index])) : ctx.moveTo(x(point.date), y(values[index])));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      if (fill) {
        ctx.lineTo(x(points.at(-1).date), lower); ctx.lineTo(x(points[0].date), lower); ctx.closePath();
        const gradient = ctx.createLinearGradient(0, upper, 0, lower);
        gradient.addColorStop(0, "rgba(86, 132, 243, .24)");
        gradient.addColorStop(1, "rgba(86, 132, 243, .015)");
        ctx.fillStyle = gradient; ctx.fill();
      }
    }
    line(stock, stockValues, col("--brand-strong"), true);
    line(relevantBench, benchmarkValues, col("--benchmark"), false);
    if (hovered >= 0) {
      const px = x(stock[hovered].date), py = y(stockValues[hovered]);
      ctx.strokeStyle = col("--dim");
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(px, upper); ctx.lineTo(px, lower); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col("--brand-strong"); ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    }
  }
  canvas.addEventListener("pointermove", (event) => {
    if (!metrics) return;
    const position = event.clientX - canvas.getBoundingClientRect().left;
    hovered = stock.reduce((best, point, i) => Math.abs(metrics.x(point.date) - position) < Math.abs(metrics.x(stock[best].date) - position) ? i : best, 0);
    const point = stock[hovered];
    const benchmarkPoint = relevantBench.find((candidate) => candidate.date === point.date);
    tip.innerHTML = html(dateLabel(point.date) + (intraday ? " · " + labels.format(new Date(point.date)) + " UTC" : "")) + "<br>" + html(state.symbol) + " " + fixed(point.close) +
      (benchmarkPoint ? "<br>SPY " + fixed(benchmarkPoint.close) : "");
    tip.hidden = false;
    tip.style.left = Math.max(2, Math.min(position + 12, metrics.width - tip.offsetWidth - 2)) + "px";
    tip.style.top = "8px";
    draw();
  });
  canvas.addEventListener("pointerleave", () => { hovered = -1; tip.hidden = true; draw(); });
  chartObserver?.disconnect();
  chartObserver = new ResizeObserver(draw);
  chartObserver.observe(canvas);
  draw();
}
let chartObserver;

const aliases = {
  revenue: ["revenue", "total_revenue", "sales", "revenue_from_contract_with_customer_excluding_assessed_tax"],
  eps: ["diluted_eps", "eps_diluted", "diluted_earnings_per_share", "eps", "basic_eps", "eps_basic", "earnings_per_share_diluted", "basic_earnings_per_share"],
  basic: ["basic_eps", "eps_basic", "earnings_per_share_basic", "basic_earnings_per_share", "eps", "diluted_eps", "diluted_earnings_per_share"],
  shares: ["weighted_average_shares_outstanding", "weighted_average_shares", "weighted_average_basic_shares_outstanding",
    "weighted_average_shares_basic", "weighted_avg_shares", "weighted_average_shares_outstanding_basic",
    "weighted_average_number_of_shares", "weighted_average_number_of_shares_outstanding_basic", "weighted_ave_basic_shares_os"],
  outstanding: ["shares_outstanding", "common_stock_shares_outstanding", "common_shares_outstanding", "ordinary_shares_number"],
  income: ["net_income", "net_income_common", "net_income_attributable_to_parent", "net_income_loss"],
  operating: ["operating_income", "income_from_operations", "operating_income_loss", "total_operating_income"],
  pretax: ["income_before_tax", "pretax_income", "income_before_income_taxes", "income_before_taxes", "earnings_before_tax", "total_pretax_income", "total_pre_tax_income"],
  tax: ["income_tax_expense", "tax_expense", "income_tax", "tax_provision"],
  cashflow: ["operating_cash_flow", "net_cash_from_operating_activities", "cash_flow_from_operations", "cash_flow_from_operating_activities", "net_cash_provided_by_operating_activities"],
  capex: ["capital_expenditure", "capital_expenditures", "purchase_of_property_plant_and_equipment", "payments_to_acquire_property_plant_and_equipment", "purchase_of_plant_property_and_equipment"],
  fcf: ["free_cash_flow", "free_cashflow"],
  depreciation: ["depreciation_and_amortization", "depreciation_amortization", "depreciation", "depreciation_depletion_and_amortization"],
  equity: ["total_equity", "total_stockholders_equity", "total_shareholder_equity", "stockholders_equity", "shareholders_equity", "total_shareholders_equity", "common_equity",
    "common_stock_equity", "total_common_equity", "total_equity_non_controlling_interests"],
  currentAssets: ["total_current_assets", "current_assets", "assets_current"],
  currentLiabilities: ["total_current_liabilities", "current_liabilities", "liabilities_current"],
  assets: ["total_assets", "assets"],
  longDebt: ["long_term_debt", "long_term_borrowings", "long_term_debt_noncurrent", "long_term_debt_and_finance_leases_noncurrent"],
  shortDebt: ["short_term_debt", "short_term_borrowings", "current_debt", "current_portion_of_long_term_debt"],
  debt: ["total_debt", "debt"],
  liquid: ["cash_and_short_term_investments", "cash_cash_equivalents_and_short_term_investments"],
  cash: ["cash_and_cash_equivalents", "cash_and_equivalents", "cash_cash_equivalents"],
  inv: ["short_term_investments", "current_investments", "short_term_marketables"],
  tangibles: ["tangible_book_value", "net_tangible_assets"],
  goodwill: ["goodwill_and_intangible_assets", "goodwill_and_intangibles", "intangible_assets_including_goodwill"],
  receivables: ["net_receivables", "accounts_receivable", "accounts_receivable_net", "receivables"],
  inventory: ["inventory", "inventories", "net_inventory"],
  payables: ["accounts_payable_and_accrued_expenses", "payables_and_accrued_expenses", "accounts_payable", "accounts_payable_current"],
  deferred: ["deferred_revenue", "current_deferred_revenue", "contract_with_customer_liability_current"],
  leases: ["long_term_finance_lease_liabilities", "finance_lease_liability_noncurrent", "long_term_capital_lease_obligation"],
  preferred: ["preferred_stock", "preferred_equity", "preferred_stock_value"],
  dividend: ["dividend_per_share", "cash_dividends_per_share", "dividend", "amount", "cash_amount", "unadjusted_dividend"],
  dividendsPaid: ["dividends_paid", "common_dividends_paid", "cash_dividends_paid", "payment_of_dividends", "payments_of_dividends"]
};
function metric(row, key) { return amount(row, ...aliases[key]); }
function normalizedFiscal(r) {
  const f = String(value(r, "fiscal_year", "fiscal_year_label", "calendar_year", "fiscal_year_end") || "");
  return f.match(/\d{4}/)?.[0] || stamp(r).slice(0, 4);
}
function quarterNumber(row) {
  const q = String(value(row, "fiscal_period", "fiscal_quarter", "period", "quarter") || "");
  return /^(?:Q)?[1-4]$/i.test(q) ? Number(q.at(-1)) : null;
}
function buildColumns(suffix) {
  const datasets = ["income", "balance", "cash", "ratios", "metrics"];
  // Group by period-end date (within 20 days), not by fiscal-year label: providers disagree on
  // whether a year ending in January/February belongs to the prior or the current fiscal year.
  const groups = [];
  const day = 86400000;
  datasets.forEach((key) => {
    for (const row of ordered(key + "_" + suffix)) {
      const date = stamp(row);
      if (!Number.isFinite(Date.parse(date))) continue;
      let group = groups.find((g) => !g[key] && Math.abs(Date.parse(g.date) - Date.parse(date)) <= 20 * day);
      if (!group) groups.push(group = { date, fiscalYear: "" });
      group[key] = row;
      // The income statement's own fiscal year names the column when available.
      if (key === "income" || !group.fiscalYear) group.fiscalYear = normalizedFiscal(row);
    }
  });
  for (const group of groups) group.label = suffix === "annual" ? group.fiscalYear || group.date.slice(0, 4) : group.date;
  return groups.sort((a, b) => a.date.localeCompare(b.date));
}
const sum = (list) => list.length && list.every((n) => n != null) ? list.reduce((a, b) => a + b, 0) : null;
function dividendForYear(group) {
  const today = group.date || group.fiscalYear + "-12-31";
  const left = new Date(today + "T00:00:00Z");
  if (!Number.isFinite(+left)) return null;
  left.setUTCFullYear(left.getUTCFullYear() - 1);
  const start = left.toISOString().slice(0, 10);
  const payments = rows("dividends").filter((row) => {
    const exDate = String(value(row, "ex_dividend_date", "ex_date", "date") || "").slice(0, 10);
    return exDate > start && exDate <= today;
  });
  return sum(payments.map((r) => metric(r, "dividend")));
}
// The group about one year before `group` that has a balance sheet (for average balances).
function yearAgo(groups, group) {
  const end = Date.parse(group?.date);
  return groups.filter((g) => g.balance && (end - Date.parse(g.date)) / 86400000 >= 300 &&
    (end - Date.parse(g.date)) / 86400000 <= 430).at(-1) || null;
}
// Returns on capital from statements, as fractions, using average opening and closing balances.
// Used when no provider ratio exists (the Nasdaq ratios feed currently returns no data).
function capitalReturns(flow, balance, priorBalance) {
  if (!balance || !priorBalance) return { roe: null, roic: null, roc: null };
  // Commercial paper and the current portion of long-term debt are separate SEC fields (AAPL has
  // both), so add them rather than taking whichever alias matches first.
  const debtOf = (b) => metric(b, "debt") ?? (metric(b, "longDebt") == null ? null : metric(b, "longDebt") +
    (amount(b, "short_term_debt", "short_term_borrowings", "current_debt") ?? 0) + (amount(b, "current_portion_of_long_term_debt") ?? 0));
  // Cash and equivalents, as in the Ratios and Statistics tabs, so ROIC agrees across tabs.
  const cashOf = (b) => metric(b, "cash") ?? metric(b, "liquid");
  const investedOf = (b) => [metric(b, "equity"), debtOf(b), cashOf(b)].some((n) => n == null) ? null : metric(b, "equity") + debtOf(b) - cashOf(b);
  const employedOf = (b) => subtract(metric(b, "assets"), metric(b, "currentLiabilities"));
  const average = (of) => of(balance) == null || of(priorBalance) == null ? null : (of(balance) + of(priorBalance)) / 2;
  const equity = average((b) => metric(b, "equity")), invested = average(investedOf), employed = average(employedOf);
  const taxRate = ratio(flow.tax, flow.pretax);
  return {
    roe: equity > 0 && flow.net != null ? flow.net / equity : null,
    roic: invested > 0 && flow.op != null && taxRate != null && taxRate >= 0 && taxRate <= 1 ? flow.op * (1 - taxRate) / invested : null,
    roc: employed > 0 && flow.op != null ? flow.op / employed : null
  };
}
function fundamentals(group, prior = null) {
  const i = group.income, b = group.balance, c = group.cash, r = group.ratios, m = group.metrics;
  const computed = capitalReturns({ net: metric(i, "income"), op: metric(i, "operating"), tax: metric(i, "tax"), pretax: metric(i, "pretax") }, b, prior?.balance);
  const revenue = metric(i, "revenue"), net = metric(i, "income"), op = metric(i, "operating");
  const shares = metric(i, "shares"), equity = metric(b, "equity"), pretax = metric(i, "pretax");
  const free = metric(c, "fcf") ?? subtract(metric(c, "cashflow"), metric(c, "capex") == null ? null : Math.abs(metric(c, "capex")));
  return {
    revenue, net, op, shares, equity, pretax, free,
    eps: metric(i, "basic"), revenueShare: ratio(revenue, shares), freeShare: ratio(free, shares),
    dividend: amount(i, "cash_dividends_per_share", "dividend_per_share") ?? dividendForYear(group),
    // SEC balance sheets carry no share count; fall back to the period's weighted basic shares,
    // as the Ratios and Classic tabs do.
    bookShare: amount(m, "book_value_per_share") ?? ratio(equity, metric(b, "outstanding") ?? shares),
    tangibleShare: amount(m, "tangible_book_value_per_share") ?? ratio(metric(b, "tangibles") ?? subtract(equity, metric(b, "goodwill")), metric(b, "outstanding") ?? shares),
    opMargin: scaled(ratio(op, revenue), .01), netMargin: scaled(ratio(net, revenue), .01),
    dep: metric(c, "depreciation") ?? metric(i, "depreciation"),
    tax: scaled(ratio(metric(i, "tax"), pretax), .01), work: subtract(metric(b, "currentAssets"), metric(b, "currentLiabilities")),
    debt: metric(b, "longDebt"),
    roic: amount(r, "return_on_invested_capital", "roic") ?? amount(m, "return_on_invested_capital", "roic") ?? computed.roic,
    roc: amount(r, "return_on_capital", "roc") ?? amount(m, "return_on_capital", "roc") ?? computed.roc,
    roe: amount(r, "return_on_equity", "roe") ?? amount(m, "return_on_equity", "roe") ?? computed.roe,
    dividendsPaid: metric(c, "dividendsPaid") == null ? null : Math.abs(metric(c, "dividendsPaid"))
  };
}
const financialRows = [
  ["revenueShare", "Revenue per share", "per"], ["eps", "Basic EPS", "per"], ["freeShare", "Free cash flow per share", "per"],
  ["dividend", "Dividend per share", "per"], ["bookShare", "Book value per share", "per"], ["tangibleShare", "Tangible book value per share", "per"],
  ["shares", "Basic weighted average shares", "m"], ["revenue", "Revenue", "m"], ["opMargin", "Operating margin", "%"],
  ["dep", "Depreciation and amortization", "m"], ["net", "Net income", "m"], ["tax", "Effective tax rate", "%"],
  ["netMargin", "Net margin", "%"], ["work", "Working capital", "m"], ["debt", "Long-term debt", "m"],
  ["equity", "Total equity", "m"], ["roic", "Return on invested capital", "raw%"], ["roc", "Return on capital", "raw%"], ["roe", "Return on equity", "raw%"]
];
// OpenBB returns ratio fields as fractions (1.42 = 142%); the backend fixes providers that do not.
const rawRatio = (n) => n == null ? null : n * 100;
function display(num, kind) {
  if (num == null) return "—";
  if (kind === "%") return percent(num);
  if (kind === "raw%") return percent(rawRatio(num));
  if (kind === "m") return textNumber(num / 1e6, 1);
  return kind === "per" ? fixed(num) : textNumber(num);
}
function table(columns, metrics, first = "Metric") {
  return '<div class="table-scroll"><table class="metric-table" data-table-name="' + html(first) + '"><thead><tr><th scope="col">' + html(first) + "</th>" +
    columns.map((label) => '<th scope="col">' + html(label) + "</th>").join("") + "</tr></thead><tbody>" +
    metrics.map(([label, values]) => '<tr><th scope="row">' + html(label) + "</th>" + values.map((v) =>
      "<td" + (v == null || v === "—" ? ' class="missing"' : "") + ">" + html(v ?? "—") + "</td>").join("") +
      "</tr>").join("") + "</tbody></table></div>";
}
function panel(title, body, note = "", tools = "", source = "") {
  return '<section class="panel"><div class="panel-head"><div><h2>' + html(title) + "</h2>" +
    (note ? "<p>" + html(note) + "</p>" : "") + "</div>" + tools + "</div>" + body + source + "</section>";
}
function trailingSummary(quarters) {
  const recent = quarters.filter((g) => g.income).slice(-4);
  if (recent.length !== 4 || Date.parse(recent[3].date) - Date.parse(recent[0].date) > 310 * 86400000 ||
      recent.slice(1).some((group, i) => {
        const days = (Date.parse(group.date) - Date.parse(recent[i].date)) / 86400000;
        return days < 70 || days > 110;
      })) return null;
  const periods = recent.map((group) => fundamentals(group));
  // When the latest balance sheet is from an earlier quarter than the latest income statement
  // (for example one came from SEC and the other from Yahoo), use that balance sheet and say so.
  const latest = recent[3];
  const balanceGroup = latest.balance ? latest : quarters.filter((g) => g.balance && g.date <= latest.date &&
    Date.parse(latest.date) - Date.parse(g.date) <= 100 * 86400000).at(-1);
  const last = balanceGroup && balanceGroup !== latest ? fundamentals({ ...latest, balance: balanceGroup.balance }) : periods.at(-1);
  const taxTotal = sum(recent.map((g) => metric(g.income, "tax")));
  const revenue = sum(periods.map((p) => p.revenue)), net = sum(periods.map((p) => p.net));
  const op = sum(periods.map((p) => p.op)), shares = scaled(sum(periods.map((p) => p.shares)), 4);
  const free = sum(periods.map((p) => p.free)), pretax = sum(periods.map((p) => p.pretax));
  // fundamentals().dividend for a quarter falls back to a trailing-year window, so summing four
  // of them would count each payment up to four times. Use reported quarterly DPS when every
  // quarter has it; otherwise total the ex-dates in the year ending at the latest quarter.
  const reportedDividends = sum(recent.map((g) => amount(g.income, "cash_dividends_per_share", "dividend_per_share")));
  return {
    ...last, shares, revenue, net, revenueShare: ratio(revenue, shares), freeShare: ratio(free, shares),
    eps: sum(periods.map((p) => p.eps)), dilutedEps: sum(recent.map((g) => metric(g.income, "eps"))), dividend: reportedDividends ?? dividendForYear(recent[3]),
    netMargin: scaled(ratio(net, revenue), .01), opMargin: scaled(ratio(op, revenue), .01),
    dep: sum(periods.map((p) => p.dep)), tax: scaled(ratio(taxTotal, pretax), .01),
    ...capitalReturns({ net, op, tax: taxTotal, pretax }, balanceGroup?.balance, yearAgo(quarters, balanceGroup)?.balance),
    balanceAsOf: balanceGroup && balanceGroup !== latest ? balanceGroup.date : null
  };
}
// Names the providers when one view's statements came from more than one (e.g. SEC timed out).
function providerMix(keys) {
  const names = [...new Set(keys.map((key) => state.sections[key]?.source).filter(Boolean).map((s) => s.replace(/^OpenBB · /, "")))];
  // Providers can differ in period dates and in per-share basis (Yahoo reports TSM per ADR, SEC per share).
  return names.length > 1 ? "Combines " + names.join(" and ") + " statements; periods and per-share bases may differ" : "";
}
function splitNote(keys) {
  const bases = keys.map((key) => state.sections[key]?.metadata?.split_adjustment?.basis).filter(Boolean);
  if (bases.length && bases.every((basis) => basis === "current")) return "Per-share figures restated to the current share basis";
  if (bases.includes("partial")) return "Some pre-split per-share figures could not be restated";
  return "Per-share figures may reflect splits as reported";
}
function historicalPanel(years, quarters) {
  const keys = ["income_annual", "balance_annual", "cash_annual", "ratios_annual", "metrics_annual"];
  const selected = years.slice(-state.years), ttm = trailingSummary(quarters);
  const data = selected.map((group) => fundamentals(group, yearAgo(years, group)));
  const active = state.columns || financialRows.map((r) => r[0]);
  const tools = '<div class="tools"><select aria-label="Financial history years" data-field="years">' +
    [3, 5, 10, 20, 40].map((count) => '<option value="' + count + '"' + (count === state.years ? " selected" : "") +
      ">" + count + " years</option>").join("") + '</select><button type="button" data-customize aria-expanded="' +
    state.metricsOpen + '">Customize</button><button type="button" data-export>CSV</button></div>';
  const menu = state.metricsOpen ? '<div class="metric-menu">' + financialRows.map(([key, label]) => '<label><input type="checkbox" data-metric="' +
    key + '"' + (active.includes(key) ? " checked" : "") + ">" + html(label) + "</label>").join("") + "</div>" : "";
  const showing = financialRows.filter(([key]) => active.includes(key));
  const columns = [...selected.map((g) => "FY " + g.label), ...(ttm ? ["TTM"] : [])];
  const body = !data.length ? unavailable(keys, "Historical fundamentals are unavailable.") : !showing.length ?
    unavailable([], "Select a metric to display.") : table(columns, showing.map(([key, label, kind]) => [label, [
      ...data.map((entry) => display(entry[key], kind)), ...(ttm ? [display(ttm[key], kind)] : [])
    ]]));
  const units = (currency() ? currency() + " · " : "") + "Millions except per-share data and ratios";
  const notes = [units, splitNote(["income_annual", ...(ttm ? ["income_quarter"] : [])]),
    providerMix(["income_annual", "balance_annual", "cash_annual", ...(ttm ? ["income_quarter", "balance_quarter", "cash_quarter"] : [])]),
    ttm?.balanceAsOf ? "TTM balance-sheet items as of " + dateLabel(ttm.balanceAsOf) : ""].filter(Boolean);
  return panel("Financial highlights", menu + body, notes.join(" · "), tools, sourceStrip(...keys, ...(ttm ? ["income_quarter", "cash_quarter", "balance_quarter"] : [])));
}
function returnsPanel() {
  const stock = series("returns"), benchmark = series("benchmark_returns");
  const body = stock.length || benchmark.length ? table(["1Y", "3Y", "5Y"], [
    [state.symbol, [1, 3, 5].map((yr) => percent(periodReturn(stock, yr)))],
    ["SPY", [1, 3, 5].map((yr) => percent(periodReturn(benchmark, yr)))]
  ], "Security") : unavailable(["returns", "benchmark_returns"], "Historical returns are unavailable.");
  return panel("Trailing returns", body, "Price series · SPY tracks the S&P 500", "", sourceStrip("returns", "benchmark_returns"));
}
function detailsPanel() {
  const p = profile(), q = quote();
  const url = safeLink(value(p, "website", "company_url", "url") || "");
  const rawAddress = [value(p, "address", "address1", "street_address"), value(p, "city"), value(p, "state"), value(p, "country")].filter(Boolean).join(", ");
  const sector = value(p, "sector");
  const items = [
    ["Exchange", value(p, "exchange", "exchange_name") || value(q, "exchange", "exchange_name")],
    ["Sector", sector], ["Industry", value(p, "industry")], ["Country", value(p, "country", "country_name")],
    ["CEO", value(p, "ceo")], ["Employees", amount(p, "employees", "full_time_employees", "number_of_employees")?.toLocaleString()],
    ["CIK", value(p, "cik")], ["ISIN", value(p, "isin")], ["CUSIP", value(p, "cusip")],
    ["IPO date", value(p, "ipo_date") ? dateLabel(value(p, "ipo_date")) : null],
    ["Website", url ? '<a href="' + html(url) + '" target="_blank" rel="noopener noreferrer">' + html(new URL(url).hostname) + "</a>" : null, true],
    ["Address", rawAddress]
  ];
  const desc = value(p, "description", "business_summary", "long_business_summary", "company_description", "summary");
  const content = Object.keys(p).length || Object.keys(q).length ?
    '<div class="profile-grid">' + items.map(([label, val, rich]) => "<div><small>" + html(label) +
      "</small><strong>" + (rich && val ? val : html(val || "—")) + "</strong></div>").join("") + "</div>" +
    (desc ? '<details class="description"><summary>Business description</summary><p>' + html(desc) + "</p></details>" : "") :
    unavailable(["profile"], "A company profile is unavailable.");
  return panel("Company profile", content, "", "", sourceStrip("profile"));
}
function recentTable(title, fields, quarters) {
  const keys = ["balance_quarter", "income_quarter"];
  const periods = quarters.filter((period) => period.balance).slice(-3);
  const body = periods.length ? table(periods.map((p) => p.label), fields.map(([label, fn]) =>
    [label, periods.map((p) => display(fn(p.balance, p), "m"))])) : unavailable(keys, "Quarterly balance-sheet data is unavailable.");
  return panel(title, body, (currency() ? currency() + " · " : "") + "Millions", "", sourceStrip(...keys));
}
function growthPanel(years) {
  const metrics = [["Total equity", "equity"], ["Free cash flow", "free"], ["Net income", "net"], ["Revenue", "revenue"], ["Common dividends paid", "dividendsPaid"]];
  const latest = years.at(-1);
  const body = latest ? table(["10Y", "5Y", "1Y"], metrics.map(([label, key]) => [label, [10, 5, 1].map((n) => {
    const targetYear = Number(latest.fiscalYear) - n;
    const earlier = years.find((g) => Number(g.fiscalYear) === targetYear);
    const start = earlier ? fundamentals(earlier)[key] : null, end = fundamentals(latest)[key];
    return percent(start > 0 && end > 0 ? ((end / start) ** (1 / n) - 1) * 100 : null);
  })])) : unavailable(["cash_annual", "income_annual", "balance_annual"], "Annual fundamentals are required for CAGR.");
  return panel("Growth rates", body, "Compound annual growth rate", "", sourceStrip("cash_annual", "income_annual", "balance_annual"));
}
function quarterlyPanel(title, kind, years, quarters) {
  const label = kind === "revenue" ? (currency() ? currency() + " · Millions" : "Millions") : "Per share" + (currency() ? " · " + currency() : "");
  const keys = kind === "dividend" ? ["dividends", "income_quarter"] : ["income_quarter"];
  const active = quarters.filter((p) => p.income && quarterNumber(p.income));
  const groups = new Map();
  for (const item of active) {
    const positions = groups.get(item.fiscalYear) || [];
    positions[quarterNumber(item.income) - 1] = item;
    groups.set(item.fiscalYear, positions);
  }
  function payment(g) {
    const reported = amount(g.income, "cash_dividends_per_share", "dividend_per_share");
    if (reported != null) return reported;
    const end = g.date;
    const prior = new Date(end + "T00:00:00Z");
    if (!Number.isFinite(+prior)) return null;
    const previousFiscalEnd = quarters.filter((period) => period.date < end).at(-1)?.date;
    prior.setUTCMonth(prior.getUTCMonth() - 3);
    const lower = previousFiscalEnd || prior.toISOString().slice(0, 10);
    const payments = rows("dividends").filter((row) => {
      const d = String(value(row, "ex_dividend_date", "ex_date", "date") || "").slice(0, 10);
      return d > lower && d <= end;
    });
    return sum(payments.map((p) => metric(p, "dividend")));
  }
  const charted = [...groups].slice(-4).reverse().map(([year, period]) => {
    const annual = years.find((g) => g.fiscalYear === year);
    const list = Array.from({ length: 4 }, (_, index) => {
      const group = period[index];
      return group ? kind === "dividend" ? payment(group) : metric(group.income, kind) : null;
    });
    list.push(annual ? kind === "dividend" ? fundamentals(annual).dividend : metric(annual.income, kind) : null);
    return [year, list.map((n) => display(n, kind === "revenue" ? "m" : "per"))];
  });
  const body = charted.length ? table(["Q1", "Q2", "Q3", "Q4", "FY"], charted, "Fiscal year") :
    unavailable(keys, "This provider did not return fiscal quarter labels.");
  return panel(title, body, label + (kind === "revenue" ? "" : " · " + splitNote(["income_quarter"])), "", sourceStrip(...keys));
}
function newsPanel() {
  const items = rows("news").slice(0, 16);
  const body = items.length ? '<ul class="news-list">' + items.map((row) => {
    const url = safeLink(value(row, "url", "link", "article_url"));
    const title = html(value(row, "title", "headline", "name") || "Untitled article");
    const by = [value(row, "source", "publisher", "author"), dateLabel(value(row, "date", "published", "published_date", "created_at"))].filter((v) => v && v !== "—");
    return "<li>" + (url ? '<a target="_blank" rel="noopener noreferrer" href="' + html(url) + '">' + title + "</a>" :
      "<strong>" + title + "</strong>") + "<small>" + html(by.join(" · ")) + "</small></li>";
  }).join("") + "</ul>" : unavailable(["news"], "No company news was returned.");
  return panel("Company news", body, "", "", sourceStrip("news"));
}
function peersPanel() {
  const items = rows("peers").flatMap((row) => Array.isArray(row?.peers) ? row.peers : [row]).slice(0, 14);
  const body = items.length ? '<div class="peer-list">' + items.map((row) => {
    const symbol = typeof row === "string" ? row : value(row, "symbol", "ticker", "peer");
    return symbol ? '<button class="ghost" type="button" data-stock="' + html(symbol) + '">' + html(symbol) + "</button>" : "";
  }).join("") + "</div>" : unavailable(["peers"], "A peer group is unavailable from the configured providers.");
  const compare = items.length ? '<div class="peer-list"><a class="text-button" href="#peers">Compare side by side →</a></div>' : "";
  return panel("Similar companies", body + compare, "", "", sourceStrip("peers"));
}

// ---------- Peer comparison (Peers tab) ----------
// Yahoo Finance key statistics per company. Ratios are fractions; debt_to_equity arrives in percent.
const peerColumns = [
  ["market_cap", "Market cap", "cap"], ["pe_ratio", "P/E", "x"], ["forward_pe", "Fwd P/E", "x"], ["peg_ratio", "PEG", "x"],
  ["enterprise_to_ebitda", "EV/EBITDA", "x"], ["enterprise_to_revenue", "EV/Sales", "x"], ["price_to_book", "P/B", "x"],
  ["gross_margin", "Gross margin", "%"], ["operating_margin", "Op. margin", "%"], ["profit_margin", "Net margin", "%"],
  ["return_on_equity", "ROE", "%"], ["revenue_growth", "Revenue growth", "%"], ["earnings_growth", "Earnings growth", "%"],
  ["dividend_yield", "Div. yield", "%"], ["debt_to_equity", "Debt / equity", "de"], ["beta", "Beta", "n"], ["price_return_1y", "1Y return", "%"]
];
const PEER_MAX = 12;
const peerStore = loadSetting("equity-desk-peers", {});
function suggestedPeers() {
  return rows("peers").map((row) => String(row.symbol || "").toUpperCase()).filter((symbol) => symbolPattern.test(symbol)).slice(0, 8);
}
// The user's list for this company when they edited it, else the suggested group.
function peerSymbols() {
  const custom = peerStore[state.symbol];
  return (Array.isArray(custom) ? custom : suggestedPeers()).filter((symbol) => symbol !== state.symbol).slice(0, PEER_MAX);
}
function savePeers(list) {
  if (list) peerStore[state.symbol] = list;
  else delete peerStore[state.symbol];
  saveSetting("equity-desk-peers", peerStore);
}
const peerKey = (symbol) => symbol === state.symbol ? "metrics_annual" : "metrics_annual@" + symbol;
const quoteKey = (symbol) => symbol === state.symbol ? "quote" : "quote@" + symbol;
// Market cap is in the trading currency (the quote's); key statistics carry the reporting currency
// (Sony's ADR reports in JPY but its market cap is in USD).
const capCurrency = (symbol) => value(top(quoteKey(symbol)), "currency") || "";
function loadPeer(symbol) {
  load("metrics_annual@" + symbol);
  load("quote@" + symbol);
}
function peerMetric(symbol, key) {
  const n = amount(top(peerKey(symbol)), key);
  return n == null ? null : key === "debt_to_equity" ? n / 100 : n;
}
function peerFormat(n, type, currencyCode = "") {
  if (n == null) return "—";
  if (type === "cap") return compact(n) + (currencyCode ? " " + currencyCode : "");
  if (type === "x") return fixed(n, 1) + "×";
  if (type === "de") return fixed(n, 2) + "×";
  if (type === "%") return fixed(n * 100, 1) + "%";
  return fixed(n, 2);
}
const median = (list) => {
  const values = list.filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
function renderPeers() {
  const peers = peerSymbols();
  peers.forEach(loadPeer);
  const custom = Array.isArray(peerStore[state.symbol]);
  const meta = state.sections.peers?.metadata;
  const names = new Map(rows("peers").map((row) => [String(row.symbol).toUpperCase(), row.name]));
  names.set(state.symbol, companyName());
  const loading = (symbol) => state.pending.has(peerKey(symbol));
  const failed = (symbol) => !loading(symbol) && !Object.keys(top(peerKey(symbol))).length;
  // Sort the peers by the chosen column (missing values last); the company itself stays on top.
  const { key: sortKey, dir } = state.peerSort;
  const sorted = [...peers].sort((a, b) => {
    const x = peerMetric(a, sortKey), y = peerMetric(b, sortKey);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return (x - y) * dir;
  });
  const medians = Object.fromEntries(peerColumns.map(([key]) => [key, median(peers.map((symbol) => peerMetric(symbol, key)))]));
  // A median market cap only means something when every company reports in the same currency.
  const ownCurrency = capCurrency(state.symbol);
  if (!ownCurrency || peers.some((symbol) => capCurrency(symbol) !== ownCurrency)) medians.market_cap = null;
  const versus = (key, type) => {
    const own = peerMetric(state.symbol, key), mid = medians[key];
    if (own == null || mid == null) return "—";
    if (type === "%") {
      const points = (own - mid) * 100;
      return (points > 0 ? "+" : "") + fixed(points, 1) + " pts";
    }
    if (!(mid > 0) || !(own > 0)) return "—";
    // Size differences span orders of magnitude, so market cap reads as a multiple of the median.
    if (type === "cap") return textNumber(own / mid, own / mid >= 10 ? 0 : 1) + "× median";
    const change = (own / mid - 1) * 100;
    return (change > 0 ? "+" : "") + fixed(change, 0) + "%";
  };
  const head = '<tr><th scope="col">Company</th>' + peerColumns.map(([key, label]) => {
    const active = sortKey === key;
    return '<th scope="col" aria-sort="' + (active ? (dir > 0 ? "ascending" : "descending") : "none") + '"><button type="button" class="sort" data-peer-sort="' + key + '">' +
      html(label) + (active ? (dir > 0 ? " ▲" : " ▼") : "") + "</button></th>";
  }).join("") + "</tr>";
  const row = (symbol, self) => {
    const currencyCode = capCurrency(symbol);
    const cells = loading(symbol) ? peerColumns.map(() => '<td class="missing">…</td>').join("") :
      peerColumns.map(([key, , type]) => {
        const n = peerMetric(symbol, key);
        return "<td" + (n == null ? ' class="missing"' : "") + ">" + html(peerFormat(n, type, currencyCode)) + "</td>";
      }).join("");
    const label = '<button type="button" class="link" data-stock="' + html(symbol) + '"' + (self ? " disabled" : "") + ">" + html(symbol) + "</button>" +
      (names.get(symbol) ? "<small>" + html(names.get(symbol)) + "</small>" : "") +
      (failed(symbol) ? '<small class="warn">No data from Yahoo Finance</small>' : "");
    const remove = self ? "" : '<button type="button" class="ghost remove" data-peer-remove="' + html(symbol) + '" aria-label="Remove ' + html(symbol) + ' from peers" title="Remove">×</button>';
    return '<tr class="' + (self ? "self" : "") + '"><th scope="row"><div class="peer-name"><div>' + label + "</div>" + remove + "</div></th>" + cells + "</tr>";
  };
  const summaryRows = peers.length ? '<tr class="summary-row"><th scope="row">Peer median</th>' +
      peerColumns.map(([key, , type]) => "<td>" + html(peerFormat(medians[key], type, type === "cap" ? ownCurrency : "")) + "</td>").join("") + "</tr>" +
    '<tr class="summary-row"><th scope="row">' + html(state.symbol) + " vs median</th>" +
      peerColumns.map(([key, , type]) => "<td>" + html(versus(key, type)) + "</td>").join("") + "</tr>" : "";
  const tableHtml = '<div class="table-scroll peer-scroll"><table class="metric-table peer-table" data-table-name="Peer comparison"><thead>' + head +
    "</thead><tbody>" + row(state.symbol, true) + sorted.map((symbol) => row(symbol, false)).join("") + summaryRows + "</tbody></table></div>";
  const group = meta ? (custom ? "Your list. Suggested peers: " : "Suggested: ") + "largest companies by market cap in Yahoo Finance's " +
    html(meta.group) + " " + html(meta.basis) + (meta.country ? " (" + html(meta.country.toUpperCase()) + " listings)" : "") + "." : "";
  const status = state.peerMessage ? '<p class="peer-message" role="status">' + html(state.peerMessage) + "</p>" : "";
  const controls = '<form class="peer-controls" data-peer-form autocomplete="off"><input type="text" data-peer-input aria-label="Add a peer ticker" placeholder="Add ticker, e.g. MSFT" maxlength="30">' +
    '<button type="submit" class="ghost">Add</button>' + (custom ? '<button type="button" class="ghost" data-peer-reset>Reset to suggested</button>' : "") +
    '<button type="button" class="ghost" data-export>Export CSV</button></form>';
  const body = !peers.length ? (state.pending.has("peers") ? unavailable(["peers"]) :
      unavailable(["peers"], "No peer group is available. Add tickers above to compare.")) : tableHtml;
  const note = "Yahoo Finance key statistics, trailing twelve months where applicable. Ratios compare across currencies; market caps are in each company's own currency. " +
    "Click a column to sort; click a ticker to open it.";
  return panel("Peer comparison", controls + status + body, group, "", sourceStrip("peers")) + '<p class="section-meta">' + html(note) + "</p>";
}
function addPeer(raw) {
  const symbol = String(raw || "").trim().toUpperCase();
  const list = peerSymbols();
  state.peerMessage = !symbol ? "" : !symbolPattern.test(symbol) ? unsupportedHint(symbol) || symbol + " is not a valid ticker." :
    symbol === state.symbol ? symbol + " is the company being compared." : list.includes(symbol) ? symbol + " is already in the list." :
    list.length >= PEER_MAX ? "Up to " + PEER_MAX + " peers can be compared." : "";
  if (!symbol || state.peerMessage) return;
  savePeers([...list, symbol]);
  loadPeer(symbol);
}
function renderSummary() {
  const years = buildColumns("annual"), quarters = buildColumns("quarter");
  const balanceValue = (key) => (b) => metric(b,key);
  const capital = recentTable("Capital structure", [
    ["Short-term debt", balanceValue("shortDebt")], ["Long-term borrowings", balanceValue("longDebt")],
    ["Long-term finance leases", balanceValue("leases")], ["Preferred equity", balanceValue("preferred")],
    // No market-cap row: balance sheets never carry one, so it was always blank (the header shows it).
    ["Shares outstanding", balanceValue("outstanding")]
  ], quarters);
  const working = recentTable("Working capital", [
    ["Current assets", balanceValue("currentAssets")], ["Cash and short-term investments", (b) => metric(b,"liquid") ?? sum([metric(b,"cash"),metric(b,"inv")])],
    ["Net receivables", balanceValue("receivables")], ["Inventories", balanceValue("inventory")],
    ["Current liabilities", balanceValue("currentLiabilities")], ["Payables and accruals", balanceValue("payables")],
    ["Short-term debt", balanceValue("shortDebt")], ["Deferred revenue", balanceValue("deferred")]
  ], quarters);
  return '<div class="grid"><div class="flow">' + marketPanel() + historicalPanel(years, quarters) +
    '<div class="columns-two">' + capital + working + "</div>" + growthPanel(years) +
    '<div class="columns-two">' + quarterlyPanel("Quarterly revenue", "revenue", years, quarters) +
    quarterlyPanel("Quarterly earnings per share", "eps", years, quarters) + '</div>' +
    quarterlyPanel("Quarterly dividends per share", "dividend", years, quarters) +
    '</div><aside class="flow">' + returnsPanel() + detailsPanel() + peersPanel() + newsPanel() + "</aside></div>";
}

function renderWatchlist() {
  $("#watch-menu").innerHTML = searchMarkup(state.watch, "Add companies using the Watch button.");
}
$("#watch-toggle").addEventListener("click", () => {
  const menu = $("#watch-menu");
  menu.hidden = !menu.hidden;
  $("#watch-toggle").setAttribute("aria-expanded", String(!menu.hidden));
  if (!menu.hidden) renderWatchlist();
});
$("#pin").addEventListener("click", () => {
  const index = state.watch.findIndex((row) => row.symbol === state.symbol);
  if (index < 0) state.watch.unshift({ symbol: state.symbol, name: companyName() });
  else state.watch.splice(index, 1);
  saveSetting("equity-desk-watchlist", state.watch);
  renderHeader();
  renderWatchlist();
});
function savePreferences() {
  saveSetting("equity-desk-preferences", { theme: state.theme, columns: state.columns, chartStyle: state.chartStyle, ma50: state.ma50, ma200: state.ma200 });
}
$("#theme").addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  savePreferences();
  render();
});
$("#refresh").addEventListener("click", () => setSymbol(state.symbol, companyName(), true));

function setTab() {
  const tab = location.hash.slice(1);
  if (!tabs.includes(tab)) return;
  state.tab = tab;
  loadTab();
  render();
}
window.addEventListener("hashchange", setTab);
$("#tabs").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();
  history.pushState(null, "", link.getAttribute("href"));
  setTab();
});
function setRange(range) {
  if (state.range === range) return;
  state.range = range;
  for (const key of ["history", "benchmark"]) {
    delete state.sections[key];
    state.pending.get(key)?.abort();
    state.pending.delete(key);
    if (key === "history" || state.compare) load(key);
  }
}
function printSections() {
  const suffix = state.period === "annual" ? "annual" : "quarter";
  const sections = { ...state.sections };
  if (state.tab === "charts" && sections.chart_history) sections.history = sections.chart_history;
  for (const key of ["income", "cash", "balance", "ratios", "metrics"]) {
    if (sections[key + "_" + suffix]) sections[key] = sections[key + "_" + suffix];
  }
  for (const key of state.pending.keys()) {
    if (!sections[key]) sections[key] = { data: [], loading: true };
    if (key.endsWith("_" + suffix)) {
      const stem = key.slice(0, -(suffix.length + 1));
      if (!sections[stem]) sections[stem] = { data: [], loading: true };
    }
  }
  return sections;
}
function detailTools() {
  if (!["financials", "ratios", "charts", "classic"].includes(state.tab)) return "";
  const tableMode = ["financials", "ratios"].includes(state.tab);
  return '<div class="detail-toolbar"><div class="tools">' + (tableMode ?
    '<div class="seg" aria-label="Financial reporting period">' +
      [["annual", "Annual"], ["quarterly", "Quarterly"], ["ttm", "TTM"]].map(([k, label]) =>
        '<button type="button" data-period="' + k + '" aria-pressed="' + (state.period === k) + '">' + label + "</button>").join("") +
      "</div>" : "") +
    '<select aria-label="Years of financial history" data-field="years">' +
    [1, 3, 5, 10, 20, 40].map((n) => '<option value="' + n + '"' + (state.years === n ? " selected" : "") + ">" + n + " years</option>").join("") +
    "</select>" +
    (tableMode ? '<select aria-label="Financial number format" data-field="format">' +
      [["millions", "Millions"], ["billions", "Billions"], ["full", "Full values"]].map(([k, label]) => '<option value="' + k + '"' + (state.format === k ? " selected" : "") + ">" + label + "</option>").join("") +
      '</select>' + (state.tab === "financials" ? '<label><input type="checkbox" data-flag="perShare"' + (state.perShare ? " checked" : "") +
      '> Per share</label>' : "") + '<label><input type="checkbox" data-flag="yoy"' + (state.yoy ? " checked" : "") + '> YoY</label>' : "") +
    (state.tab === "charts" ? '<label><input type="checkbox" data-flag="log"' + (state.log ? " checked" : "") + '> Log</label>' +
      '<select aria-label="Add metric" data-field="chartMetric">' + [
        ["", "Add metric"], ["revenue", "Revenue"], ["eps", "EPS"], ["fcf", "Free cash flow"], ["return_on_invested_capital", "ROIC"],
        ["net_margin", "Net margin"], ["debt", "Debt"], ["working_capital", "Working capital"]
      ].map(([k,label]) => '<option value="' + k + '"' + (state.chartMetric === k ? " selected" : "") + ">" + label + "</option>").join("") + "</select>" : "") +
    '</div><div class="tools"><button type="button" data-export>Export CSV</button></div></div>';
}
function render() {
  const focus = document.activeElement;
  const view = $("#view");
  const oldScroll = [...view.querySelectorAll(".table-scroll")].map((el) => el.scrollLeft);
  let restoreSelector = "";
  if (view.contains(focus)) {
    const attr = [...(focus.attributes || [])].find((item) => item.name.startsWith("data-"));
    if (attr) restoreSelector = "[" + attr.name + '="' + CSS.escape(attr.value) + '"]';
  }
  document.documentElement.dataset.theme = state.theme;
  $("meta[name=color-scheme]").content = state.theme;
  document.title = state.symbol + " · Equity Desk";
  renderHeader();
  for (const link of $("#tabs").querySelectorAll("a")) {
    if (state.tab === link.dataset.tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  chartObserver?.disconnect();
  if (state.tab === "summary") {
    view.innerHTML = renderSummary();
    chart();
  } else if (state.tab === "peers") {
    removePriceChart();
    view.innerHTML = renderPeers();
  } else {
    removePriceChart();
    const context = { ...state, currency: currency(), quoteCurrency: quoteCurrency(), company: companyName() };
    view.innerHTML = detailTools() + '<div class="detail-stack">' +
      (window.StockDetail?.render(state.tab, printSections(), context) || unavailable([], "This section is unavailable.")) + "</div>";
  }
  [...view.querySelectorAll(".table-scroll")].forEach((el, index) => { el.scrollLeft = oldScroll[index] || 0; });
  if (restoreSelector) view.querySelector(restoreSelector)?.focus({ preventScroll: true });
}
$("#view").addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-detail-tab]");
  if (!target) return;
  if (target.dataset.zoom) {
    // Zoom changes the chart in place; no re-render needed.
    zoomPriceChart({ in: 0.6, out: 1 / 0.6, reset: null }[target.dataset.zoom]);
    return;
  }
  if (target.dataset.peerSort) {
    const key = target.dataset.peerSort;
    // First click sorts high-to-low; a second click on the same column flips the order.
    state.peerSort = { key, dir: state.peerSort.key === key ? -state.peerSort.dir : -1 };
  }
  else if (target.dataset.peerRemove) {
    savePeers(peerSymbols().filter((symbol) => symbol !== target.dataset.peerRemove));
    state.peerMessage = target.dataset.peerRemove + " removed.";
  }
  else if (target.hasAttribute("data-peer-reset")) {
    savePeers(null);
    state.peerMessage = "";
  }
  else if (target.dataset.range) setRange(target.dataset.range);
  else if (target.dataset.chartStyle) {
    state.chartStyle = target.dataset.chartStyle;
    savePreferences();
  }
  else if (target.dataset.period) state.period = target.dataset.period;
  else if (target.hasAttribute("data-customize")) state.metricsOpen = !state.metricsOpen;
  else if (target.hasAttribute("data-export")) {
    if (!window.StockDetail) return;
    window.StockDetail.exportTables(state.tab === "summary" ? target.closest(".panel") : $("#view"), state.symbol + "-" + state.tab + ".csv");
    return;
  } else return;
  render();
});
$("#view").addEventListener("submit", (event) => {
  if (!event.target.matches("[data-peer-form]")) return;
  event.preventDefault();
  addPeer(event.target.querySelector("[data-peer-input]")?.value);
  render();
  $("[data-peer-input]")?.focus();
});
$("#view").addEventListener("change", (event) => {
  const t = event.target;
  if (t.dataset.flag) {
    state[t.dataset.flag] = t.checked;
    if (t.dataset.flag === "compare" && t.checked) load("benchmark");
    if (["ma50", "ma200"].includes(t.dataset.flag)) savePreferences();
  }
  else if (t.dataset.field) state[t.dataset.field] = t.dataset.field === "years" ? Number(t.value) : t.value;
  else if (t.dataset.metric) {
    const list = new Set(state.columns || financialRows.map((r) => r[0]));
    if (t.checked) list.add(t.dataset.metric);
    else list.delete(t.dataset.metric);
    state.columns = [...list];
    savePreferences();
  } else return;
  render();
});
loadTab();
render();
})();
