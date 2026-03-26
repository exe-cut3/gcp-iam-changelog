# GCP IAM Changelog

Security-focused timeline and diff dashboard for GCP IAM permission changes, powered by [iann0036/iam-dataset](https://github.com/iann0036/iam-dataset).

The dashboard is automatically generated daily and published to **GitHub Pages**, giving security engineers and cloud architects a clear, filterable view of every permission, role, and API method change across all Google Cloud services.

---

## Features

- **Multi-dimensional diffing** across 6 IAM data sources (permissions, roles, role↔permission mappings, API methods, method→permission map, security tags)
- **Severity classification** — CRITICAL / HIGH / MEDIUM / INFO — combining `tags.json` data with pattern matching
- **Special detection** for privilege-escalation signals: sensitive permissions added to broad roles (`roles/editor`, `roles/viewer`), unmapped API methods, and brand-new GCP services
- **Interactive dashboard** with severity filter chips, dimension dropdown, date range, full-text search, and shareable URL state
- **Paginated JSON output** for fast page loads even with large data sets
- **Zero external dependencies** in the frontend (pure HTML/CSS/JS)
- **Automated daily workflow** via GitHub Actions

---

## Architecture

```
gcp-iam-changelog/
  ├── .github/workflows/
  │   └── changelog.yml           # daily cron: clone iam-dataset, diff, generate, deploy
  ├── diff_engine.py              # multi-dimensional differ (processes git history)
  ├── security_classifier.py      # classifies findings using tags.json + pattern matching
  ├── generate_changelog.py       # orchestrator: diff_engine + classifier → JSON output
  ├── static/
  │   ├── index.html              # single-page dashboard
  │   ├── script.js               # timeline renderer with filters, expandable cards
  │   └── style.css               # dark theme, security-oriented design
  ├── docs/                       # generated output (served by GitHub Pages)
  │   ├── index.html
  │   ├── data-latest.json
  │   └── data-page-N.json
  └── requirements.txt
```

---

## Data Source

All data is sourced from [`iann0036/iam-dataset`](https://github.com/iann0036/iam-dataset), which is updated daily by its own automated pipeline. The relevant files under `gcp/` are:

| File | Contents |
|---|---|
| `permissions.json` | All IAM permissions with descriptions and lifecycle stage |
| `predefined_roles.json` | All predefined roles (name, title, description, deleted flag) |
| `role_permissions.json` | Permission → roles mapping, including `undocumented` flag |
| `methods.json` | All API methods from the GCP Go SDK, grouped by service |
| `map.json` | Method → permission(s) required mapping |
| `tags.json` | Security classification: PrivEsc, CredentialExposure, DataAccess |

---

## Severity Classification

| Severity | Criteria |
|---|---|
| 🔴 **CRITICAL** | In `tags.json` PrivEsc or CredentialExposure; matches `.setIamPolicy`, `.actAs`, `.signBlob`, `.signJwt`, `.getAccessToken`, etc.; sensitive permission added to `roles/editor` or `roles/viewer` |
| 🟠 **HIGH** | In `tags.json` DataAccess; matches `.create`, `.update`, `.delete`, `.exec`, `.proxy`, `.invoke`; new GCP service detected |
| 🟡 **MEDIUM** | Role↔permission mapping changes not classified above; unmapped API methods |
| 🔵 **INFO** | New API methods, method map changes, structural changes |

---

## Setup & Usage

### Prerequisites

- Python 3.11+
- Git

### Local run

```bash
# 1. Clone this repository
git clone https://github.com/<your-org>/gcp-iam-changelog.git
cd gcp-iam-changelog

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Clone the upstream data source
git clone --depth=60 https://github.com/iann0036/iam-dataset.git

# 4. Generate the changelog (last 30 days, output to ./docs)
python generate_changelog.py \
  --dataset-path ./iam-dataset \
  --output-dir   ./docs \
  --days         30

# 5. Serve the dashboard locally
cd docs && python -m http.server 8080
# Open http://localhost:8080
```

### CLI options

```
python generate_changelog.py [options]

  --dataset-path PATH   Path to cloned iam-dataset repo  (default: ./iam-dataset)
  --output-dir   DIR    Directory for JSON output         (default: ./docs)
  --days         N      Days of history to process        (default: 30)
  --page-size    N      Entries per paginated output file (default: 100)
```

### GitHub Pages deployment

1. Fork or push this repository to GitHub
2. Go to **Settings → Pages** and set the source to the `docs/` folder on the `main` branch
3. The `changelog.yml` workflow runs daily at 16:00 UTC, generates new data, copies the static assets into `docs/`, and pushes the result
4. Enable **workflow permissions** (Settings → Actions → General → Workflow permissions → Read and write)

---

## Output Format

`docs/data-latest.json` (and `docs/data-page-N.json`) follow this schema:

```json
{
  "generated_at": "2024-01-15T16:00:00Z",
  "total_entries": 423,
  "pages": 5,
  "page": 1,
  "page_size": 100,
  "entries": [
    {
      "id": "2024-01-15-0001",
      "date": "2024-01-15",
      "commit": "abc123def456",
      "dimension": "permissions",
      "change_type": "added",
      "permission": "compute.instances.setLabels",
      "role": "",
      "service": "compute",
      "method": "",
      "severity": "INFO",
      "tags": [],
      "details": { "description": "...", "stage": "GA" }
    }
  ],
  "summary": {
    "by_severity": { "CRITICAL": 2, "HIGH": 5, "MEDIUM": 12, "INFO": 404 },
    "by_dimension": { "permissions": 100, "role_permissions": 20 },
    "new_services": ["newservice"]
  }
}
```

---

## Contributing

Pull requests are welcome. Please open an issue first to discuss significant changes.

When adding new pattern rules to `security_classifier.py`, include references to the GCP documentation or known attack techniques that justify the classification.

---

## License

MIT — see [LICENSE](LICENSE) if present, otherwise assume MIT.
