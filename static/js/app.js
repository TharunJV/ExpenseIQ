/**
 * ExpenseIQ — Frontend Application Logic
 * Single-Page App with full CRUD, charts, budgets, and export
 * Modular design: ready for voice command integration (see voiceModule at bottom)
 */

"use strict";

// ─────────────────────────────────────────
// STATE & CONFIG
// ─────────────────────────────────────────

const API = "";  // Base URL (empty = same origin)

const CAT_EMOJI = {
  Food: "🍛", Travel: "🚌", Shopping: "🛍",
  Bills: "⚡", Health: "💊", Entertainment: "🎬",
  Education: "📚", Other: "📦"
};

const CAT_COLORS = {
  Food: "#4caf78", Travel: "#5c9eff", Shopping: "#9b7eff",
  Bills: "#f0a500", Health: "#e05c5c", Entertainment: "#e06c2a",
  Education: "#00d2c8", Other: "#8890aa"
};

// Chart instances (kept globally for update/destroy)
let barChartInst = null;
let pieChartInst = null;
let monthlyChartInst = null;
let categoryBarInst = null;

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  setCurrentDatetime();
  updateDashDate();
  navigate("dashboard");
  applyStoredTheme();
  // Fetch and show balance immediately on every page load
  api("/api/balance").then(r => updateBalanceDisplay(r.balance)).catch(() => {});
});

// ─────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────

function navigate(page) {
  // Hide all pages
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  // Show target page
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add("active");

  // Highlight nav
  const navItem = document.querySelector(`[data-page="${page}"]`);
  if (navItem) navItem.classList.add("active");

  // Load page-specific data
  if (page === "dashboard") loadDashboard();
  if (page === "expenses") loadExpenses();
  if (page === "analytics") loadAnalytics();
  if (page === "budgets") loadBudgets();
  if (page === "income") { loadIncomePage(); }
  if (page === "add") {
    resetForm();
    setCurrentDatetime();
  }

  // Close mobile sidebar
  if (window.innerWidth <= 768) closeSidebar();
}

// ─────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");

    // ── Balance banner ──
    updateBalanceDisplay(data.balance);
    setText("monthIncomeDisplay", `₹${fmt(data.month_income || 0)}`);
    setText("monthSpentDisplay", `₹${fmt(data.month_total)}`);

    // KPI cards
    setText("kpiToday", `₹${fmt(data.today_total)}`);
    setText("kpiMonth", `₹${fmt(data.month_total)}`);
    setText("kpiAvg", `₹${fmt(data.daily_avg)}`);
    setText("kpiTodayCount", `${data.today_count} expense${data.today_count !== 1 ? "s" : ""}`);

    if (data.top_category?.category) {
      setText("kpiTopCat", data.top_category.category);
      setText("kpiTopAmt", `₹${fmt(data.top_category.total)} total`);
    }

    // Bar chart (daily last 30 days)
    renderBarChart(data.daily_trend);

    // Pie chart (category breakdown)
    renderPieChart(data.categories);

    // Recent expenses (last 6)
    renderRecentList(data);

  } catch (err) {
    showToast("Could not load dashboard", "error");
  }
}

function renderBarChart(daily) {
  const ctx = document.getElementById("barChart").getContext("2d");
  if (barChartInst) barChartInst.destroy();

  const labels = daily.map(d => fmtDateShort(d.day));
  const values = daily.map(d => d.total);

  barChartInst = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "₹ Spent",
        data: values,
        backgroundColor: "rgba(240,165,0,0.75)",
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: chartOptions("bar")
  });
}

function renderPieChart(categories) {
  const ctx = document.getElementById("pieChart").getContext("2d");
  if (pieChartInst) pieChartInst.destroy();

  const labels = categories.map(c => c.category);
  const values = categories.map(c => c.total);
  const colors = labels.map(l => CAT_COLORS[l] || "#8890aa");

  pieChartInst = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ₹${fmt(ctx.raw)}`
          }
        }
      }
    }
  });

  // Custom legend
  const legend = document.getElementById("pieLegend");
  if (legend) {
    legend.innerHTML = labels.map((l, i) =>
      `<div class="pie-legend-item">
         <div class="pie-dot" style="background:${colors[i]}"></div>
         <span>${l}: ₹${fmt(values[i])}</span>
       </div>`
    ).join("");
  }
}

async function renderRecentList(dashData) {
  // Fetch recent expenses separately
  const expenses = await api("/api/expenses?");
  const recent = expenses.slice(0, 6);
  const el = document.getElementById("recentList");
  if (!el) return;

  if (!recent.length) {
    el.innerHTML = `<p class="empty-state">No expenses yet. <a onclick="navigate('add')" style="color:var(--accent);cursor:pointer">Add your first →</a></p>`;
    return;
  }

  el.innerHTML = recent.map(exp => `
    <div class="recent-item">
      <div class="recent-cat-dot bg-${exp.category}">
        ${CAT_EMOJI[exp.category] || "📦"}
      </div>
      <div class="recent-info">
        <div class="recent-title">${esc(exp.title)}</div>
        <div class="recent-meta">${exp.category}${exp.location ? " · " + esc(exp.location) : ""} · ${fmtDate(exp.datetime)}</div>
      </div>
      <div class="recent-amount">₹${fmt(exp.amount)}</div>
    </div>
  `).join("");
}

// ─────────────────────────────────────────
// EXPENSES LIST
// ─────────────────────────────────────────

async function loadExpenses() {
  const tbody = document.getElementById("expenseTableBody");
  tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Loading…</td></tr>`;

  const params = buildFilterParams();
  const expenses = await api(`/api/expenses?${params}`);

  if (!expenses.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No expenses found. Try clearing filters.</td></tr>`;
    setText("tableFooter", "");
    return;
  }

  tbody.innerHTML = expenses.map(exp => `
    <tr>
      <td>${fmtDate(exp.datetime)}</td>
      <td>
        <div style="font-weight:500">${esc(exp.title)}</div>
        ${exp.reason ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">${esc(exp.reason)}</div>` : ""}
      </td>
      <td><span class="cat-pill cat-${exp.category}">${CAT_EMOJI[exp.category] || ""} ${exp.category}</span></td>
      <td style="color:var(--text2)">${esc(exp.location || "—")}</td>
      <td class="align-right"><span class="amount-cell">₹${fmt(exp.amount)}</span></td>
      <td class="align-center">
        <div class="actions-cell">
          <button class="btn-icon edit" onclick="editExpense(${exp.id})" title="Edit">✎</button>
          <button class="btn-icon delete" onclick="confirmDelete(${exp.id})" title="Delete">✕</button>
        </div>
      </td>
    </tr>
  `).join("");

  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const footerEl = document.getElementById("tableFooter");
  if (footerEl) {
    footerEl.innerHTML = `
      <span>${expenses.length} expense${expenses.length !== 1 ? "s" : ""}</span>
      <span>Total: <strong>₹${fmt(total)}</strong></span>
    `;
  }
}

function buildFilterParams() {
  const params = new URLSearchParams();
  const search = document.getElementById("filterSearch")?.value;
  const category = document.getElementById("filterCategory")?.value;
  const from = document.getElementById("filterFrom")?.value;
  const to = document.getElementById("filterTo")?.value;
  const min = document.getElementById("filterAmtMin")?.value;
  const max = document.getElementById("filterAmtMax")?.value;

  if (search) params.set("search", search);
  if (category && category !== "all") params.set("category", category);
  if (from) params.set("date_from", from);
  if (to) params.set("date_to", to);
  if (min) params.set("amount_min", min);
  if (max) params.set("amount_max", max);

  return params.toString();
}

function clearFilters() {
  ["filterSearch","filterCategory","filterFrom","filterTo","filterAmtMin","filterAmtMax"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === "filterCategory" ? "all" : "";
  });
  loadExpenses();
}

// ─────────────────────────────────────────
// ADD / EDIT EXPENSE
// ─────────────────────────────────────────

async function submitExpense() {
  const id     = document.getElementById("fId").value;
  const title  = document.getElementById("fTitle").value.trim();
  const amount = parseFloat(document.getElementById("fAmount").value);
  const cat    = document.getElementById("fCategory").value;
  const loc    = document.getElementById("fLocation").value.trim();
  const reason = document.getElementById("fReason").value.trim();
  const dt     = document.getElementById("fDatetime").value;

  if (!title || !amount || !cat || !dt) {
    showToast("Please fill in all required fields", "error");
    return;
  }

  const body = { title, amount, category: cat, location: loc, reason, datetime: dt.replace("T", " ") };

  try {
    let resp;
    if (id) {
      resp = await api(`/api/expenses/${id}`, "PUT", body);
      showToast("Expense updated! ✓", "success");
    } else {
      resp = await api("/api/expenses", "POST", body);
      showToast("Expense saved! ✓", "success");

      // Show budget alert if returned
      if (resp.alert) {
        setTimeout(() => showToast(resp.alert.message, resp.alert.type === "danger" ? "error" : "warning"), 1200);
      }
    }

    // ── Refresh balance display if returned ──
    if (resp.new_balance !== undefined) {
      updateBalanceDisplay(resp.new_balance);
    }

    resetForm();
    navigate("dashboard");

  } catch (err) {
    // Handle insufficient balance (HTTP 400 with specific flag)
    if (err.data && err.data.insufficient) {
      showToast(`⚠️ ${err.data.error}`, "error");
    } else {
      showToast("Failed to save expense", "error");
    }
  }
}

async function editExpense(id) {
  try {
    const expenses = await api(`/api/expenses?`);
    const exp = expenses.find(e => e.id === id);
    if (!exp) return;

    document.getElementById("fId").value = exp.id;
    document.getElementById("fTitle").value = exp.title;
    document.getElementById("fAmount").value = exp.amount;
    document.getElementById("fCategory").value = exp.category;
    document.getElementById("fLocation").value = exp.location || "";
    document.getElementById("fReason").value = exp.reason || "";
    document.getElementById("fDatetime").value = exp.datetime.replace(" ", "T").slice(0, 16);

    setText("formTitle", "Edit Expense");
    setText("submitBtnText", "Update Expense");

    navigate("add");
  } catch (err) {
    showToast("Could not load expense", "error");
  }
}

function resetForm() {
  ["fId","fTitle","fAmount","fCategory","fLocation","fReason"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  setCurrentDatetime();
  setText("formTitle", "Add Expense");
  setText("submitBtnText", "Save Expense");
}

function setCurrentDatetime() {
  const el = document.getElementById("fDatetime");
  if (el) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    el.value = now.toISOString().slice(0, 16);
  }
}

// ─────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────

let pendingDeleteId = null;

function confirmDelete(id) {
  pendingDeleteId = id;
  document.getElementById("modalOverlay").classList.add("open");
  document.getElementById("confirmDeleteBtn").onclick = doDelete;
}

async function doDelete() {
  if (!pendingDeleteId) return;
  try {
    const resp = await api(`/api/expenses/${pendingDeleteId}`, "DELETE");
    showToast("Expense deleted — amount refunded to balance", "success");
    if (resp.new_balance !== undefined) updateBalanceDisplay(resp.new_balance);
    closeModal();
    loadExpenses();
  } catch {
    showToast("Failed to delete", "error");
  }
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  pendingDeleteId = null;
}

// ─────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────

async function loadAnalytics() {
  try {
    const [dash, monthly] = await Promise.all([
      api("/api/dashboard"),
      api("/api/analytics/monthly")
    ]);

    // Monthly trend
    renderMonthlyChart(monthly);

    // Category bar (this month)
    renderCategoryBar(dash.categories);

    // Quick stats
    renderQuickStats(dash);

  } catch (err) {
    showToast("Could not load analytics", "error");
  }
}

function renderMonthlyChart(monthly) {
  const ctx = document.getElementById("monthlyChart").getContext("2d");
  if (monthlyChartInst) monthlyChartInst.destroy();

  const sorted = [...monthly].reverse();
  const labels = sorted.map(m => m.month);
  const values = sorted.map(m => m.total);

  monthlyChartInst = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Monthly Spending",
        data: values,
        borderColor: "#f0a500",
        backgroundColor: "rgba(240,165,0,0.08)",
        pointBackgroundColor: "#f0a500",
        pointRadius: 5,
        tension: 0.4,
        fill: true,
      }]
    },
    options: chartOptions("line")
  });
}

function renderCategoryBar(categories) {
  const ctx = document.getElementById("categoryBarChart").getContext("2d");
  if (categoryBarInst) categoryBarInst.destroy();

  const labels = categories.map(c => c.category);
  const values = categories.map(c => c.total);
  const colors = labels.map(l => CAT_COLORS[l] || "#8890aa");

  categoryBarInst = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "₹ This Month",
        data: values,
        backgroundColor: colors.map(c => c + "bb"),
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: chartOptions("bar")
  });
}

function renderQuickStats(dash) {
  const el = document.getElementById("quickStats");
  if (!el) return;

  el.innerHTML = `
    <div class="qs-item">
      <div class="qs-label">All-Time Total</div>
      <div class="qs-value">₹${fmt(dash.all_total)}</div>
    </div>
    <div class="qs-item">
      <div class="qs-label">This Month</div>
      <div class="qs-value">₹${fmt(dash.month_total)}</div>
    </div>
    <div class="qs-item">
      <div class="qs-label">Daily Average</div>
      <div class="qs-value">₹${fmt(dash.daily_avg)}</div>
    </div>
    <div class="qs-item">
      <div class="qs-label">Top Category</div>
      <div class="qs-value">${dash.top_category?.category || "—"}</div>
    </div>
  `;
}

// ─────────────────────────────────────────
// BUDGETS
// ─────────────────────────────────────────

async function saveBudget() {
  const cat = document.getElementById("bCategory").value;
  const limit = parseFloat(document.getElementById("bLimit").value);

  if (!cat || !limit || limit <= 0) {
    showToast("Please enter a valid budget amount", "error");
    return;
  }

  try {
    await api("/api/budgets", "POST", { category: cat, monthly_limit: limit });
    showToast(`Budget set for ${cat}`, "success");
    document.getElementById("bLimit").value = "";
    loadBudgets();
  } catch {
    showToast("Could not save budget", "error");
  }
}

async function loadBudgets() {
  try {
    const budgets = await api("/api/budgets");
    const el = document.getElementById("budgetCards");
    if (!el) return;

    if (!budgets.length) {
      el.innerHTML = `<p style="color:var(--text2);font-size:14px">No budgets set yet. Add one above.</p>`;
      return;
    }

    el.innerHTML = budgets.map(b => {
      const pct = Math.min((b.spent / b.monthly_limit) * 100, 100);
      const color = pct >= 100 ? "#e05c5c" : pct >= 80 ? "#ff9f43" : "#4caf78";
      const remaining = b.monthly_limit - b.spent;

      return `
        <div class="budget-card">
          <div class="bc-header">
            <span class="bc-cat">${CAT_EMOJI[b.category] || ""} ${b.category}</span>
            <span class="bc-limit">₹${fmt(b.monthly_limit)} limit</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <div class="bc-meta">
            <span>Spent: ₹${fmt(b.spent)}</span>
            <span style="color:${color}">${pct.toFixed(0)}%</span>
          </div>
          <div style="font-size:12px;color:${remaining >= 0 ? "var(--text2)" : "var(--red)"};margin-top:6px">
            ${remaining >= 0 ? `₹${fmt(remaining)} remaining` : `Over by ₹${fmt(Math.abs(remaining))}`}
          </div>
        </div>
      `;
    }).join("");

  } catch {
    showToast("Could not load budgets", "error");
  }
}

// ─────────────────────────────────────────
// EXPORT CSV
// ─────────────────────────────────────────

/** Download filtered expenses as CSV */
function exportExpensesCSV() {
  const params = buildFilterParams();
  window.location.href = `/api/export/csv?${params}`;
  showToast("⬇ Downloading expenses CSV…", "success");
}

/** Download income records as CSV (respects any active income filters) */
function exportIncomeCSV() {
  const params = buildIncomeFilterParams();
  window.location.href = `/api/export/income-csv?${params}`;
  showToast("⬇ Downloading income CSV…", "success");
}

/** Build query string from the income filter inputs (if on income page) */
function buildIncomeFilterParams() {
  const params = new URLSearchParams();
  // Income page doesn't have a dedicated filter bar yet —
  // export all records; extend here when you add income filters.
  return params.toString();
}

// ─────────────────────────────────────────
// BALANCE DISPLAY
// ─────────────────────────────────────────

/**
 * Update all balance display elements across the app.
 * Applies green/red color based on value.
 */
function updateBalanceDisplay(balance) {
  const els = ["balanceDisplay", "incomePageBalance"];
  els.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = `₹${fmt(balance)}`;
    el.classList.remove("positive", "negative", "zero", "balance-pulse");
    void el.offsetWidth; // force reflow for animation restart
    if (balance > 0)      el.classList.add("positive", "balance-pulse");
    else if (balance < 0) el.classList.add("negative", "balance-pulse");
    else                  el.classList.add("zero");
  });
}

// ─────────────────────────────────────────
// INCOME PAGE
// ─────────────────────────────────────────

async function loadIncomePage() {
  // Set today's date as default
  const dateEl = document.getElementById("iDate");
  if (dateEl && !dateEl.value) {
    dateEl.value = new Date().toISOString().slice(0, 10);
  }

  // Refresh balance display on this page
  try {
    const b = await api("/api/balance");
    updateBalanceDisplay(b.balance);
  } catch {}

  loadIncomeHistory();
}

async function submitIncome() {
  const amount = parseFloat(document.getElementById("iAmount").value);
  const date   = document.getElementById("iDate").value;
  const source = document.getElementById("iSource").value;
  const note   = document.getElementById("iNote").value.trim();

  if (!amount || amount <= 0) {
    showToast("Enter a valid amount", "error"); return;
  }
  if (!date) {
    showToast("Please select a date", "error"); return;
  }

  try {
    const resp = await api("/api/income", "POST", { amount, source, date, note });
    showToast(`₹${fmt(amount)} added to balance! ✓`, "success");
    updateBalanceDisplay(resp.new_balance);
    resetIncomeForm();
    loadIncomeHistory();
  } catch (err) {
    showToast("Failed to add income", "error");
  }
}

async function loadIncomeHistory() {
  const tbody = document.getElementById("incomeTableBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;

  try {
    const income = await api("/api/income");

    if (!income.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No income records yet.</td></tr>`;
      setText("incomeTotalBadge", "");
      return;
    }

    const total = income.reduce((s, i) => s + i.amount, 0);
    setText("incomeTotalBadge", `Total: ₹${fmt(total)}`);

    tbody.innerHTML = income.map(inc => `
      <tr>
        <td>${inc.date}</td>
        <td><span class="source-pill">${inc.source || "—"}</span></td>
        <td style="color:var(--text2)">${esc(inc.note || "—")}</td>
        <td class="align-right"><span class="amount-cell" style="color:#4caf78">+₹${fmt(inc.amount)}</span></td>
        <td class="align-center">
          <button class="btn-icon delete" onclick="deleteIncome(${inc.id})" title="Delete">✕</button>
        </td>
      </tr>
    `).join("");
  } catch {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>`;
  }
}

async function deleteIncome(id) {
  if (!confirm("Delete this income entry? The amount will be deducted from your balance.")) return;
  try {
    const resp = await api(`/api/income/${id}`, "DELETE");
    showToast("Income entry removed", "success");
    updateBalanceDisplay(resp.new_balance);
    loadIncomeHistory();
  } catch {
    showToast("Failed to delete income", "error");
  }
}

function resetIncomeForm() {
  document.getElementById("iAmount").value = "";
  document.getElementById("iSource").value = "";
  document.getElementById("iNote").value = "";
  const dateEl = document.getElementById("iDate");
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
}

// ─────────────────────────────────────────
// THEME TOGGLE
// ─────────────────────────────────────────

function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute("data-theme") === "dark";
  const newTheme = isDark ? "light" : "dark";
  html.setAttribute("data-theme", newTheme);
  localStorage.setItem("theme", newTheme);
  document.getElementById("themeIcon").textContent = isDark ? "☾" : "☀";
}

function applyStoredTheme() {
  const saved = localStorage.getItem("theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("themeIcon").textContent = saved === "dark" ? "☀" : "☾";
}

// ─────────────────────────────────────────
// MOBILE SIDEBAR
// ─────────────────────────────────────────

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("sidebarOverlay").classList.toggle("open");
}

function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarOverlay").classList.remove("open");
}

// ─────────────────────────────────────────
// CHART OPTIONS (shared defaults)
// ─────────────────────────────────────────

function chartOptions(type) {
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
  const textColor = isDark ? "#8890aa" : "#6666aa";

  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: isDark ? "#1a1d27" : "#fff",
        titleColor: isDark ? "#e8eaf2" : "#1a1a2e",
        bodyColor: isDark ? "#8890aa" : "#4a4a6a",
        borderColor: isDark ? "#2a2f47" : "#dcdcec",
        borderWidth: 1,
        callbacks: {
          label: ctx => ` ₹${fmt(ctx.raw)}`
        }
      }
    },
    scales: type === "bar" || type === "line" ? {
      x: {
        grid: { color: gridColor, drawBorder: false },
        ticks: { color: textColor, font: { size: 11, family: "DM Mono" } }
      },
      y: {
        grid: { color: gridColor, drawBorder: false },
        ticks: {
          color: textColor,
          font: { size: 11, family: "DM Mono" },
          callback: v => `₹${v >= 1000 ? (v/1000).toFixed(1)+"k" : v}`
        }
      }
    } : {}
  };
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/** Fetch wrapper with JSON — attaches parsed error body to thrown error */
async function api(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    try { err.data = await res.json(); } catch {}
    throw err;
  }
  return res.json();
}

/** Format number as Indian currency */
function fmt(n) {
  if (!n && n !== 0) return "0";
  const num = parseFloat(n);
  return num.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

/** Format ISO datetime to readable */
function fmtDate(dt) {
  if (!dt) return "—";
  const d = new Date(dt.replace(" ", "T"));
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtDateShort(d) {
  if (!d) return "";
  const dt = new Date(d);
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Escape HTML to prevent XSS */
function esc(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function updateDashDate() {
  const el = document.getElementById("dashDate");
  if (el) {
    el.textContent = new Date().toLocaleDateString("en-IN", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });
  }
}

/** Toast notification */
let toastTimer = null;
function showToast(msg, type = "success") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast ${type} show`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); }, 3500);
}

// ─────────────────────────────────────────
// FUTURE: VOICE COMMAND MODULE
// ─────────────────────────────────────────
/*
 * voiceModule — Stub for future voice integration
 *
 * To enable:
 * 1. Add a mic button to the Add Expense page
 * 2. Use the Web Speech API to capture audio
 * 3. POST transcript to /api/voice (to be implemented in app.py)
 * 4. Backend parses intent and returns structured expense data
 * 5. Pre-fill the form with the parsed data
 *
 * const voiceModule = {
 *   recognition: null,
 *
 *   start() {
 *     const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
 *     this.recognition = new SpeechRecognition();
 *     this.recognition.lang = 'en-IN';
 *     this.recognition.onresult = (e) => {
 *       const transcript = e.results[0][0].transcript;
 *       this.processTranscript(transcript);
 *     };
 *     this.recognition.start();
 *   },
 *
 *   async processTranscript(text) {
 *     const data = await api('/api/voice', 'POST', { text });
 *     // Pre-fill the expense form
 *     if (data.title)    document.getElementById('fTitle').value = data.title;
 *     if (data.amount)   document.getElementById('fAmount').value = data.amount;
 *     if (data.category) document.getElementById('fCategory').value = data.category;
 *   }
 * };
 */
