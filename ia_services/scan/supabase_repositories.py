"""
Implémentations Supabase (REST / PostgREST) des ports du classifieur.

- Sans dépendance externe : appels via `urllib` (stdlib). Le proxy TLS
  d'entreprise est déjà pris en charge par `truststore.inject_into_ssl()`
  appelé au démarrage de l'app (couvre le contexte SSL par défaut de stdlib).
- Tout est configurable par variables d'environnement (noms de tables /
  colonnes) pour coller à VOTRE schéma sans toucher au code.
- Dégradation gracieuse : si l'URL/clé manque ou qu'un appel échoue, on
  journalise et on renvoie vide/None -> l'app reste debout, le document part
  simplement en validation humaine.

Variables d'environnement
-------------------------
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY        (obligatoires pour un vrai accès)

Tiers :
  SCAN_TIERS_TABLE            (defaut "tiers")
  SCAN_TIERS_COL_ID           (defaut "id")
  SCAN_TIERS_COL_LIBELLE      (defaut "libelle")
  SCAN_TIERS_COL_PCM          (defaut "compte_pcm")
  SCAN_TIERS_COL_CATEGORIE    (defaut "categorie_pcm")
  SCAN_TIERS_CACHE_TTL        (defaut "300" secondes)

Alias :
  SCAN_ALIAS_TABLE            (defaut "tiers_alias")
  SCAN_ALIAS_COL_LIBELLE      (defaut "libelle_normalise")
  SCAN_ALIAS_COL_TIERS_ID     (defaut "tiers_id")
  SCAN_ALIAS_COL_PCM          (defaut "compte_pcm")
  SCAN_ALIAS_COL_CATEGORIE    (defaut "categorie_pcm")
  SCAN_ALIAS_COL_TYPE_DOC     (defaut "type_document")
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from .repositories import AliasRecord, TiersRecord

log = logging.getLogger("ia_services.supabase")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


class SupabaseRestClient:
    """Mini-client PostgREST en lecture seule (stdlib uniquement)."""

    def __init__(self, url: Optional[str] = None, service_key: Optional[str] = None, timeout: float = 8.0):
        self._base = (url or _env("SUPABASE_URL")).rstrip("/")
        self._key = service_key or _env("SUPABASE_SERVICE_ROLE_KEY") or _env("SUPABASE_PUBLISHABLE_KEY")
        self._timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self._base and self._key)

    def select(self, table: str, *, select: str = "*", filters: Optional[dict[str, str]] = None, limit: Optional[int] = None) -> list[dict[str, Any]]:
        if not self.configured:
            log.warning("Supabase non configuré (SUPABASE_URL / SERVICE_ROLE_KEY absents).")
            return []

        params: list[tuple[str, str]] = [("select", select)]
        if filters:
            params.extend(filters.items())
        if limit is not None:
            params.append(("limit", str(limit)))

        query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        endpoint = f"{self._base}/rest/v1/{urllib.parse.quote(table)}?{query}"

        req = urllib.request.Request(endpoint, method="GET")
        req.add_header("apikey", self._key)
        req.add_header("Authorization", f"Bearer {self._key}")
        req.add_header("Accept", "application/json")

        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                payload = resp.read().decode("utf-8")
            data = json.loads(payload)
            return data if isinstance(data, list) else []
        except urllib.error.HTTPError as exc:  # 4xx/5xx PostgREST
            body = ""
            try:
                body = exc.read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                pass
            log.warning("Supabase HTTP %s sur %s : %s", exc.code, table, body[:300])
        except Exception as exc:  # noqa: BLE001 - réseau / TLS / JSON
            log.warning("Supabase erreur sur %s : %s", table, exc)
        return []


class SupabaseTiersRepository:
    """TiersRepository via PostgREST, avec cache TTL (le fuzzy itère tous les tiers)."""

    def __init__(self, client: Optional[SupabaseRestClient] = None):
        self._client = client or SupabaseRestClient()
        self._table = _env("SCAN_TIERS_TABLE", "tiers")
        self._c_id = _env("SCAN_TIERS_COL_ID", "id")
        self._c_lib = _env("SCAN_TIERS_COL_LIBELLE", "libelle")
        self._c_pcm = _env("SCAN_TIERS_COL_PCM", "compte_pcm")
        self._c_cat = _env("SCAN_TIERS_COL_CATEGORIE", "categorie_pcm")
        self._ttl = float(_env("SCAN_TIERS_CACHE_TTL", "300"))
        self._cache: list[TiersRecord] = []
        self._cache_at: float = 0.0

    def list_all(self) -> list[TiersRecord]:
        now = time.monotonic()
        if self._cache and (now - self._cache_at) < self._ttl:
            return self._cache

        select = ",".join(dict.fromkeys([self._c_id, self._c_lib, self._c_pcm, self._c_cat]))
        rows = self._client.select(self._table, select=select)

        records: list[TiersRecord] = []
        for r in rows:
            tiers_id = r.get(self._c_id)
            libelle = r.get(self._c_lib)
            if tiers_id is None or not libelle:
                continue
            records.append(
                TiersRecord(
                    tiers_id=str(tiers_id),
                    libelle=str(libelle),
                    compte_pcm=(str(r[self._c_pcm]) if r.get(self._c_pcm) else None),
                    categorie_pcm=(str(r[self._c_cat]) if r.get(self._c_cat) else None),
                )
            )

        if records:  # ne pas écraser un cache valide par une réponse vide/erreur
            self._cache = records
            self._cache_at = now
        return records or self._cache

    def invalidate(self) -> None:
        self._cache = []
        self._cache_at = 0.0


class SupabaseAliasRepository:
    """AliasRepository via PostgREST : recherche exacte sur le libellé normalisé."""

    def __init__(self, client: Optional[SupabaseRestClient] = None):
        self._client = client or SupabaseRestClient()
        self._table = _env("SCAN_ALIAS_TABLE", "tiers_alias")
        self._c_lib = _env("SCAN_ALIAS_COL_LIBELLE", "libelle_normalise")
        self._c_tid = _env("SCAN_ALIAS_COL_TIERS_ID", "tiers_id")
        self._c_pcm = _env("SCAN_ALIAS_COL_PCM", "compte_pcm")
        self._c_cat = _env("SCAN_ALIAS_COL_CATEGORIE", "categorie_pcm")
        self._c_typ = _env("SCAN_ALIAS_COL_TYPE_DOC", "type_document")

    def find_by_libelle(self, libelle_normalise: str) -> Optional[AliasRecord]:
        if not libelle_normalise:
            return None
        select = ",".join(
            dict.fromkeys([self._c_lib, self._c_tid, self._c_pcm, self._c_cat, self._c_typ])
        )
        # PostgREST : filtre d'égalité -> col=eq.valeur
        rows = self._client.select(
            self._table,
            select=select,
            filters={self._c_lib: f"eq.{libelle_normalise}"},
            limit=1,
        )
        if not rows:
            return None
        r = rows[0]
        return AliasRecord(
            libelle_normalise=libelle_normalise,
            tiers_id=(str(r[self._c_tid]) if r.get(self._c_tid) else None),
            compte_pcm=(str(r[self._c_pcm]) if r.get(self._c_pcm) else None),
            categorie_pcm=(str(r[self._c_cat]) if r.get(self._c_cat) else None),
            type_document=(str(r[self._c_typ]) if r.get(self._c_typ) else None),
        )
