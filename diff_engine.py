"""
diff_engine.py - Multi-dimensional GCP IAM differ.

Processes pairs of consecutive git commits from the iam-dataset repository and
produces structured change records across six dimensions:
  1. permissions       (gcp/permissions.json)
  2. predefined_roles  (gcp/predefined_roles.json)
  3. role_permissions  (gcp/role_permissions.json)
  4. methods           (gcp/methods.json)
  5. method_map        (gcp/map.json)
  6. security_tags     (gcp/tags.json)
"""

from __future__ import annotations

import fnmatch
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import git

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ChangeEntry:
    date: str
    commit: str
    dimension: str
    change_type: str
    severity: str = "INFO"
    tags: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)
    # optional convenience fields (may be empty)
    permission: str = ""
    role: str = ""
    service: str = ""
    method: str = ""


# ---------------------------------------------------------------------------
# Helper: load JSON from a blob at a specific commit (returns None if absent)
# ---------------------------------------------------------------------------

def _load_json_at_commit(repo: git.Repo, commit: git.Commit, rel_path: str) -> Any | None:
    try:
        blob = commit.tree[rel_path]
        return json.loads(blob.data_stream.read())
    except (KeyError, json.JSONDecodeError) as exc:
        logger.debug("Could not load %s @ %s: %s", rel_path, commit.hexsha[:8], exc)
        return None


# ---------------------------------------------------------------------------
# Service prefix extraction
# ---------------------------------------------------------------------------

def _service_of(name: str) -> str:
    """Return the GCP service prefix for a dotted permission/method name."""
    return name.split(".")[0] if "." in name else name


# ---------------------------------------------------------------------------
# Dimension 1 – permissions.json
# ---------------------------------------------------------------------------

def _diff_permissions(
    prev: dict[str, Any] | None,
    curr: dict[str, Any] | None,
    date: str,
    sha: str,
) -> list[ChangeEntry]:
    if curr is None:
        return []
    prev = prev or {}
    entries: list[ChangeEntry] = []

    prev_keys = set(prev.keys())
    curr_keys = set(curr.keys())

    for perm in curr_keys - prev_keys:
        entries.append(ChangeEntry(
            date=date,
            commit=sha,
            dimension="permissions",
            change_type="added",
            permission=perm,
            service=_service_of(perm),
            details={"description": curr[perm].get("description", ""),
                     "stage": curr[perm].get("stage", "")},
        ))

    for perm in prev_keys - curr_keys:
        entries.append(ChangeEntry(
            date=date,
            commit=sha,
            dimension="permissions",
            change_type="removed",
            permission=perm,
            service=_service_of(perm),
            details={"description": prev[perm].get("description", ""),
                     "stage": prev[perm].get("stage", "")},
        ))

    return entries


# ---------------------------------------------------------------------------
# Dimension 2 – predefined_roles.json
# ---------------------------------------------------------------------------

def _index_roles(roles_list: list[dict]) -> dict[str, dict]:
    return {r["name"]: r for r in roles_list if "name" in r}


def _diff_predefined_roles(
    prev: list[dict] | None,
    curr: list[dict] | None,
    date: str,
    sha: str,
) -> list[ChangeEntry]:
    if curr is None:
        return []
    prev_idx = _index_roles(prev or [])
    curr_idx = _index_roles(curr)
    entries: list[ChangeEntry] = []

    for name, role in curr_idx.items():
        if name not in prev_idx:
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="predefined_roles",
                change_type="added",
                role=name,
                service=_service_of(name.lstrip("roles/")),
                details={"title": role.get("title", ""),
                         "description": role.get("description", ""),
                         "stage": role.get("stage", "")},
            ))
        else:
            prev_role = prev_idx[name]
            # Detect role marked deleted
            if role.get("deleted") and not prev_role.get("deleted"):
                entries.append(ChangeEntry(
                    date=date,
                    commit=sha,
                    dimension="predefined_roles",
                    change_type="deleted",
                    role=name,
                    service=_service_of(name.lstrip("roles/")),
                    details={"title": role.get("title", "")},
                ))

    for name in prev_idx.keys() - curr_idx.keys():
        entries.append(ChangeEntry(
            date=date,
            commit=sha,
            dimension="predefined_roles",
            change_type="removed",
            role=name,
            service=_service_of(name.lstrip("roles/")),
            details={"title": prev_idx[name].get("title", "")},
        ))

    return entries


# ---------------------------------------------------------------------------
# Dimension 3 – role_permissions.json
# ---------------------------------------------------------------------------

def _diff_role_permissions(
    prev: dict[str, Any] | None,
    curr: dict[str, Any] | None,
    date: str,
    sha: str,
) -> list[ChangeEntry]:
    """
    role_permissions.json structure:
      { "<permission>": { "roles": [ {"role": "...", "undocumented": bool}, ... ] } }
    """
    if curr is None:
        return []
    prev = prev or {}
    entries: list[ChangeEntry] = []

    all_perms = set(prev.keys()) | set(curr.keys())

    for perm in all_perms:
        prev_entry = prev.get(perm, {})
        curr_entry = curr.get(perm, {})

        prev_roles: dict[str, bool] = {
            r["role"]: r.get("undocumented", False)
            for r in prev_entry.get("roles", [])
            if "role" in r
        }
        curr_roles: dict[str, bool] = {
            r["role"]: r.get("undocumented", False)
            for r in curr_entry.get("roles", [])
            if "role" in r
        }

        for role in set(curr_roles) - set(prev_roles):
            undoc = curr_roles[role]
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="role_permissions",
                change_type="permission_added_to_role",
                permission=perm,
                role=role,
                service=_service_of(perm),
                details={"undocumented": undoc},
            ))

        for role in set(prev_roles) - set(curr_roles):
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="role_permissions",
                change_type="permission_removed_from_role",
                permission=perm,
                role=role,
                service=_service_of(perm),
                details={"was_undocumented": prev_roles[role]},
            ))

    return entries


# ---------------------------------------------------------------------------
# Dimension 4 – methods.json
# ---------------------------------------------------------------------------

def _flatten_methods(methods_data: dict[str, Any]) -> dict[str, set[str]]:
    """Return { service: {method1, method2, ...} }."""
    result: dict[str, set[str]] = {}
    for service, methods in methods_data.items():
        if isinstance(methods, dict):
            result[service] = set(methods.keys())
        elif isinstance(methods, list):
            result[service] = set(methods)
    return result


def _diff_methods(
    prev: dict[str, Any] | None,
    curr: dict[str, Any] | None,
    date: str,
    sha: str,
) -> list[ChangeEntry]:
    if curr is None:
        return []
    prev_flat = _flatten_methods(prev or {})
    curr_flat = _flatten_methods(curr)
    entries: list[ChangeEntry] = []

    all_services = set(prev_flat) | set(curr_flat)
    for service in all_services:
        prev_methods = prev_flat.get(service, set())
        curr_methods = curr_flat.get(service, set())

        for method in curr_methods - prev_methods:
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="methods",
                change_type="added",
                method=method,
                service=service,
                details={"service": service},
            ))

        for method in prev_methods - curr_methods:
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="methods",
                change_type="removed",
                method=method,
                service=service,
                details={"service": service},
            ))

    return entries


# ---------------------------------------------------------------------------
# Dimension 5 – map.json (method→permission mapping)
# ---------------------------------------------------------------------------

def _normalize_map_value(val: Any) -> set[str]:
    if val is None:
        return set()
    if isinstance(val, str):
        return {val}
    if isinstance(val, list):
        return set(val)
    return set()


def _diff_method_map(
    prev: dict[str, Any] | None,
    curr: dict[str, Any] | None,
    date: str,
    sha: str,
) -> list[ChangeEntry]:
    if curr is None:
        return []
    prev = prev or {}
    entries: list[ChangeEntry] = []

    all_methods = set(prev.keys()) | set(curr.keys())
    for method in all_methods:
        prev_perms = _normalize_map_value(prev.get(method))
        curr_perms = _normalize_map_value(curr.get(method))

        if method not in prev and method in curr:
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="method_map",
                change_type="mapping_added",
                method=method,
                service=_service_of(method),
                details={"permissions": sorted(curr_perms)},
            ))
        elif method in prev and method not in curr:
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="method_map",
                change_type="mapping_removed",
                method=method,
                service=_service_of(method),
                details={"permissions": sorted(prev_perms)},
            ))
        elif prev_perms != curr_perms:
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="method_map",
                change_type="mapping_changed",
                method=method,
                service=_service_of(method),
                details={
                    "added_permissions": sorted(curr_perms - prev_perms),
                    "removed_permissions": sorted(prev_perms - curr_perms),
                },
            ))

    return entries


# ---------------------------------------------------------------------------
# Dimension 6 – tags.json (security classification changes)
# ---------------------------------------------------------------------------

def _flatten_tags(tags_data: dict[str, Any]) -> dict[str, set[str]]:
    """
    tags.json can be shaped as:
      { "iam": { "PrivEsc": [...], "CredentialExposure": [...], ... } }
    OR flat:
      { "PrivEsc": [...], "CredentialExposure": [...] }

    Returns { tag_name: {perm, ...} }.
    """
    flat: dict[str, set[str]] = {}
    for key, val in tags_data.items():
        if isinstance(val, dict):
            # nested namespace
            for tag, perms in val.items():
                if isinstance(perms, list):
                    flat.setdefault(tag, set()).update(perms)
        elif isinstance(val, list):
            flat.setdefault(key, set()).update(val)
    return flat


def _diff_security_tags(
    prev: dict[str, Any] | None,
    curr: dict[str, Any] | None,
    date: str,
    sha: str,
) -> list[ChangeEntry]:
    if curr is None:
        return []
    prev_flat = _flatten_tags(prev or {})
    curr_flat = _flatten_tags(curr)
    entries: list[ChangeEntry] = []

    all_tags = set(prev_flat) | set(curr_flat)
    for tag in all_tags:
        prev_perms = prev_flat.get(tag, set())
        curr_perms = curr_flat.get(tag, set())

        for perm in curr_perms - prev_perms:
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="security_tags",
                change_type="tag_added",
                permission=perm,
                service=_service_of(perm),
                tags=[tag],
                details={"tag": tag},
            ))

        for perm in prev_perms - curr_perms:
            entries.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="security_tags",
                change_type="tag_removed",
                permission=perm,
                service=_service_of(perm),
                tags=[tag],
                details={"tag": tag},
            ))

    return entries


# ---------------------------------------------------------------------------
# Special detections
# ---------------------------------------------------------------------------

BROAD_ROLES = {"roles/editor", "roles/viewer", "roles/owner"}


def _detect_special(
    prev_data: dict[str, Any],
    curr_data: dict[str, Any],
    tag_perms: set[str],
    entries: list[ChangeEntry],
    date: str,
    sha: str,
) -> list[ChangeEntry]:
    """Detect cross-cutting signals: unmapped methods, new services, sensitive broad-role grants."""
    specials: list[ChangeEntry] = []

    # --- Unmapped methods ---
    curr_methods = curr_data.get("methods") or {}
    curr_map = curr_data.get("map") or {}
    prev_methods = prev_data.get("methods") or {}
    prev_map = prev_data.get("map") or {}

    curr_all_methods: set[str] = set()
    for svc, methods in curr_methods.items():
        if isinstance(methods, dict):
            curr_all_methods.update(
                f"{svc}.{m}" if not m.startswith(svc) else m
                for m in methods.keys()
            )
        elif isinstance(methods, list):
            curr_all_methods.update(methods)

    prev_all_methods: set[str] = set()
    for svc, methods in prev_methods.items():
        if isinstance(methods, dict):
            prev_all_methods.update(
                f"{svc}.{m}" if not m.startswith(svc) else m
                for m in methods.keys()
            )
        elif isinstance(methods, list):
            prev_all_methods.update(methods)

    new_methods = curr_all_methods - prev_all_methods
    for method in new_methods:
        if method not in curr_map:
            specials.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="method_map",
                change_type="unmapped_method",
                method=method,
                service=_service_of(method),
                severity="MEDIUM",
                details={"note": "New method has no permission mapping"},
            ))

    # --- New services ---
    curr_perms = curr_data.get("permissions") or {}
    prev_perms = prev_data.get("permissions") or {}
    prev_services = {_service_of(p) for p in prev_perms} | set(prev_methods.keys())
    curr_services = {_service_of(p) for p in curr_perms} | set(curr_methods.keys())
    for svc in curr_services - prev_services:
        specials.append(ChangeEntry(
            date=date,
            commit=sha,
            dimension="permissions",
            change_type="new_service",
            service=svc,
            severity="HIGH",
            details={"service": svc},
        ))

    # --- Sensitive permission added to broad role ---
    for entry in entries:
        if (
            entry.dimension == "role_permissions"
            and entry.change_type == "permission_added_to_role"
            and entry.role in BROAD_ROLES
            and entry.permission in tag_perms
        ):
            specials.append(ChangeEntry(
                date=date,
                commit=sha,
                dimension="role_permissions",
                change_type="sensitive_permission_in_broad_role",
                permission=entry.permission,
                role=entry.role,
                service=entry.service,
                severity="CRITICAL",
                tags=entry.tags,
                details={
                    "note": f"Sensitive permission granted to {entry.role}",
                    "undocumented": entry.details.get("undocumented", False),
                },
            ))

    return specials


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

GCP_FILES = {
    "permissions": "gcp/permissions.json",
    "predefined_roles": "gcp/predefined_roles.json",
    "role_permissions": "gcp/role_permissions.json",
    "methods": "gcp/methods.json",
    "map": "gcp/map.json",
    "tags": "gcp/tags.json",
}


def diff_commits(
    repo: git.Repo,
    prev_commit: git.Commit,
    curr_commit: git.Commit,
    date: str,
) -> list[ChangeEntry]:
    """Return all change entries between two consecutive commits."""
    sha = curr_commit.hexsha[:12]

    prev_data: dict[str, Any] = {}
    curr_data: dict[str, Any] = {}
    for key, path in GCP_FILES.items():
        prev_data[key] = _load_json_at_commit(repo, prev_commit, path)
        curr_data[key] = _load_json_at_commit(repo, curr_commit, path)

    entries: list[ChangeEntry] = []
    entries += _diff_permissions(prev_data["permissions"], curr_data["permissions"], date, sha)
    entries += _diff_predefined_roles(prev_data["predefined_roles"], curr_data["predefined_roles"], date, sha)
    entries += _diff_role_permissions(prev_data["role_permissions"], curr_data["role_permissions"], date, sha)
    entries += _diff_methods(prev_data["methods"], curr_data["methods"], date, sha)
    entries += _diff_method_map(prev_data["map"], curr_data["map"], date, sha)
    entries += _diff_security_tags(prev_data["tags"], curr_data["tags"], date, sha)

    # Build set of all security-tagged permissions for special detection
    tag_flat = _flatten_tags(curr_data.get("tags") or {})
    all_tag_perms: set[str] = set()
    for perms in tag_flat.values():
        all_tag_perms.update(perms)

    entries += _detect_special(prev_data, curr_data, all_tag_perms, entries, date, sha)

    return entries
