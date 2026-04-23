from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from fastapi import HTTPException, status
from typing import List
from app.models.catalog import Product
from app.schemas.catalog import ProductCreate, ProductUpdate

async def get_products(db: AsyncSession, company_id: int, skip: int = 0, limit: int = 100) -> List[Product]:
    result = await db.execute(select(Product).where(Product.company_id == company_id).offset(skip).limit(limit))
    return result.scalars().all()

async def get_product(db: AsyncSession, product_id: int, company_id: int) -> Product:
    result = await db.execute(select(Product).where(Product.id == product_id, Product.company_id == company_id))
    product = result.scalars().first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    return product

async def create_product(db: AsyncSession, obj_in: ProductCreate, company_id: int) -> Product:
    db_obj = Product(**obj_in.dict(), company_id=company_id)
    db.add(db_obj)
    await db.commit()
    await db.refresh(db_obj)
    return db_obj

async def update_product(db: AsyncSession, product_id: int, obj_in: ProductUpdate, company_id: int) -> Product:
    db_obj = await get_product(db, product_id, company_id)
    update_data = obj_in.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(db_obj, field, value)
    await db.commit()
    await db.refresh(db_obj)
    return db_obj

async def delete_product(db: AsyncSession, product_id: int, company_id: int):
    db_obj = await get_product(db, product_id, company_id)
    await db.delete(db_obj)
    await db.commit()
    return {"message": "Product deleted successfully"}
