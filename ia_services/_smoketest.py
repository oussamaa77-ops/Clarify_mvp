"""
Smoke-test autonome (aucune BDD requise) — vérifie le comportement des deux
services avec des fakes en mémoire. Lancer :  python -m ia_services._smoketest
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from .reconciliation import (
    Echeance,
    FactureEcheances,
    OrphanTransaction,
    find_partial_payments_combinations,
)
from .scan import (
    AliasRecord,
    DocumentClassifierService,
    RawExtraction,
    TiersRecord,
)
from .scan.schemas import DetectedDate, MatchOrigin


# --- Fakes repositories ------------------------------------------------------
class FakeAliasRepo:
    def __init__(self, rows: dict[str, AliasRecord]):
        self._rows = rows

    def find_by_libelle(self, libelle_normalise: str):
        return self._rows.get(libelle_normalise)


class FakeTiersRepo:
    def __init__(self, rows: list[TiersRecord]):
        self._rows = rows

    def list_all(self):
        return self._rows


def test_classifier_hardcoded_cnss():
    svc = DocumentClassifierService(FakeAliasRepo({}), FakeTiersRepo([]))
    raw = RawExtraction(
        nom_tiers="CNSS AGENCE CASABLANCA",
        montant_ttc=Decimal("12500.00"),
        dates_detectees=[
            DetectedDate(valeur=date(2026, 5, 31), role="emission"),
            DetectedDate(valeur=date(2026, 6, 10), role="tele-reglement"),
        ],
    )
    doc = svc.classify(raw)
    assert doc.type_document == "Bordereau", doc
    assert doc.compte_pcm == "6174", doc
    assert doc.categorie_pcm == "Charges Sociales", doc
    assert doc.origine_mapping == MatchOrigin.HARDCODED
    assert doc.date_document == date(2026, 6, 10), doc  # redressement télé-règlement
    print("[OK] classifier hardcoded CNSS ->", doc.compte_pcm, doc.date_document)


def test_classifier_hardcoded_cnss_nom_complet():
    """Le nom officiel complet doit aussi forcer le 6174 (charges sociales)."""
    svc = DocumentClassifierService(FakeAliasRepo({}), FakeTiersRepo([]))
    raw = RawExtraction(
        nom_tiers="CAISSE NATIONALE DE SECURITE SOCIALE",
        montant_ttc=Decimal("8000.00"),
        dates_detectees=[DetectedDate(valeur=date(2026, 4, 30), role="emission")],
    )
    doc = svc.classify(raw)
    assert doc.compte_pcm == "6174", doc
    assert doc.categorie_pcm == "Charges Sociales", doc
    assert doc.origine_mapping == MatchOrigin.HARDCODED, doc
    print("[OK] classifier hardcoded CNSS (nom complet) ->", doc.compte_pcm)


def test_classifier_cnca_not_cnss():
    """Garde anti-faux-positif : la CAISSE NATIONALE DE CRÉDIT AGRICOLE (banque)
    NE doit PAS être classée en charges sociales 6174."""
    svc = DocumentClassifierService(FakeAliasRepo({}), FakeTiersRepo([]))
    raw = RawExtraction(
        nom_tiers="CAISSE NATIONALE DE CREDIT AGRICOLE",
        montant_ttc=Decimal("1500.00"),
        dates_detectees=[DetectedDate(valeur=date(2026, 4, 30), role="emission")],
    )
    doc = svc.classify(raw)
    assert doc.compte_pcm != "6174", doc
    assert doc.origine_mapping != MatchOrigin.HARDCODED, doc
    print("[OK] classifier CNCA != CNSS ->", doc.compte_pcm or "non mappe")


def test_classifier_fuzzy():
    tiers = [TiersRecord(tiers_id="T1", libelle="Société MARJANE HOLDING", compte_pcm="6111")]
    svc = DocumentClassifierService(FakeAliasRepo({}), FakeTiersRepo(tiers))
    raw = RawExtraction(nom_tiers="MARJANE HOLDNG", dates_detectees=[])
    doc = svc.classify(raw)
    assert doc.origine_mapping == MatchOrigin.FUZZY, doc
    assert doc.tiers_id == "T1", doc
    print("[OK] classifier fuzzy -> score", doc.score_matching)


def test_partial_payments():
    facture = FactureEcheances(
        facture_id="FAC-2026-001",
        tiers_id="T1",
        tiers_libelle="MARJANE HOLDING",
        echeances=[
            Echeance(echeance_id="E1", montant_attendu=Decimal("3000.00"), date_echeance=date(2026, 6, 1)),
            Echeance(echeance_id="E2", montant_attendu=Decimal("2000.00"), date_echeance=date(2026, 7, 1)),
        ],
    )
    txs = [
        # Tranche 1 : 2000 + 1000 = 3000, même libellé.
        OrphanTransaction(transaction_id="TX1", montant=Decimal("2000.00"), date_operation=date(2026, 6, 2), libelle="VIR MARJANE FAC 001", tiers_id="T1"),
        OrphanTransaction(transaction_id="TX2", montant=Decimal("1000.00"), date_operation=date(2026, 6, 3), libelle="VIR MARJANE FAC 001", tiers_id="T1"),
        # Tranche 2 : 2000 exact.
        OrphanTransaction(transaction_id="TX3", montant=Decimal("2000.00"), date_operation=date(2026, 7, 2), libelle="VIR MARJANE FAC 001", tiers_id="T1"),
        # Bruit hors fenêtre / autre tiers.
        OrphanTransaction(transaction_id="TX4", montant=Decimal("3000.00"), date_operation=date(2026, 9, 1), libelle="AUTRE", tiers_id="T1"),
    ]
    res = find_partial_payments_combinations(facture, txs)
    assert res.a_des_echeances
    assert res.tranches[0].resolue and res.tranches[1].resolue, res
    assert res.solutions_completes, res
    best = res.solutions_completes[0]
    assert best.affectations["E1"] and best.affectations["E2"], best
    print("[OK] partial payments ->", best.affectations, "coh", best.libelle_coherence_globale)


if __name__ == "__main__":
    test_classifier_hardcoded_cnss()
    test_classifier_hardcoded_cnss_nom_complet()
    test_classifier_cnca_not_cnss()
    test_classifier_fuzzy()
    test_partial_payments()
    print("\nTous les smoke-tests sont passes [OK]")
