from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List

from app.database import get_db
from app.models.identity import User, RoleEnum
from app.schemas.catalog import ProductCreate, ProductUpdate, ProductResponse
from app.services.catalog import get_products, get_product, create_product, update_product, delete_product
from app.utils.security import get_current_user, require_role, get_current_company_id

router = APIRouter()

@router.get("/products", response_model=List[ProductResponse])
async def read_products(
    skip: int = 0, 
    limit: int = 100, 
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_products(db, company_id=company_id, skip=skip, limit=limit)

@router.post("/products", response_model=ProductResponse)
async def create_new_product(
    product_in: ProductCreate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(require_role([RoleEnum.ADMIN, RoleEnum.ACCOUNTANT]))
):
    return await create_product(db, product_in, company_id=company_id)

@router.get("/products/{product_id}", response_model=ProductResponse)
async def read_product(
    product_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_product(db, product_id, company_id=company_id)

@router.put("/products/{product_id}", response_model=ProductResponse)
async def update_existing_product(
    product_id: int,
    product_in: ProductUpdate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(require_role([RoleEnum.ADMIN, RoleEnum.ACCOUNTANT]))
):
    return await update_product(db, product_id, product_in, company_id=company_id)

@router.delete("/products/{product_id}")
async def delete_existing_product(
    product_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(require_role([RoleEnum.ADMIN, RoleEnum.ACCOUNTANT])) 
):
    return await delete_product(db, product_id, company_id=company_id)
