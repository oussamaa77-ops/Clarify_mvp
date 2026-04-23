from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.identity import User, Company
from app.schemas.system import CompanyUpdate, CompanyResponse
from app.utils.security import get_current_user, get_current_company_id

router = APIRouter()

@router.get("/company", response_model=CompanyResponse)
async def get_company_settings(
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    result = await db.execute(select(Company).where(Company.id == company_id))
    company = result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    return company

@router.put("/company", response_model=CompanyResponse)
async def update_company_settings(
    company_in: CompanyUpdate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    result = await db.execute(select(Company).where(Company.id == company_id))
    company = result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    
    update_data = company_in.dict(exclude_unset=True)
    for key, value in update_data.items():
        setattr(company, key, value)
        
    await db.commit()
    await db.refresh(company)
    return company
