from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from fastapi import HTTPException, status
from app.models.identity import User, Company, CompanyUser, RoleEnum, DossierRole
from app.schemas.auth import UserCreate
from app.utils.security import get_password_hash

async def register_user_and_company(db: AsyncSession, user_in: UserCreate) -> User:
    result = await db.execute(select(User).where(User.email == user_in.email))
    if result.scalars().first() is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User with this email already exists"
        )

    new_user = User(
        email=user_in.email,
        hashed_password=get_password_hash(user_in.password),
        is_active=True
    )
    db.add(new_user)
    await db.flush()

    new_company = Company(
        name=user_in.company_name,
        ice=user_in.company_ice,
        tax_id=user_in.company_if,
        cabinet_user_id=new_user.id if user_in.dossier_role == "CABINET" else None,
    )
    db.add(new_company)
    await db.flush()

    # Déterminer le rôle
    role = DossierRole[user_in.dossier_role] if user_in.dossier_role in DossierRole.__members__ else DossierRole.CE

    company_user = CompanyUser(
      user_id=new_user.id,
      company_id=new_company.id,
      role=RoleEnum.ADMIN,
      dossier_role=role,
      can_validate_journal=role == DossierRole.CABINET,
      can_view_bank=True,
      can_invite_members=role in [DossierRole.CABINET, DossierRole.CE],
    )
    db.add(company_user)
    await db.commit()
    await db.refresh(new_user)
    return new_user