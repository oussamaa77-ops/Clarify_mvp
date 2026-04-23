from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from typing import List

from app.database import get_db
from app.models.identity import User, CompanyUser
from app.models.accounting import (
    JournalEntry, JournalEntryLine, JournalEntryStatus, Account, AccountType
)
from app.schemas.accounting import (
    AccountResponse, JournalEntryResponse, LedgerAccountResponse,
    JournalValidateRequest, JournalEntryCreate,
)
from app.services.accounting import (
    get_accounts, get_journal_entries, get_general_ledger, get_or_create_account
)
from app.utils.security import (
    get_current_user, get_current_company_id, get_current_company_user,
    require_can_validate_journal,
)

router = APIRouter()


# ─── Plan comptable ──────────────────────────────────────────────────────────

@router.get("/accounts", response_model=List[AccountResponse])
async def read_accounts(
    db: AsyncSession         = Depends(get_db),
    company_id: int          = Depends(get_current_company_id),
    current_user: User       = Depends(get_current_user),
):
    return await get_accounts(db, company_id)


# ─── Grand livre ─────────────────────────────────────────────────────────────

@router.get("/ledger", response_model=List[LedgerAccountResponse])
async def read_general_ledger(
    db: AsyncSession   = Depends(get_db),
    company_id: int    = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user),
):
    return await get_general_ledger(db, company_id)


# ─── Journal des écritures ───────────────────────────────────────────────────

@router.get("/journal", response_model=List[JournalEntryResponse])
async def read_journal_entries(
    skip: int          = 0,
    limit: int         = 100,
    status_filter: str = None,   # "DRAFT" | "POSTED" | None = tous
    db: AsyncSession   = Depends(get_db),
    company_id: int    = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user),
):
    entries = await get_journal_entries(db, company_id, skip, limit, status_filter)
    return entries


# ─── Création manuelle d'écriture (CABINET uniquement) ───────────────────────

@router.post("/journal", response_model=JournalEntryResponse, status_code=201)
async def create_journal_entry(
    body: JournalEntryCreate,
    db: AsyncSession       = Depends(get_db),
    company_id: int        = Depends(get_current_company_id),
    cu: CompanyUser        = Depends(require_can_validate_journal()),
    current_user: User     = Depends(get_current_user),
):
    """
    Création manuelle d'une écriture comptable.
    Réservé aux utilisateurs ayant can_validate_journal = True.
    Une écriture créée manuellement par un expert est directement POSTED.
    """
    # Vérification équilibre débit = crédit
    total_debit  = sum(l.debit  for l in body.lines)
    total_credit = sum(l.credit for l in body.lines)
    if round(abs(total_debit - total_credit), 2) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Écriture déséquilibrée : débit {total_debit:.2f} ≠ crédit {total_credit:.2f}",
        )

    je = JournalEntry(
        company_id   = company_id,
        reference    = body.reference,
        date         = body.date,
        description  = body.description,
        source       = body.source or "manual",
        status       = JournalEntryStatus.POSTED,   # Expert = directement validé
        validated_by = current_user.id,
        validated_at = datetime.now(timezone.utc),
    )
    db.add(je)
    await db.flush()

    for line in body.lines:
        account = await get_or_create_account(
            db, company_id, line.account_code,
            f"Compte {line.account_code}", AccountType.ASSET
        )
        db.add(JournalEntryLine(
            journal_entry_id = je.id,
            account_id       = account.id,
            debit            = line.debit,
            credit           = line.credit,
        ))

    await db.commit()

    result = await db.execute(
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines).selectinload(JournalEntryLine.account))
        .where(JournalEntry.id == je.id)
    )
    return result.scalars().first()


# ─── Validation DRAFT → POSTED ───────────────────────────────────────────────

@router.post("/journal/{entry_id}/validate", response_model=JournalEntryResponse)
async def validate_journal_entry(
    entry_id: int,
    body: JournalValidateRequest = JournalValidateRequest(),
    db: AsyncSession   = Depends(get_db),
    company_id: int    = Depends(get_current_company_id),
    cu: CompanyUser    = Depends(require_can_validate_journal()),
    current_user: User = Depends(get_current_user),
):
    """
    Valide une écriture DRAFT → POSTED.
    Seul un utilisateur avec can_validate_journal peut faire cette action.
    Une écriture POSTED est immuable.
    """
    result = await db.execute(
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines).selectinload(JournalEntryLine.account))
        .where(JournalEntry.id == entry_id, JournalEntry.company_id == company_id)
    )
    je = result.scalars().first()

    if not je:
        raise HTTPException(status_code=404, detail="Écriture introuvable")

    if je.status == JournalEntryStatus.POSTED:
        raise HTTPException(
            status_code=400,
            detail="Cette écriture est déjà validée et ne peut plus être modifiée",
        )

    je.status       = JournalEntryStatus.POSTED
    je.validated_by = current_user.id
    je.validated_at = datetime.now(timezone.utc)
    if body.note:
        je.description = f"{je.description or ''} [Validé : {body.note}]".strip()

    await db.commit()
    await db.refresh(je)

    # Recharger avec relations pour la réponse
    result = await db.execute(
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines).selectinload(JournalEntryLine.account))
        .where(JournalEntry.id == entry_id)
    )
    return result.scalars().first()


@router.post("/journal/{entry_id}/unpost", response_model=JournalEntryResponse)
async def unpost_journal_entry(
    entry_id: int,
    db: AsyncSession   = Depends(get_db),
    company_id: int    = Depends(get_current_company_id),
    cu: CompanyUser    = Depends(require_can_validate_journal()),
    current_user: User = Depends(get_current_user),
):
    """
    Repasse une écriture POSTED → DRAFT (correction d'erreur).
    Réservé CABINET uniquement — action rare et traçée.
    """
    from app.models.identity import DossierRole
    if cu.dossier_role != DossierRole.CABINET:
        raise HTTPException(
            status_code=403,
            detail="Seul un expert-comptable (CABINET) peut annuler une validation",
        )

    result = await db.execute(
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines).selectinload(JournalEntryLine.account))
        .where(JournalEntry.id == entry_id, JournalEntry.company_id == company_id)
    )
    je = result.scalars().first()
    if not je:
        raise HTTPException(status_code=404, detail="Écriture introuvable")

    je.status       = JournalEntryStatus.DRAFT
    je.validated_by = None
    je.validated_at = None

    await db.commit()

    result = await db.execute(
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines).selectinload(JournalEntryLine.account))
        .where(JournalEntry.id == entry_id)
    )
    return result.scalars().first()

