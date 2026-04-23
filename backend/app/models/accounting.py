import enum
from sqlalchemy import Column, String, Integer, Float, ForeignKey, DateTime, Enum, Date, Boolean
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.models.base import Base


class AccountType(str, enum.Enum):
    ASSET     = "ASSET"
    LIABILITY = "LIABILITY"
    EQUITY    = "EQUITY"
    REVENUE   = "REVENUE"
    EXPENSE   = "EXPENSE"


# ─── Nouveau : cycle de vie des écritures ────────────────────────────────────
class JournalEntryStatus(str, enum.Enum):
    DRAFT  = "DRAFT"   # Générée auto — en attente de validation
    POSTED = "POSTED"  # Validée par l'expert-comptable — immuable


class Account(Base):
    __tablename__ = "accounts"
    id           = Column(Integer, primary_key=True, index=True)
    company_id   = Column(Integer, ForeignKey("companies.id"), nullable=False)
    code         = Column(String, nullable=False)   # ex: "5141" pour Banque
    name         = Column(String, nullable=False)
    type         = Column(Enum(AccountType), nullable=False)
    account_class = Column(String, nullable=True)   # 1er chiffre du code
    created_at   = Column(DateTime(timezone=True), server_default=func.now())


class JournalEntry(Base):
    __tablename__ = "journal_entries"
    id          = Column(Integer, primary_key=True, index=True)
    company_id  = Column(Integer, ForeignKey("companies.id"), nullable=False)
    reference   = Column(String)
    date        = Column(Date, nullable=False)
    description = Column(String)
    # ── Nouveaux champs ──────────────────────────────────────────────────────
    status      = Column(
        Enum(JournalEntryStatus),
        default=JournalEntryStatus.DRAFT,
        nullable=False
    )
    validated_by   = Column(Integer, ForeignKey("users.id"), nullable=True)
    validated_at   = Column(DateTime(timezone=True), nullable=True)
    source         = Column(String, nullable=True)  # "ocr" | "manual" | "payment"
    # ─────────────────────────────────────────────────────────────────────────
    created_at  = Column(DateTime(timezone=True), server_default=func.now())

    lines            = relationship(
        "JournalEntryLine", back_populates="journal_entry",
        cascade="all, delete-orphan"
    )
    validator        = relationship("User", foreign_keys=[validated_by])


class JournalEntryLine(Base):
    __tablename__ = "journal_entry_lines"
    id               = Column(Integer, primary_key=True, index=True)
    journal_entry_id = Column(Integer, ForeignKey("journal_entries.id"), nullable=False)
    account_id       = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    debit            = Column(Float, default=0.0)
    credit           = Column(Float, default=0.0)

    journal_entry = relationship("JournalEntry", back_populates="lines")
    account       = relationship("Account")


class BankAccount(Base):
    __tablename__ = "bank_accounts"
    id         = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    name       = Column(String, nullable=False)
    rib        = Column(String)  # Relevé d'Identité Bancaire
    balance    = Column(Float, default=0.0)


class BankTransaction(Base):
    __tablename__ = "bank_transactions"
    id              = Column(Integer, primary_key=True, index=True)
    bank_account_id = Column(Integer, ForeignKey("bank_accounts.id"), nullable=False)
    date            = Column(Date, nullable=False)
    amount          = Column(Float, nullable=False)  # + entrant, - sortant
    description     = Column(String)
    is_reconciled   = Column(Boolean, default=False)
    journal_entry_id = Column(Integer, ForeignKey("journal_entries.id"), nullable=True)
