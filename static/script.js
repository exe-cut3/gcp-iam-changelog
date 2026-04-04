/**
 * script.js — GCP IAM Changelog timeline renderer (v2)
 *
 * Loads ALL data pages at startup, merges entries, then performs
 * 100% client-side filtering, pagination, and search with highlighting.
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

  const DEBOUNCE_MS  = 200;
  const DEFAULT_PER_PAGE = 50;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let allEntries      = [];   // every entry across all pages
  let filteredEntries = [];   // after applying filters
  let generatedAt     = "";

  let currentPage = 1;
  let perPage     = DEFAULT_PER_PAGE;

  const filters = {
    severities: new Set(SEVERITY_ORDER),
    dimension: "",
    dateFrom: "",
    dateTo: "",
    text: "",
  };

  // -------------------------------------------------------------------------
  // DOM refs (resolved on DOMContentLoaded)
  // -------------------------------------------------------------------------

  let $overlay, $progressBar, $loadingStatus,
      $timeline, $error, $noResults, $lastUpdated,
      $pagination, $paginationInfo, $pageNumbers,
      $btnFirst, $btnPrev, $btnNext, $btnLast,
      $perPageSelect, $jumpInput, $btnGo,
      $statTotal, $statCritical, $statHigh, $statMedium, $statInfo, $statServices,
      $activeFilters, $filterTags, $btnClearAll, $searchCount,
      $btnExport;

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    $overlay       = document.getElementById("loading-overlay");
    $progressBar   = document.getElementById("progress-bar");
    $loadingStatus = document.getElementById("loading-status");
    $timeline      = document.getElementById("timeline");
    $error         = document.getElementById("error-message");
    $noResults     = document.getElementById("no-results");
    $lastUpdated   = document.getElementById("last-updated");
    $pagination    = document.getElementById("pagination");
    $paginationInfo = document.getElementById("pagination-info");
    $pageNumbers   = document.getElementById("page-numbers");
    $btnFirst      = document.getElementById("btn-first");
    $btnPrev       = document.getElementById("btn-prev");
    $btnNext       = document.getElementById("btn-next");
    $btnLast       = document.getElementById("btn-last");
    $perPageSelect = document.getElementById("per-page-select");
    $jumpInput     = document.getElementById("jump-page-input");
    $btnGo         = document.getElementById("btn-go");
    $statTotal     = document.getElementById("stat-total");
    $statCritical  = document.getElementById("stat-critical");
    $statHigh      = document.getElementById("stat-high");
    $statMedium    = document.getElementById("stat-medium");
    $statInfo      = document.getElementById("stat-info");
    $statServices  = document.getElementById("stat-services");
    $activeFilters = document.getElementById("active-filters");
    $filterTags    = document.getElementById("filter-tags");
    $btnClearAll   = document.getElementById("btn-clear-all");
    $searchCount   = document.getElementById("search-count");
    $btnExport     = document.getElementById("btn-export");

    _restoreFiltersFromURL();
    _syncFilterUI();
    _bindFilterEvents();
    _bindKeyboardShortcuts();
    _loadAllData();
  });

  // -------------------------------------------------------------------------
  // Data loading — fetch ALL pages in parallel
  // -------------------------------------------------------------------------

  async function _loadAllData() {
    try {
      _setProgress(0, "Loading page 1…");
      const firstResp = await fetch(DATA_LATEST);
      if (!firstResp.ok) throw new Error(`HTTP ${firstResp.status}: ${firstResp.statusText}`);
      const firstData = await firstResp.json();

      const totalPages = firstData.pages || 1;
      generatedAt = firstData.generated_at;

      allEntries = firstData.entries.slice();
      _setProgress((1 / totalPages) * 100, `Loading page 1 of ${totalPages}…`);

      if (totalPages > 1) {
        const remaining = [];
        for (let i = 2; i <= totalPages; i++) {
          remaining.push(
            fetch(DATA_PAGE(i)).then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status} for page ${i}`);
              return r.json();
            })
          );
        }

        let loaded = 1;
        const results = await Promise.all(
          remaining.map((p) =>
            p.then((data) => {
              loaded++;
              _setProgress((loaded / totalPages) * 100,
                `Loading page ${loaded} of ${totalPages}…`);
              return data;
            })
          )
        );

        results.sort((a, b) => (a.page || 0) - (b.page || 0));
        for (const pageData of results) {
          allEntries = allEntries.concat(pageData.entries);
        }
      }

      _setProgress(100, `Loaded ${allEntries.length} entries`);
      _updateLastUpdated(generatedAt);

      setTimeout(() => {
        $overlay.classList.add("fade-out");
        setTimeout(() => { $overlay.classList.add("hidden"); }, 300);
      }, 200);

      _applyFiltersAndRender();

    } catch (err) {
      $overlay.classList.add("hidden");
      _showError(`Failed to load changelog data: ${err.message}`);
    }
  }

  function _setProgress(pct, msg) {
    if ($progressBar) $progressBar.style.width = Math.min(pct, 100) + "%";
    if ($loadingStatus) $loadingStatus.textContent = msg;
  }

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
        _onFilterChange();
      });
    });

    // Dimension select
    document.getElementById("dimension-filter").addEventListener("change", (e) => {
      filters.dimension = e.target.value;
      _onFilterChange();
    });

    // Date range
    document.getElementById("date-from").addEventListener("change", (e) => {
      filters.dateFrom = e.target.value;
      _clearActivePreset();
      _onFilterChange();
    });
    document.getElementById("date-to").addEventListener("change", (e) => {
      filters.dateTo = e.target.value;
      _clearActivePreset();
      _onFilterChange();
    });

    // Date preset buttons
    document.querySelectorAll(".btn-preset[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset;
        const today = new Date();
        const toDate = today.toISOString().split("T")[0];
        const fromDate = new Date(today);

        switch (preset) {
          case "7d":   fromDate.setDate(fromDate.getDate() - 7);          break;
          case "30d":  fromDate.setDate(fromDate.getDate() - 30);         break;
          case "90d":  fromDate.setDate(fromDate.getDate() - 90);         break;
          case "365d": fromDate.setFullYear(fromDate.getFullYear() - 1);  break;
        }

        filters.dateFrom = fromDate.toISOString().split("T")[0];
        filters.dateTo   = toDate;

        _clearActivePreset();
        btn.classList.add("active");
        btn.setAttribute("aria-pressed", "true");
        document.getElementById("date-from").value = filters.dateFrom;
        document.getElementById("date-to").value   = filters.dateTo;

        _onFilterChange();
      });
    });

    // Text search (debounced)
    let searchTimer;
    document.getElementById("text-search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        filters.text = e.target.value.toLowerCase().trim();
        _onFilterChange();
      }, DEBOUNCE_MS);
    });

    // Reset buttons
    document.getElementById("btn-reset-empty").addEventListener("click", _resetAllFilters);
    $btnClearAll.addEventListener("click", _resetAllFilters);

    // Pagination buttons
    $btnFirst.addEventListener("click", () => { _goToPage(1); });
    $btnPrev.addEventListener("click", () => { _goToPage(currentPage - 1); });
    $btnNext.addEventListener("click", () => { _goToPage(currentPage + 1); });
    $btnLast.addEventListener("click", () => { _goToPage(_totalPages()); });

    // Per-page selector
    $perPageSelect.addEventListener("change", (e) => {
      perPage = parseInt(e.target.value, 10) || DEFAULT_PER_PAGE;
      currentPage = 1;
      _pushURL();
      _applyFiltersAndRender();
    });

    // Jump to page
    $btnGo.addEventListener("click", _jumpToPage);
    $jumpInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") _jumpToPage();
    });

    // Export JSON
    $btnExport.addEventListener("click", _exportFilteredJSON);
  }

  function _jumpToPage() {
    const val = parseInt($jumpInput.value, 10);
    if (val && val >= 1 && val <= _totalPages()) {
      _goToPage(val);
      $jumpInput.value = "";
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  function _bindKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      const isInput = tag === "input" || tag === "textarea" || tag === "select";

      if (e.key === "Escape") {
        const searchEl = document.getElementById("text-search");
        if (searchEl && searchEl.value) {
          searchEl.value = "";
          filters.text = "";
          _onFilterChange();
          searchEl.blur();
          e.preventDefault();
        }
        return;
      }

      if (isInput) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (currentPage > 1) _goToPage(currentPage - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (currentPage < _totalPages()) _goToPage(currentPage + 1);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Filter change helpers
  // -------------------------------------------------------------------------

  function _onFilterChange() {
    currentPage = 1;
    _pushURL();
    _applyFiltersAndRender();
  }

  function _resetAllFilters() {
    filters.severities = new Set(SEVERITY_ORDER);
    filters.dimension = "";
    filters.dateFrom = "";
    filters.dateTo = "";
    filters.text = "";
    currentPage = 1;
    _clearActivePreset();
    _syncFilterUI();
    _pushURL();
    _applyFiltersAndRender();
  }

  function _clearActivePreset() {
    document.querySelectorAll(".btn-preset[data-preset]").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-pressed", "false");
    });
  }

  // -------------------------------------------------------------------------
  // URL state
  // -------------------------------------------------------------------------

  function _pushURL() {
    const params = new URLSearchParams();
    const activeSevs = Array.from(filters.severities);
    if (activeSevs.length < 4) params.set("sev", activeSevs.join(","));
    if (filters.dimension)     params.set("dim", filters.dimension);
    if (filters.dateFrom)      params.set("from", filters.dateFrom);
    if (filters.dateTo)        params.set("to", filters.dateTo);
    if (filters.text)          params.set("q", filters.text);
    if (currentPage > 1)       params.set("page", String(currentPage));
    if (perPage !== DEFAULT_PER_PAGE) params.set("perPage", String(perPage));
    const qs = params.toString();
    const newURL = qs ? `${location.pathname}?${qs}` : location.pathname;
    history.replaceState(null, "", newURL);
  }

  function _restoreFiltersFromURL() {
    const params = new URLSearchParams(location.search);
    if (params.has("sev")) {
      filters.severities = new Set(params.get("sev").split(",").filter(Boolean));
    }
    if (params.has("dim"))  filters.dimension = params.get("dim");
    if (params.has("from")) filters.dateFrom  = params.get("from");
    if (params.has("to"))   filters.dateTo    = params.get("to");
    if (params.has("q"))    filters.text      = params.get("q").toLowerCase().trim();
    if (params.has("page")) {
      const p = parseInt(params.get("page"), 10);
      if (p > 0) currentPage = p;
    }
    if (params.has("perPage")) {
      const pp = parseInt(params.get("perPage"), 10);
      if ([25, 50, 100].includes(pp)) perPage = pp;
    }
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
    if ($perPageSelect) $perPageSelect.value = String(perPage);
    _clearActivePreset();
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

  /** Match filters except severity — used to compute chip counts */
  function _matchesNonSeverityFilters(entry) {
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
    if (!allEntries.length) return;

    filteredEntries = allEntries.filter(_matchesFilters);

    // Clamp page
    const tp = _totalPages();
    if (currentPage > tp) currentPage = Math.max(1, tp);

    _updateChipCounts();
    _updateStats();
    _updateSearchCount();
    _updateActiveFilterTags();
    _renderTimeline();
    _updatePagination();
  }

  // -------------------------------------------------------------------------
  // Chip counts — count per severity across non-severity filters
  // -------------------------------------------------------------------------

  function _updateChipCounts() {
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: 0 };
    for (let i = 0; i < allEntries.length; i++) {
      const e = allEntries[i];
      if (_matchesNonSeverityFilters(e) && counts[e.severity] !== undefined) {
        counts[e.severity]++;
      }
    }
    SEVERITY_ORDER.forEach((sev) => {
      const el = document.getElementById(`count-${sev}`);
      if (el) el.textContent = counts[sev];
    });
  }

  // -------------------------------------------------------------------------
  // Stats bar — reflects filtered data
  // -------------------------------------------------------------------------

  function _updateStats() {
    const bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: 0 };
    const services = new Set();
    for (let i = 0; i < filteredEntries.length; i++) {
      const e = filteredEntries[i];
      if (bySev[e.severity] !== undefined) bySev[e.severity]++;
      if (e.change_type === "new_service" && e.service) services.add(e.service);
    }
    _setText($statTotal,    filteredEntries.length);
    _setText($statCritical, bySev.CRITICAL);
    _setText($statHigh,     bySev.HIGH);
    _setText($statMedium,   bySev.MEDIUM);
    _setText($statInfo,     bySev.INFO);
    _setText($statServices, services.size);
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
  // Search count
  // -------------------------------------------------------------------------

  function _updateSearchCount() {
    if (!$searchCount) return;
    $searchCount.textContent = filters.text
      ? `${filteredEntries.length} found`
      : "";
  }

  // -------------------------------------------------------------------------
  // Active filter tags
  // -------------------------------------------------------------------------

  function _updateActiveFilterTags() {
    const tags = [];

    // Severity — show tags for selected severities when not all are selected
    const deselected = SEVERITY_ORDER.filter((s) => !filters.severities.has(s));
    if (deselected.length > 0 && deselected.length < 4) {
      const selected = SEVERITY_ORDER.filter((s) => filters.severities.has(s));
      selected.forEach((s) => {
        tags.push({ label: "Severity", value: s, remove: () => {
          filters.severities.delete(s);
          _syncFilterUI();
          _onFilterChange();
        }});
      });
    } else if (deselected.length === 4) {
      tags.push({ label: "Severity", value: "None selected", remove: () => {
        filters.severities = new Set(SEVERITY_ORDER);
        _syncFilterUI();
        _onFilterChange();
      }});
    }

    if (filters.dimension) {
      const dimLabel = DIMENSION_LABELS[filters.dimension] || filters.dimension;
      tags.push({ label: "Dimension", value: dimLabel, remove: () => {
        filters.dimension = "";
        _syncFilterUI();
        _onFilterChange();
      }});
    }

    if (filters.dateFrom || filters.dateTo) {
      const dateVal = `${filters.dateFrom || "…"} → ${filters.dateTo || "…"}`;
      tags.push({ label: "Date", value: dateVal, remove: () => {
        filters.dateFrom = "";
        filters.dateTo = "";
        _clearActivePreset();
        _syncFilterUI();
        _onFilterChange();
      }});
    }

    if (filters.text) {
      tags.push({ label: "Search", value: filters.text, remove: () => {
        filters.text = "";
        _syncFilterUI();
        _onFilterChange();
      }});
    }

    // Render tags
    $filterTags.innerHTML = "";
    tags.forEach((t) => {
      const tag = document.createElement("span");
      tag.className = "filter-tag";

      const lbl = document.createElement("span");
      lbl.className = "filter-tag-label";
      lbl.textContent = `${t.label}:`;

      const val = document.createElement("span");
      val.textContent = ` ${t.value}`;

      const btn = document.createElement("button");
      btn.className = "filter-tag-remove";
      btn.setAttribute("aria-label", `Remove ${t.label} filter`);
      btn.textContent = "×";
      btn.addEventListener("click", t.remove);

      tag.appendChild(lbl);
      tag.appendChild(val);
      tag.appendChild(btn);
      $filterTags.appendChild(tag);
    });

    if (tags.length > 0) {
      $activeFilters.classList.remove("hidden");
    } else {
      $activeFilters.classList.add("hidden");
    }
  }

  // -------------------------------------------------------------------------
  // Timeline rendering
  // -------------------------------------------------------------------------

  function _renderTimeline() {
    $timeline.innerHTML = "";

    if (filteredEntries.length === 0) {
      $noResults.classList.remove("hidden");
      return;
    }
    $noResults.classList.add("hidden");

    const start = (currentPage - 1) * perPage;
    const end   = Math.min(start + perPage, filteredEntries.length);
    const pageEntries = filteredEntries.slice(start, end);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < pageEntries.length; i++) {
      frag.appendChild(_buildCard(pageEntries[i]));
    }
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

    // Main text (with possible highlight)
    const mainText = document.createElement("span");
    mainText.className = "entry-main-text";
    const mainTextStr = _buildMainText(entry);
    if (filters.text) {
      mainText.innerHTML = _highlightText(mainTextStr, filters.text);
    } else {
      mainText.textContent = mainTextStr;
    }
    mainText.title = mainTextStr;

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
    const toggleExpand = () => {
      const expanded = li.classList.toggle("expanded");
      summary.setAttribute("aria-expanded", String(expanded));
      icon.textContent = expanded ? "▼" : "▶";
    };

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
    ];
    if (entry.permission) fields.push(["Permission", entry.permission]);
    if (entry.role)       fields.push(["Role",       entry.role]);
    if (entry.service)    fields.push(["Service",    entry.service]);
    if (entry.method)     fields.push(["Method",     entry.method]);
    if ((entry.tags || []).length) fields.push(["Tags", entry.tags.join(", ")]);

    let html = '<div class="detail-grid">';
    for (let i = 0; i < fields.length; i++) {
      const k = fields[i][0];
      const v = String(fields[i][1]);
      if (filters.text) {
        html += `<div class="detail-row">` +
          `<span class="detail-key">${_esc(k)}</span>` +
          `<span class="detail-val">${_highlightText(v, filters.text)}</span>` +
          `</div>`;
      } else {
        html += `<div class="detail-row">` +
          `<span class="detail-key">${_esc(k)}</span>` +
          `<span class="detail-val">${_esc(v)}</span>` +
          `</div>`;
      }
    }
    html += "</div>";

    if (entry.details && Object.keys(entry.details).length) {
      html += `<div class="detail-raw">` +
        `<pre>${_esc(JSON.stringify(entry.details, null, 2))}</pre>` +
        `</div>`;
    }

    return html;
  }

  // -------------------------------------------------------------------------
  // Search highlighting
  // -------------------------------------------------------------------------

  function _highlightText(text, query) {
    if (!query) return _esc(text);
    const escaped = _esc(text);
    const escapedQuery = _esc(query);
    const re = new RegExp(`(${_escRegex(escapedQuery)})`, "gi");
    return escaped.replace(re, "<mark>$1</mark>");
  }

  function _escRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  function _totalPages() {
    return Math.max(1, Math.ceil(filteredEntries.length / perPage));
  }

  function _goToPage(page) {
    const tp = _totalPages();
    page = Math.max(1, Math.min(page, tp));
    if (page === currentPage) return;
    currentPage = page;
    _pushURL();
    _renderTimeline();
    _updatePagination();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function _updatePagination() {
    const tp = _totalPages();
    if (tp <= 1 && filteredEntries.length === 0) {
      $pagination.hidden = true;
      return;
    }
    $pagination.hidden = false;

    // "Showing X–Y of Z results"
    const start = (currentPage - 1) * perPage + 1;
    const end   = Math.min(currentPage * perPage, filteredEntries.length);
    if (filteredEntries.length === 0) {
      $paginationInfo.textContent = "0 results";
    } else {
      $paginationInfo.textContent = `Showing ${start}–${end} of ${filteredEntries.length} results`;
    }

    $btnFirst.disabled = currentPage <= 1;
    $btnPrev.disabled  = currentPage <= 1;
    $btnNext.disabled  = currentPage >= tp;
    $btnLast.disabled  = currentPage >= tp;

    $jumpInput.max = tp;

    _renderPageNumbers(tp);
  }

  function _renderPageNumbers(tp) {
    $pageNumbers.innerHTML = "";

    if (tp <= 1) return;

    // Build set of page numbers to display
    const pages = new Set([1, tp]);
    for (let i = currentPage - 2; i <= currentPage + 2; i++) {
      if (i > 1 && i < tp) pages.add(i);
    }

    const sorted = Array.from(pages).sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    let prevNum = 0;

    for (const num of sorted) {
      if (num - prevNum > 1) {
        const ell = document.createElement("span");
        ell.className = "page-ellipsis";
        ell.textContent = "…";
        ell.setAttribute("aria-hidden", "true");
        frag.appendChild(ell);
      }

      const btn = document.createElement("button");
      btn.className = `btn-page${num === currentPage ? " active" : ""}`;
      btn.textContent = num;
      btn.setAttribute("aria-label", `Page ${num}`);
      if (num === currentPage) {
        btn.setAttribute("aria-current", "page");
      }
      btn.addEventListener("click", () => { _goToPage(num); });
      frag.appendChild(btn);
      prevNum = num;
    }

    $pageNumbers.appendChild(frag);
  }

  // -------------------------------------------------------------------------
  // Export filtered results as JSON
  // -------------------------------------------------------------------------

  function _exportFilteredJSON() {
    if (!filteredEntries.length) return;

    const activeFilters = {};
    const activeSevs = Array.from(filters.severities);
    if (activeSevs.length < SEVERITY_ORDER.length) {
      activeFilters.severities = activeSevs;
    }
    if (filters.dimension)  activeFilters.dimension = filters.dimension;
    if (filters.dateFrom)   activeFilters.date_from = filters.dateFrom;
    if (filters.dateTo)     activeFilters.date_to   = filters.dateTo;
    if (filters.text)       activeFilters.search    = filters.text;

    const exportData = {
      exported_at: new Date().toISOString(),
      source_generated_at: generatedAt,
      filters_applied: Object.keys(activeFilters).length > 0 ? activeFilters : "none",
      total_entries: filteredEntries.length,
      entries: filteredEntries,
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gcp-iam-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------

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
