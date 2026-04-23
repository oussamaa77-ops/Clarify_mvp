from pydantic import BaseModel
from typing import List, Optional
from datetime import date, datetime
from app.models.accounting import AccountType, JournalEntryStatus


class AccountBase(BaseModel):
    code: str
    name: str
    type: AccountType

class AccountResponse(AccountBase):
    id: int
    company_id: int
    created_at: datetime
    class Config:
        from_attributes = True

class LedgerAccountResponse(AccountResponse):
    total_debit: float
    total_credit: float
    balance: float


class JournalEntryLineResponse(BaseModel):
    id: int
    account_id: int
    debit: float
    credit: float
    account: AccountResponse
    class Config:
        from_attributes = True


class JournalEntryResponse(BaseModel):
    id: int
    reference: Optional[str] = None
    date: date
    description: Optional[str] = None
    status: JournalEntryStatus = JournalEntryStatus.DRAFT
    source: Optional[str] = None
    validated_by: Optional[int] = None
    validated_at: Optional[datetime] = None
    lines: List[JournalEntryLineResponse]
    class Config:
        from_attributes = True


class JournalValidateRequest(BaseModel):
    """Corps de la requête POST /accounting/journal/{id}/validate"""
    note: Optional[str] = None   # Commentaire facultatif de l'expert


class JournalEntryCreate(BaseModel):
    """Création manuelle d'une écriture depuis l'interface cabinet."""
    reference: Optional[str] = None
    date: date
    description: Optional[str] = None
    source: Optional[str] = "manual"
    lines: List["JournalEntryLineCreate"]

class JournalEntryLineCreate(BaseModel):
    account_code: str   # On passe le code PCGE, le service résout l'Account
    debit: float = 0.0
    credit: float = 0.0

JournalEntryCreate.model_rebuild()
