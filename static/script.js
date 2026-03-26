/**
 * script.js — GCP IAM Changelog timeline renderer
 *
 * Responsibilities:
 *   - Load data-latest.json (and paginated data-page-N.json files)
 *   - Render severity-coloured expandable entry cards
 *   - Client-side filtering: severity chips, dimension, date range, text search
 *   - Sync filter state to/from URL search params (shareable links)
 *   - Inter-page navigation (prev / next page data files)
 */

(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  const DATA_LATEST = "data-latest.json";
  const DATA_PAGE   = (n) => `data-page-${n}.json`;

  const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "INFO"];

  const DIMENSION_LABELS = {
    permissions:      "Permission",
    predefined_roles: "Role",
    role_permissions: "Role ↔ Perm",
    methods:          "API Method",
    method_map:       "Method Map",
    security_tags:    "Sec Tag",
  };

  const CHANGE_TYPE_LABELS = {
    added:                          "Added",
    removed:                        "Removed",
    deleted:                        "Deleted",
    permission_added_to_role:       "Permission → Role",
    permission_removed_from_role:   "Permission ← Role",
    mapping_added:                  "Mapping Added",
    mapping_removed:                "Mapping Removed",
    mapping_changed:                "Mapping Changed",
    tag_added:                      "Tag Added",
    tag_removed:                    "Tag Removed",
    new_service:                    "New Service",
    unmapped_method:                "Unmapped Method",
    sensitive_permission_in_broad_role: "⚠ Sensitive → Broad Role",
  };

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let allData    = null;   // current page payload from JSON
  let totalPages = 1;
  let currentPage = 1;

  const filters = {
    severities: new Set(["CRITICAL", "HIGH", "MEDIUM", "INFO"]),
    dimension: "",
    dateFrom: "",
    dateTo: "",
    text: "",
  };

  // -------------------------------------------------------------------------
  // DOM references (resolved once DOMContentLoaded fires)
  // -------------------------------------------------------------------------

  let $timeline, $loading, $error, $noResults,
      $lastUpdated, $pagination, $btnPrev, $btnNext, $pageInfo,
      $statTotal, $statCritical, $statHigh, $statMedium, $statInfo, $statServices;

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    $timeline    = document.getElementById("timeline");
    $loading     = document.getElementById("loading-indicator");
    $error       = document.getElementById("error-message");
    $noResults   = document.getElementById("no-results");
    $lastUpdated = document.getElementById("last-updated");
    $pagination  = document.getElementById("pagination");
    $btnPrev     = document.getElementById("btn-prev");
    $btnNext     = document.getElementById("btn-next");
    $pageInfo    = document.getElementById("page-info");
    $statTotal   = document.getElementById("stat-total");
    $statCritical = document.getElementById("stat-critical");
    $statHigh    = document.getElementById("stat-high");
    $statMedium  = document.getElementById("stat-medium");
    $statInfo    = document.getElementById("stat-info");
    $statServices = document.getElementById("stat-services");

    _restoreFiltersFromURL();
    _bindFilterEvents();
    _loadPage(1);
  });

  // -------------------------------------------------------------------------
  // Filter: bind events
  // -------------------------------------------------------------------------

  function _bindFilterEvents() {
    // Severity chips
    document.querySelectorAll(".chip[data-severity]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const sev = chip.dataset.severity;
        if (filters.severities.has(sev)) {
          filters.severities.delete(sev);
          chip.classList.remove("active");
          chip.setAttribute("aria-pressed", "false");
        } else {
          filters.severities.add(sev);
          chip.classList.add("active");
          chip.setAttribute("aria-pressed", "true");
        }
        _applyFiltersAndRender();
        _pushURL();
      });
    });

    // Dimension select
    document.getElementById("dimension-filter").addEventListener("change", (e) => {
      filters.dimension = e.target.value;
      _applyFiltersAndRender();
      _pushURL();
    });

    // Date range
    document.getElementById("date-from").addEventListener("change", (e) => {
      filters.dateFrom = e.target.value;
      _applyFiltersAndRender();
      _pushURL();
    });
    document.getElementById("date-to").addEventListener("change", (e) => {
      filters.dateTo = e.target.value;
      _applyFiltersAndRender();
      _pushURL();
    });

    // Text search (debounced)
    let searchTimer;
    document.getElementById("text-search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        filters.text = e.target.value.toLowerCase().trim();
        _applyFiltersAndRender();
        _pushURL();
      }, 250);
    });

    // Reset
    document.getElementById("reset-filters").addEventListener("click", () => {
      filters.severities = new Set(["CRITICAL", "HIGH", "MEDIUM", "INFO"]);
      filters.dimension = "";
      filters.dateFrom = "";
      filters.dateTo = "";
      filters.text = "";
      _syncFilterUI();
      _applyFiltersAndRender();
      _pushURL();
    });

    // Pagination
    $btnPrev.addEventListener("click", () => {
      if (currentPage > 1) _loadPage(currentPage - 1);
    });
    $btnNext.addEventListener("click", () => {
      if (currentPage < totalPages) _loadPage(currentPage + 1);
    });
  }

  // -------------------------------------------------------------------------
  // URL state
  // -------------------------------------------------------------------------

  function _pushURL() {
    const params = new URLSearchParams();
    const activeSevs = [...filters.severities];
    if (activeSevs.length < 4) params.set("sev", activeSevs.join(","));
    if (filters.dimension) params.set("dim", filters.dimension);
    if (filters.dateFrom)  params.set("from", filters.dateFrom);
    if (filters.dateTo)    params.set("to",   filters.dateTo);
    if (filters.text)      params.set("q",    filters.text);
    const qs = params.toString();
    const newURL = qs ? `${location.pathname}?${qs}` : location.pathname;
    history.replaceState(null, "", newURL);
  }

  function _restoreFiltersFromURL() {
    const params = new URLSearchParams(location.search);
    if (params.has("sev")) {
      filters.severities = new Set(params.get("sev").split(",").filter(Boolean));
    }
    if (params.has("dim")) filters.dimension = params.get("dim");
    if (params.has("from")) filters.dateFrom = params.get("from");
    if (params.has("to"))   filters.dateTo   = params.get("to");
    if (params.has("q"))    filters.text     = params.get("q").toLowerCase().trim();
  }

  function _syncFilterUI() {
    document.querySelectorAll(".chip[data-severity]").forEach((chip) => {
      const active = filters.severities.has(chip.dataset.severity);
      chip.classList.toggle("active", active);
      chip.setAttribute("aria-pressed", String(active));
    });
    const dimSel = document.getElementById("dimension-filter");
    if (dimSel) dimSel.value = filters.dimension;
    const fromInp = document.getElementById("date-from");
    if (fromInp) fromInp.value = filters.dateFrom;
    const toInp = document.getElementById("date-to");
    if (toInp) toInp.value = filters.dateTo;
    const searchInp = document.getElementById("text-search");
    if (searchInp) searchInp.value = filters.text;
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  async function _loadPage(pageNum) {
    _showLoading(true);
    const url = pageNum === 1 ? DATA_LATEST : DATA_PAGE(pageNum);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      allData = await resp.json();
      currentPage = allData.page || 1;
      totalPages  = allData.pages || 1;

      _syncFilterUI();
      _updateStats(allData.summary);
      _updateLastUpdated(allData.generated_at);
      _applyFiltersAndRender();
      _updatePagination();
    } catch (err) {
      _showError(`Failed to load changelog data: ${err.message}`);
    } finally {
      _showLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  function _matchesFilters(entry) {
    if (!filters.severities.has(entry.severity)) return false;
    if (filters.dimension && entry.dimension !== filters.dimension) return false;
    if (filters.dateFrom && entry.date < filters.dateFrom) return false;
    if (filters.dateTo   && entry.date > filters.dateTo)   return false;
    if (filters.text) {
      const haystack = [
        entry.permission, entry.role, entry.service, entry.method,
        entry.change_type, entry.dimension, entry.date,
        JSON.stringify(entry.details),
      ].join(" ").toLowerCase();
      if (!haystack.includes(filters.text)) return false;
    }
    return true;
  }

  function _applyFiltersAndRender() {
    if (!allData) return;
    const visible = allData.entries.filter(_matchesFilters);
    _updateChipCounts(allData.entries);
    _renderTimeline(visible);
  }

  function _updateChipCounts(entries) {
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: 0 };
    entries.forEach((e) => { if (counts[e.severity] !== undefined) counts[e.severity]++; });
    SEVERITY_ORDER.forEach((sev) => {
      const el = document.getElementById(`count-${sev}`);
      if (el) el.textContent = counts[sev];
    });
  }

  // -------------------------------------------------------------------------
  // Stats bar
  // -------------------------------------------------------------------------

  function _updateStats(summary) {
    if (!summary) return;
    const total = Object.values(summary.by_severity || {}).reduce((a, b) => a + b, 0);
    _setText($statTotal,    total);
    _setText($statCritical, summary.by_severity?.CRITICAL ?? 0);
    _setText($statHigh,     summary.by_severity?.HIGH ?? 0);
    _setText($statMedium,   summary.by_severity?.MEDIUM ?? 0);
    _setText($statInfo,     summary.by_severity?.INFO ?? 0);
    _setText($statServices, (summary.new_services || []).length);
  }

  function _updateLastUpdated(iso) {
    if (!$lastUpdated || !iso) return;
    try {
      const d = new Date(iso);
      $lastUpdated.textContent = `Updated: ${d.toUTCString()}`;
    } catch (_) {
      $lastUpdated.textContent = `Updated: ${iso}`;
    }
  }

  // -------------------------------------------------------------------------
  // Timeline rendering
  // -------------------------------------------------------------------------

  function _renderTimeline(entries) {
    $timeline.innerHTML = "";

    if (entries.length === 0) {
      $noResults.classList.remove("hidden");
      return;
    }
    $noResults.classList.add("hidden");

    const frag = document.createDocumentFragment();
    entries.forEach((entry) => {
      frag.appendChild(_buildCard(entry));
    });
    $timeline.appendChild(frag);
  }

  function _buildCard(entry) {
    const li = document.createElement("li");
    li.className = "entry-card";
    li.setAttribute("data-severity", entry.severity);

    const summary = document.createElement("div");
    summary.className = "entry-summary";
    summary.setAttribute("tabindex", "0");
    summary.setAttribute("role", "button");
    summary.setAttribute("aria-expanded", "false");

    // Expand icon
    const icon = document.createElement("span");
    icon.className = "entry-expand-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▶";

    // Severity badge
    const sevBadge = document.createElement("span");
    sevBadge.className = "badge-severity";
    sevBadge.textContent = entry.severity;

    // Dimension badge
    const dimBadge = document.createElement("span");
    dimBadge.className = "badge-dimension";
    dimBadge.textContent = DIMENSION_LABELS[entry.dimension] || entry.dimension;

    // Main text
    const mainText = document.createElement("span");
    mainText.className = "entry-main-text";
    mainText.textContent = _buildMainText(entry);
    mainText.title = mainText.textContent;

    // Tags
    const tagsWrap = document.createElement("span");
    tagsWrap.style.display = "flex";
    tagsWrap.style.gap = "0.3rem";
    tagsWrap.style.flexWrap = "wrap";
    (entry.tags || []).forEach((tag) => {
      const t = document.createElement("span");
      t.className = `tag-badge tag-${tag.replace(/\s+/g, "")}`;
      t.textContent = tag;
      tagsWrap.appendChild(t);
    });

    // Meta
    const meta = document.createElement("div");
    meta.className = "entry-meta";
    const dateEl = document.createElement("time");
    dateEl.className = "entry-date";
    dateEl.dateTime = entry.date;
    dateEl.textContent = entry.date;
    const commitEl = document.createElement("span");
    commitEl.className = "entry-commit";
    commitEl.textContent = entry.commit ? entry.commit.slice(0, 8) : "";
    meta.appendChild(dateEl);
    if (commitEl.textContent) meta.appendChild(commitEl);

    summary.appendChild(icon);
    summary.appendChild(sevBadge);
    summary.appendChild(dimBadge);
    summary.appendChild(mainText);
    summary.appendChild(tagsWrap);
    summary.appendChild(meta);

    // Details panel
    const details = document.createElement("div");
    details.className = "entry-details";
    details.innerHTML = _buildDetailsHTML(entry);

    li.appendChild(summary);
    li.appendChild(details);

    // Toggle expand
    function toggleExpand() {
      const expanded = li.classList.toggle("expanded");
      summary.setAttribute("aria-expanded", String(expanded));
      icon.textContent = expanded ? "▼" : "▶";
    }

    summary.addEventListener("click", toggleExpand);
    summary.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(); }
    });

    return li;
  }

  function _buildMainText(entry) {
    const changeLabel = CHANGE_TYPE_LABELS[entry.change_type] || entry.change_type;
    const parts = [changeLabel];
    if (entry.permission) parts.push(entry.permission);
    else if (entry.method) parts.push(entry.method);
    else if (entry.role)   parts.push(entry.role);
    else if (entry.service) parts.push(`[${entry.service}]`);
    if (entry.role && entry.permission) {
      // Already have perm, add role context
      parts.push(`→ ${entry.role}`);
    }
    return parts.join("  ");
  }

  function _buildDetailsHTML(entry) {
    const fields = [
      ["ID",          entry.id],
      ["Date",        entry.date],
      ["Commit",      entry.commit],
      ["Dimension",   entry.dimension],
      ["Change Type", entry.change_type],
      ["Severity",    entry.severity],
      entry.permission ? ["Permission", entry.permission]   : null,
      entry.role       ? ["Role",       entry.role]         : null,
      entry.service    ? ["Service",    entry.service]      : null,
      entry.method     ? ["Method",     entry.method]       : null,
      (entry.tags || []).length ? ["Tags", entry.tags.join(", ")] : null,
    ].filter(Boolean);

    let html = '<div class="detail-grid">';
    fields.forEach(([k, v]) => {
      html += `<div class="detail-row">
        <span class="detail-key">${_esc(k)}</span>
        <span class="detail-val">${_esc(String(v))}</span>
      </div>`;
    });
    html += "</div>";

    if (entry.details && Object.keys(entry.details).length) {
      html += `<div class="detail-raw">
        <pre>${_esc(JSON.stringify(entry.details, null, 2))}</pre>
      </div>`;
    }

    return html;
  }

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  function _updatePagination() {
    if (totalPages <= 1) {
      $pagination.hidden = true;
      return;
    }
    $pagination.hidden = false;
    $pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    $btnPrev.disabled = currentPage <= 1;
    $btnNext.disabled = currentPage >= totalPages;
  }

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------

  function _showLoading(show) {
    $loading.classList.toggle("hidden", !show);
  }

  function _showError(msg) {
    $error.textContent = msg;
    $error.classList.remove("hidden");
  }

  function _setText(el, val) {
    if (el) el.textContent = val;
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

})();
