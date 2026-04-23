import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.identity import User
from app.schemas.auth import UserCreate, UserResponse, Token
from app.services.auth import register_user_and_company
from app.utils.security import verify_password, create_access_token, get_current_user

router = APIRouter()

@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def register(user_in: UserCreate, db: AsyncSession = Depends(get_db)):
    """
    Register a new user and automatically create their company.
    """
    return await register_user_and_company(db, user_in)

@router.post("/login", response_model=Token)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db)
):
    """
    OAuth2 compatible token login, getting an access token for future requests.
    """
    # Find user by email (using form_data.username since OAuth2 expects username)
    result = await db.execute(select(User).where(User.email == form_data.username))
    user = result.scalars().first()
    
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")

    # Generate Token
    access_token_expires = datetime.timedelta(minutes=1440)
    access_token = create_access_token(
        subject=str(user.id), expires_delta=access_token_expires
    )
    
    return {"access_token": access_token, "token_type": "bearer"}

@router.get("/me", response_model=UserResponse)
async def read_users_me(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.models.identity import CompanyUser, Company
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(CompanyUser)
        .options(selectinload(CompanyUser.company))
        .where(CompanyUser.user_id == current_user.id)
    )
    associations = result.scalars().all()

    dossiers = [
        {
            "id": a.company.id,
            "name": a.company.name,
            # On change le nom de la clé ici directement :
            "my_role": a.dossier_role.value if a.dossier_role else "CE",
            "is_archived": a.company.is_archived or False,
        }
        for a in associations if a.company
    ]

    # Rôle dominant : CABINET > CE > COLLABORATEUR
    dossier_role = "CE"
    for a in associations:
        if a.dossier_role and a.dossier_role.value == "CABINET":
            dossier_role = "CABINET"
            break
        elif a.dossier_role and a.dossier_role.value == "COLLABORATEUR":
            dossier_role = "COLLABORATEUR"

    return {
        "id": current_user.id,
        "email": current_user.email,
        "full_name": current_user.full_name,
        "is_active": current_user.is_active,
        "dossier_role": dossier_role,
        "dossiers": dossiers,
    }
