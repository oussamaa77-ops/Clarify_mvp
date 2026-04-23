from datetime import datetime, timedelta
from typing import Optional, Any, Union, List

from jose import jwt
from passlib.context import CryptContext
from fastapi.security import OAuth2PasswordBearer
from fastapi import Depends, HTTPException, status, Cookie, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import settings
from app.database import get_db
from app.models.identity import User, CompanyUser, RoleEnum, DossierRole

pwd_context   = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login")


# ─────────────────────────────────────────────────────────────────────────────
# Utilitaires mot de passe & token
# ─────────────────────────────────────────────────────────────────────────────

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def create_access_token(
    subject: Union[str, Any],
    expires_delta: Optional[timedelta] = None
) -> str:
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    return jwt.encode(
        {"exp": expire, "sub": str(subject)},
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Récupérer l'utilisateur courant depuis le JWT
# ─────────────────────────────────────────────────────────────────────────────

async def get_current_user(
    db: AsyncSession = Depends(get_db),
    token: str = Depends(oauth2_scheme),
) -> User:
    exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Impossible de valider les identifiants",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload  = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise exc
    except Exception:
        raise exc

    result = await db.execute(select(User).where(User.id == int(user_id)))
    user   = result.scalars().first()
    if user is None:
        raise exc
    return user


# ─────────────────────────────────────────────────────────────────────────────
# Résolution du dossier actif (multi-dossiers)
#
# Priorité :
#   1. Header X-Active-Dossier (envoyé par le frontend après switch)
#   2. Premier dossier de l'utilisateur (comportement historique)
#
# Le frontend stocke l'ID du dossier actif dans localStorage et l'envoie
# dans chaque requête : headers: { 'X-Active-Dossier': '42' }
# ─────────────────────────────────────────────────────────────────────────────

async def get_current_company_id(
    current_user: User     = Depends(get_current_user),
    db: AsyncSession       = Depends(get_db),
    x_active_dossier: Optional[str] = Header(default=None, alias="X-Active-Dossier"),
) -> int:
    """
    Retourne le company_id actif pour cet utilisateur.
    Vérifie que l'utilisateur est bien membre du dossier demandé.
    """
    # Charger toutes les associations de l'utilisateur
    result = await db.execute(
        select(CompanyUser).where(CompanyUser.user_id == current_user.id)
    )
    associations = result.scalars().all()

    if not associations:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Utilisateur non associé à aucun dossier",
        )

    # Si le frontend a précisé un dossier actif, on le valide
    if x_active_dossier:
        try:
            requested_id = int(x_active_dossier)
        except ValueError:
            raise HTTPException(status_code=400, detail="X-Active-Dossier invalide")

        if any(a.company_id == requested_id for a in associations):
            return requested_id

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accès refusé à ce dossier",
        )

    # Comportement par défaut : premier dossier (ordre d'adhésion)
    return associations[0].company_id


async def get_current_company_user(
    current_user: User = Depends(get_current_user),
    company_id: int    = Depends(get_current_company_id),
    db: AsyncSession   = Depends(get_db),
) -> CompanyUser:
    """Retourne la CompanyUser du dossier actif (contient rôle + permissions)."""
    result = await db.execute(
        select(CompanyUser).where(
            CompanyUser.user_id    == current_user.id,
            CompanyUser.company_id == company_id,
        )
    )
    cu = result.scalars().first()
    if not cu:
        raise HTTPException(status_code=403, detail="Accès refusé à ce dossier")
    return cu


# ─────────────────────────────────────────────────────────────────────────────
# Guards de rôle
# ─────────────────────────────────────────────────────────────────────────────

def require_role(allowed_roles: List[RoleEnum]):
    """Guard basé sur l'ancien RoleEnum (compatibilité)."""
    async def checker(
        current_user: User = Depends(get_current_user),
        db: AsyncSession   = Depends(get_db),
    ) -> User:
        result = await db.execute(
            select(CompanyUser).where(CompanyUser.user_id == current_user.id)
        )
        cu = result.scalars().first()
        if not cu or cu.role not in allowed_roles:
            raise HTTPException(status_code=403, detail="Permissions insuffisantes")
        return current_user
    return checker


def require_dossier_role(allowed: List[DossierRole]):
    """Guard basé sur le nouveau DossierRole métier."""
    async def checker(
        cu: CompanyUser = Depends(get_current_company_user),
    ) -> CompanyUser:
        if cu.dossier_role not in allowed:
            raise HTTPException(
                status_code=403,
                detail=f"Rôle requis : {[r.value for r in allowed]}",
            )
        return cu
    return checker


def require_can_validate_journal():
    """Guard : peut valider des écritures comptables."""
    async def checker(cu: CompanyUser = Depends(get_current_company_user)) -> CompanyUser:
        if not cu.can_validate_journal:
            raise HTTPException(
                status_code=403,
                detail="Vous n'avez pas la permission de valider des écritures comptables",
            )
        return cu
    return checker

