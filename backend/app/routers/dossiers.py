"""
Router /api/dossiers — Gestion multi-dossiers pour cabinets d'expertise comptable.

Logique métier :
  - Un 'dossier' = une Company dans la DB.
  - Un expert-comptable (CABINET) peut être membre de N dossiers.
  - Endpoints :
      GET  /dossiers              → liste mes dossiers
      POST /dossiers              → créer un nouveau dossier client
      GET  /dossiers/{id}         → détail d'un dossier
      PUT  /dossiers/{id}         → modifier les infos du dossier
      GET  /dossiers/{id}/members → membres du dossier
      POST /dossiers/{id}/invite  → inviter un CE ou collaborateur
      POST /dossiers/accept/{token} → accepter une invitation
      PUT  /dossiers/{id}/members/{user_id} → modifier permissions
      DELETE /dossiers/{id}/members/{user_id} → retirer un membre
"""

import secrets
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from enum import Enum
from app.database import get_db
from app.models.identity import (
    User, Company, CompanyUser,
    DossierRole, RoleEnum,
    DossierInvitation, InvitationStatus,
)
from app.utils.security import (
    get_current_user, get_current_company_id,
    get_current_company_user, require_dossier_role,
)
from app.utils.security import get_password_hash

router = APIRouter(prefix="/dossiers", tags=["dossiers"])


# ─────────────────────────────────────────────────────────────────────────────
# Schémas Pydantic
# ─────────────────────────────────────────────────────────────────────────────

class DossierMemberOut(BaseModel):
    user_id: int
    email: str
    full_name: Optional[str] = None
    dossier_role: DossierRole
    can_validate_journal: bool
    can_view_bank: bool
    can_invite_members: bool
    joined_at: Optional[datetime] = None
    class Config:
        from_attributes = True



class DossierOut(BaseModel):
    id: int
    name: str
    ice: Optional[str] = None
    tax_id: Optional[str] = None
    rc: Optional[str] = None
    address: Optional[str] = None
    fiscal_year_start_month: int
    is_archived: bool
    my_role: str
    can_validate_journal: bool
    member_count: int
    class Config:
        from_attributes = True

class DossierCreate(BaseModel):
    name: str
    ice: Optional[str] = None
    tax_id: Optional[str] = None
    rc: Optional[str] = None
    address: Optional[str] = None
    fiscal_year_start_month: int = 1


class DossierUpdate(BaseModel):
    name: Optional[str] = None
    ice: Optional[str] = None
    tax_id: Optional[str] = None
    rc: Optional[str] = None
    address: Optional[str] = None
    fiscal_year_start_month: Optional[int] = None
    is_archived: Optional[bool] = None


class InviteRequest(BaseModel):
    email: EmailStr
    dossier_role: DossierRole = DossierRole.CE
    can_validate_journal: bool = False
    can_view_bank: bool = True
    can_invite_members: bool = False


class InviteAcceptRequest(BaseModel):
    """Si l'invité n'a pas encore de compte, il peut s'en créer un ici."""
    password: Optional[str] = None
    full_name: Optional[str] = None


class MemberUpdateRequest(BaseModel):
    dossier_role: Optional[DossierRole] = None
    can_validate_journal: Optional[bool] = None
    can_view_bank: Optional[bool] = None
    can_invite_members: Optional[bool] = None


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _assert_member(
    db: AsyncSession, user_id: int, company_id: int
) -> CompanyUser:
    result = await db.execute(
        select(CompanyUser).where(
            CompanyUser.user_id == user_id,
            CompanyUser.company_id == company_id,
        )
    )
    cu = result.scalars().first()
    if not cu:
        raise HTTPException(status_code=404, detail="Membre introuvable dans ce dossier")
    return cu


async def _build_dossier_out(
    company: Company, cu: CompanyUser, member_count: int
) -> dict:
    return {
        "id": company.id,
        "name": company.name,
        "ice": company.ice,
        "tax_id": company.tax_id,
        "rc": company.rc,
        "address": company.address,
        "fiscal_year_start_month": company.fiscal_year_start_month or 1,
        "is_archived": company.is_archived or False,
        "my_role": cu.dossier_role,
        "can_validate_journal": cu.can_validate_journal,
        "member_count": member_count,
    }


# ─────────────────────────────────────────────────────────────────────────────
# GET /dossiers — liste de tous mes dossiers
# ─────────────────────────────────────────────────────────────────────────────

@router.get("", response_model=List[DossierOut])
async def list_my_dossiers(
    include_archived: bool = False,
    current_user: User     = Depends(get_current_user),
    db: AsyncSession       = Depends(get_db),
):
    """
    Retourne tous les dossiers auxquels l'utilisateur est associé.
    Un expert-comptable (CABINET) en voit potentiellement des dizaines.
    """
    result = await db.execute(
        select(CompanyUser)
        .options(selectinload(CompanyUser.company))
        .where(CompanyUser.user_id == current_user.id)
    )
    associations = result.scalars().all()

    dossiers = []
    for cu in associations:
        c = cu.company
        if not include_archived and c.is_archived:
            continue

        # Compter les membres
        count_result = await db.execute(
            select(CompanyUser).where(CompanyUser.company_id == c.id)
        )
        member_count = len(count_result.scalars().all())

        dossiers.append(await _build_dossier_out(c, cu, member_count))

    return dossiers


# ─────────────────────────────────────────────────────────────────────────────
# POST /dossiers — créer un nouveau dossier (CABINET)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("", response_model=DossierOut, status_code=201)
async def create_dossier(
    body: DossierCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession   = Depends(get_db),
):
    """
    Crée un nouveau dossier client et y associe automatiquement
    l'expert-comptable comme CABINET avec tous les droits.
    """
    company = Company(
        name=body.name,
        ice=body.ice,
        tax_id=body.tax_id,
        rc=body.rc,
        address=body.address,
        fiscal_year_start_month=body.fiscal_year_start_month,
        cabinet_user_id=current_user.id,
        is_archived=False,
    )
    db.add(company)
    await db.flush()

    cu = CompanyUser(
        user_id=current_user.id,
        company_id=company.id,
        role=RoleEnum.ADMIN,
        dossier_role=DossierRole.CABINET,
        can_validate_journal=True,
        can_view_bank=True,
        can_invite_members=True,
    )
    db.add(cu)
    await db.commit()
    await db.refresh(company)

    return await _build_dossier_out(company, cu, member_count=1)


# ─────────────────────────────────────────────────────────────────────────────
# GET /dossiers/{id} — détail d'un dossier
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{dossier_id}", response_model=DossierOut)
async def get_dossier(
    dossier_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession   = Depends(get_db),
):
    cu = await _assert_member(db, current_user.id, dossier_id)

    result = await db.execute(
        select(Company).where(Company.id == dossier_id)
    )
    company = result.scalars().first()
    if not company:
        raise HTTPException(status_code=404, detail="Dossier introuvable")

    count_result = await db.execute(
        select(CompanyUser).where(CompanyUser.company_id == dossier_id)
    )
    member_count = len(count_result.scalars().all())

    return await _build_dossier_out(company, cu, member_count)


# ─────────────────────────────────────────────────────────────────────────────
# PUT /dossiers/{id} — modifier les infos du dossier
# ─────────────────────────────────────────────────────────────────────────────

@router.put("/{dossier_id}", response_model=DossierOut)
async def update_dossier(
    dossier_id: int,
    body: DossierUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession   = Depends(get_db),
):
    cu = await _assert_member(db, current_user.id, dossier_id)
    if cu.dossier_role not in (DossierRole.CABINET,):
        raise HTTPException(status_code=403, detail="Seul le cabinet peut modifier les infos du dossier")

    result = await db.execute(select(Company).where(Company.id == dossier_id))
    company = result.scalars().first()
    if not company:
        raise HTTPException(status_code=404, detail="Dossier introuvable")

    for field, value in body.model_dump(exclude_none=True).items():
        setattr(company, field, value)

    await db.commit()
    await db.refresh(company)

    count_result = await db.execute(
        select(CompanyUser).where(CompanyUser.company_id == dossier_id)
    )
    member_count = len(count_result.scalars().all())

    return await _build_dossier_out(company, cu, member_count)


# ─────────────────────────────────────────────────────────────────────────────
# GET /dossiers/{id}/members — liste des membres
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{dossier_id}/members", response_model=List[DossierMemberOut])
async def list_dossier_members(
    dossier_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession   = Depends(get_db),
):
    await _assert_member(db, current_user.id, dossier_id)

    result = await db.execute(
        select(CompanyUser)
        .options(selectinload(CompanyUser.user))
        .where(CompanyUser.company_id == dossier_id)
    )
    members = result.scalars().all()

    return [
        {
            "user_id": m.user_id,
            "email": m.user.email,
            "full_name": m.user.full_name,
            "dossier_role": m.dossier_role,
            "can_validate_journal": m.can_validate_journal,
            "can_view_bank": m.can_view_bank,
            "can_invite_members": m.can_invite_members,
            "joined_at": m.joined_at,
        }
        for m in members
    ]


# ─────────────────────────────────────────────────────────────────────────────
# POST /dossiers/{id}/invite — inviter par email
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{dossier_id}/invite", status_code=201)
async def invite_member(
    dossier_id: int,
    body: InviteRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cu = await _assert_member(db, current_user.id, dossier_id)

    # Règles d'invitation selon rôle
    if cu.dossier_role == DossierRole.CABINET:
        # Cabinet peut inviter CE, COLLABORATEUR_CABINET, ASSISTANT_CABINET
        allowed_to_invite = [DossierRole.CE, DossierRole.COLLABORATEUR_CABINET, DossierRole.ASSISTANT_CABINET]
    elif cu.dossier_role == DossierRole.CE:
        # CE peut inviter ses collaborateurs internes
        allowed_to_invite = [DossierRole.COLLABORATEUR_CE]
    else:
        raise HTTPException(status_code=403, detail="Vous n'avez pas le droit d'inviter des membres")

    if body.dossier_role not in allowed_to_invite:
        raise HTTPException(
            status_code=403,
            detail=f"Vous ne pouvez pas inviter avec le rôle {body.dossier_role.value}"
        )

    # Vérifier que l'utilisateur n'est pas déjà membre
    existing_user = await db.execute(select(User).where(User.email == body.email))
    user = existing_user.scalars().first()
    if user:
        existing_member = await db.execute(
            select(CompanyUser).where(
                CompanyUser.user_id == user.id,
                CompanyUser.company_id == dossier_id,
            )
        )
        if existing_member.scalars().first():
            raise HTTPException(status_code=400, detail=f"{body.email} est déjà membre")

    token = secrets.token_urlsafe(32)
    invitation = DossierInvitation(
        company_id=dossier_id,
        invited_by=current_user.id,
        email=body.email,
        dossier_role=body.dossier_role,
        can_validate_journal=body.can_validate_journal,
        token=token,
        status=InvitationStatus.PENDING,
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    db.add(invitation)
    await db.commit()

    invite_url = f"/dossiers/accept/{token}"
    return {
        "message": f"Invitation envoyée à {body.email}",
        "token": token,
        "invite_url": invite_url,
        "expires_in_days": 7,
    }


# ─────────────────────────────────────────────────────────────────────────────
# POST /dossiers/accept/{token} — accepter une invitation
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/accept/{token}")
async def accept_invitation(
    token: str,
    body: InviteAcceptRequest = InviteAcceptRequest(),
    db: AsyncSession          = Depends(get_db),
):
    """
    Accepte une invitation par token.
    - Si l'utilisateur existe déjà → on l'ajoute au dossier.
    - Sinon et si un mot de passe est fourni → on crée son compte d'abord.
    """
    result = await db.execute(
        select(DossierInvitation).where(
            DossierInvitation.token == token,
            DossierInvitation.status == InvitationStatus.PENDING,
        )
    )
    invitation = result.scalars().first()

    if not invitation:
        raise HTTPException(status_code=404, detail="Invitation introuvable ou déjà utilisée")

    if invitation.expires_at and invitation.expires_at < datetime.now(timezone.utc):
        invitation.status = InvitationStatus.EXPIRED
        await db.commit()
        raise HTTPException(status_code=410, detail="Cette invitation a expiré")

    # Chercher ou créer l'utilisateur
    user_result = await db.execute(select(User).where(User.email == invitation.email))
    user = user_result.scalars().first()

    if not user:
        if not body.password:
            raise HTTPException(
                status_code=400,
                detail="Compte inexistant — fournissez un mot de passe pour créer votre compte",
            )
        user = User(
            email=invitation.email,
            full_name=body.full_name or "",
            hashed_password=get_password_hash(body.password),
            is_active=True,
        )
        db.add(user)
        await db.flush()

    # Vérifier qu'il n'est pas déjà membre
    existing = await db.execute(
        select(CompanyUser).where(
            CompanyUser.user_id == user.id,
            CompanyUser.company_id == invitation.company_id,
        )
    )
    if not existing.scalars().first():
        db.add(CompanyUser(
    user_id=user.id,
    company_id=invitation.company_id,
    role=RoleEnum.EMPLOYEE,
    dossier_role=invitation.dossier_role,
    can_validate_journal=invitation.dossier_role == DossierRole.CABINET,
    can_view_bank=invitation.dossier_role in [DossierRole.CABINET, DossierRole.CE, DossierRole.COLLABORATEUR_CABINET],
    can_invite_members=invitation.dossier_role in [DossierRole.CABINET, DossierRole.CE],
))

    invitation.status = InvitationStatus.ACCEPTED
    await db.commit()

    return {
        "message": f"Bienvenue ! Vous avez rejoint le dossier.",
        "dossier_id": invitation.company_id,
        "dossier_role": invitation.dossier_role,
    }


# ─────────────────────────────────────────────────────────────────────────────
# PUT /dossiers/{id}/members/{user_id} — modifier les permissions
# ─────────────────────────────────────────────────────────────────────────────

@router.put("/{dossier_id}/members/{target_user_id}", response_model=DossierMemberOut)
async def update_member_permissions(
    dossier_id: int,
    target_user_id: int,
    body: MemberUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession   = Depends(get_db),
):
    """
    Modifie le rôle ou les permissions d'un membre.
    Réservé au CABINET du dossier.
    """
    my_cu = await _assert_member(db, current_user.id, dossier_id)
    if my_cu.dossier_role != DossierRole.CABINET:
        raise HTTPException(status_code=403, detail="Seul le cabinet peut modifier les permissions")

    target_cu = await _assert_member(db, target_user_id, dossier_id)

    for field, value in body.model_dump(exclude_none=True).items():
        setattr(target_cu, field, value)

    await db.commit()
    await db.refresh(target_cu)

    target_user_result = await db.execute(select(User).where(User.id == target_user_id))
    target_user = target_user_result.scalars().first()

    return {
        "user_id": target_cu.user_id,
        "email": target_user.email,
        "full_name": target_user.full_name,
        "dossier_role": target_cu.dossier_role,
        "can_validate_journal": target_cu.can_validate_journal,
        "can_view_bank": target_cu.can_view_bank,
        "can_invite_members": target_cu.can_invite_members,
        "joined_at": target_cu.joined_at,
    }


# ─────────────────────────────────────────────────────────────────────────────
# DELETE /dossiers/{id}/members/{user_id} — retirer un membre
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/{dossier_id}/members/{target_user_id}", status_code=204)
async def remove_member(
    dossier_id: int,
    target_user_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession   = Depends(get_db),
):
    my_cu = await _assert_member(db, current_user.id, dossier_id)
    if my_cu.dossier_role != DossierRole.CABINET and current_user.id != target_user_id:
        raise HTTPException(
            status_code=403,
            detail="Seul le cabinet peut retirer des membres (sauf se retirer soi-même)",
        )

    target_cu = await _assert_member(db, target_user_id, dossier_id)

    # Empêcher de retirer le dernier CABINET
    if target_cu.dossier_role == DossierRole.CABINET:
        cabinets_result = await db.execute(
            select(CompanyUser).where(
                CompanyUser.company_id == dossier_id,
                CompanyUser.dossier_role == DossierRole.CABINET,
            )
        )
        if len(cabinets_result.scalars().all()) <= 1:
            raise HTTPException(
                status_code=400,
                detail="Impossible de retirer le seul expert-comptable du dossier",
            )

    await db.delete(target_cu)
    await db.commit()