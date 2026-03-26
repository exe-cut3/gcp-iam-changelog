"""
security_classifier.py - Severity classification for GCP IAM change entries.

Classification hierarchy (highest wins):
  CRITICAL  → permission in tags.json PrivEsc or CredentialExposure,
               OR permission name matches a CRITICAL_PATTERNS suffix,
               OR entry was already flagged CRITICAL by diff_engine (e.g. sensitive_permission_in_broad_role)
  HIGH      → permission in tags.json DataAccess,
               OR permission name matches HIGH_PATTERNS suffix,
               OR new service detected
  MEDIUM    → role/permission mapping change not classified above,
               OR unmapped method
  INFO      → everything else (new methods, map changes, structural changes)
"""

from __future__ import annotations

import fnmatch
import logging
from typing import Any

from diff_engine import ChangeEntry

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pattern lists
# ---------------------------------------------------------------------------

CRITICAL_PATTERNS = [
    ".setIamPolicy",
    ".actAs",
    ".signBlob",
    ".signJwt",
    ".getAccessToken",
    ".getOpenIdToken",
    ".implicitDelegation",
    ".createToken",
    ".escalate",
    ".bind",
]

HIGH_PATTERNS = [
    ".create",
    ".update",
    ".delete",
    ".exec",
    ".proxy",
    ".invoke",
    ".patch",
    ".insert",
]

# Dimensions that default to INFO if no permission name is available
INFO_DIMENSIONS = {"methods", "method_map"}

# Dimensions that start at MEDIUM before being potentially upgraded
MEDIUM_DIMENSIONS = {"role_permissions", "predefined_roles"}


# ---------------------------------------------------------------------------
# Tag-based classifier
# ---------------------------------------------------------------------------

class SecurityClassifier:
    """
    Classifies ChangeEntry objects using tags.json data plus pattern matching.

    Parameters
    ----------
    tags_data : dict
        Parsed tags.json from the iam-dataset (may be None).
    """

    def __init__(self, tags_data: dict[str, Any] | None = None) -> None:
        self._privesc: set[str] = set()
        self._credential_exposure: set[str] = set()
        self._data_access: set[str] = set()

        if tags_data:
            self._load_tags(tags_data)

    # ------------------------------------------------------------------
    # Tag loading
    # ------------------------------------------------------------------

    def _load_tags(self, tags_data: dict[str, Any]) -> None:
        """Populate internal sets from tags.json (handles nested or flat shapes)."""
        def _extract(data: dict, key: str) -> set[str]:
            result: set[str] = set()
            for namespace_or_tag, val in data.items():
                if isinstance(val, dict):
                    if key in val and isinstance(val[key], list):
                        result.update(val[key])
                elif namespace_or_tag == key and isinstance(val, list):
                    result.update(val)
            return result

        self._privesc = _extract(tags_data, "PrivEsc")
        self._credential_exposure = _extract(tags_data, "CredentialExposure")
        self._data_access = _extract(tags_data, "DataAccess")

        logger.debug(
            "Loaded tags: %d PrivEsc, %d CredentialExposure, %d DataAccess",
            len(self._privesc),
            len(self._credential_exposure),
            len(self._data_access),
        )

    # ------------------------------------------------------------------
    # Pattern matching helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _matches_patterns(name: str, patterns: list[str]) -> bool:
        """Return True if name ends with any of the given suffix patterns."""
        name_lower = name.lower()
        for pattern in patterns:
            if name_lower.endswith(pattern.lower()):
                return True
        return False

    def _is_in_tags(self, permission: str) -> tuple[bool, bool, bool]:
        """
        Return (is_privesc, is_credential_exposure, is_data_access).
        Handles wildcard entries such as '*.setIamPolicy'.
        """
        def _check(perm_set: set[str]) -> bool:
            if permission in perm_set:
                return True
            for entry in perm_set:
                if "*" in entry and fnmatch.fnmatch(permission, entry):
                    return True
            return False

        return _check(self._privesc), _check(self._credential_exposure), _check(self._data_access)

    # ------------------------------------------------------------------
    # Public classification
    # ------------------------------------------------------------------

    def classify(self, entry: ChangeEntry) -> ChangeEntry:
        """
        Assign severity and tags in-place (returns the same entry).

        Entries already marked CRITICAL by the diff engine are left unchanged.
        """
        # Pre-assigned by diff_engine (e.g. sensitive_permission_in_broad_role)
        if entry.severity == "CRITICAL":
            return entry

        perm = entry.permission or entry.method or ""

        if not perm:
            # Dimension-based fallback
            if entry.dimension in INFO_DIMENSIONS:
                entry.severity = "INFO"
            elif entry.dimension in MEDIUM_DIMENSIONS:
                entry.severity = "MEDIUM"
            elif entry.change_type == "new_service":
                entry.severity = "HIGH"
            else:
                entry.severity = "INFO"
            return entry

        # --- Tag-based classification ---
        is_privesc, is_cred, is_data = self._is_in_tags(perm)

        if is_privesc:
            entry.severity = "CRITICAL"
            if "PrivEsc" not in entry.tags:
                entry.tags.append("PrivEsc")
            return entry

        if is_cred:
            entry.severity = "CRITICAL"
            if "CredentialExposure" not in entry.tags:
                entry.tags.append("CredentialExposure")
            return entry

        # --- Pattern-based classification ---
        if self._matches_patterns(perm, CRITICAL_PATTERNS):
            entry.severity = "CRITICAL"
            return entry

        if is_data:
            entry.severity = "HIGH"
            if "DataAccess" not in entry.tags:
                entry.tags.append("DataAccess")
            return entry

        if self._matches_patterns(perm, HIGH_PATTERNS):
            entry.severity = "HIGH"
            return entry

        # --- Dimension-based fallback ---
        if entry.dimension in MEDIUM_DIMENSIONS:
            entry.severity = "MEDIUM"
        elif entry.dimension in INFO_DIMENSIONS:
            entry.severity = "INFO"
        else:
            entry.severity = "INFO"

        # security_tags dimension changes are at least MEDIUM
        if entry.dimension == "security_tags":
            if entry.severity == "INFO":
                entry.severity = "MEDIUM"

        return entry

    def classify_all(self, entries: list[ChangeEntry]) -> list[ChangeEntry]:
        """Classify a list of entries in-place and return them."""
        for entry in entries:
            self.classify(entry)
        return entries
