import enum
import secrets
from sqlalchemy import Column, String, Boolean, DateTime, Integer, ForeignKey, Enum, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.models.base import Base


class RoleEnum(str, enum.Enum):
    ADMIN = "ADMIN"
    ACCOUNTANT = "ACCOUNTANT"
    EMPLOYEE = "EMPLOYEE"


# ─── Nouveau : rôle métier dans un dossier ────────────────────────────────────
class DossierRole(str, enum.Enum):
    CABINET              = "CABINET"               # Expert-Comptable
    COLLABORATEUR_CABINET = "COLLABORATEUR_CABINET" # Collaborateur/Chef de mission
    ASSISTANT_CABINET    = "ASSISTANT_CABINET"      # Assistant comptable
    CE                   = "CE"                     # Chef d'Entreprise / Direction
    COLLABORATEUR_CE     = "COLLABORATEUR_CE"       # Aide-comptable interne

# ─── Nouveau : statut d'invitation ────────────────────────────────────────────
class InvitationStatus(str, enum.Enum):
    PENDING  = "PENDING"
    ACCEPTED = "ACCEPTED"
    EXPIRED  = "EXPIRED"


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    full_name = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company_associations = relationship("CompanyUser", back_populates="user")
    invitations_sent = relationship(
        "DossierInvitation", back_populates="invited_by_user",
        foreign_keys="DossierInvitation.invited_by"
    )


class Company(Base):
    """
    Un 'dossier' du cabinet = une Company.
    Un expert-comptable (CABINET) peut être lié à N dossiers via CompanyUser.
    """
    __tablename__ = "companies"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    ice = Column(String)    # Identifiant Commun de l'Entreprise (15 chiffres)
    tax_id = Column(String) # Identifiant Fiscal (IF)
    rc = Column(String)     # Registre de Commerce
    address = Column(String)
    logo_url = Column(String)
    # ── Nouveaux champs ──
    cabinet_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # Expert ref
    fiscal_year_start_month = Column(Integer, default=1)  # 1 = Janvier (standard Maroc)
    is_archived = Column(Boolean, default=False)          # Dossier archivé
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user_associations = relationship("CompanyUser", back_populates="company")
    clients   = relationship("Client",   back_populates="company")
    suppliers = relationship("Supplier", back_populates="company")
    products  = relationship("Product",  back_populates="company")
    quotes    = relationship("Quote",    back_populates="company")
    invoices  = relationship("Invoice",  back_populates="company")
    invitations = relationship("DossierInvitation", back_populates="company")


class CompanyUser(Base):
    """
    Table de jointure User ↔ Company.
    Un même User peut être lié à plusieurs Company avec des rôles différents.
    Ex : l'expert-comptable a role=CABINET sur 50 dossiers.
    """
    __tablename__ = "company_users"
    user_id    = Column(Integer, ForeignKey("users.id"),     primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), primary_key=True)

    # Rôle technique (ancien système — conservé pour compatibilité)
    role = Column(Enum(RoleEnum), default=RoleEnum.EMPLOYEE, nullable=False)

    # ── Nouveaux champs ──
    dossier_role = Column(
        Enum(DossierRole), default=DossierRole.CE, nullable=False
    )
    can_validate_journal = Column(Boolean, default=False)
    # True uniquement pour CABINET ou CE avec délégation explicite
    can_view_bank        = Column(Boolean, default=True)
    can_invite_members   = Column(Boolean, default=False)
    joined_at = Column(DateTime(timezone=True), server_default=func.now())

    user    = relationship("User",    back_populates="company_associations")
    company = relationship("Company", back_populates="user_associations")


class DossierInvitation(Base):
    """
    Invitation envoyée par un CABINET pour ajouter un CE ou COLLABORATEUR
    à un dossier. Le token à usage unique est envoyé par email.
    """
    __tablename__ = "dossier_invitations"
    id         = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    invited_by = Column(Integer, ForeignKey("users.id"),     nullable=False)
    email      = Column(String, nullable=False)
    dossier_role = Column(Enum(DossierRole), default=DossierRole.CE, nullable=False)
    can_validate_journal = Column(Boolean, default=False)
    token      = Column(String, unique=True, nullable=False,
                        default=lambda: secrets.token_urlsafe(32))
    status     = Column(Enum(InvitationStatus), default=InvitationStatus.PENDING)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company         = relationship("Company", back_populates="invitations")
    invited_by_user = relationship(
        "User", back_populates="invitations_sent",
        foreign_keys=[invited_by]
    )


class GmailIntegration(Base):
    __tablename__ = "gmail_integrations"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    gmail_address = Column(String, unique=True, nullable=False)
    refresh_token = Column(String, nullable=False)      # On le chiffrera plus tard
    last_history_id = Column(String, nullable=True)
    last_checked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")
    company = relationship("Company")
