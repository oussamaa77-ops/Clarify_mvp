from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
from fastapi import HTTPException, status
from typing import List
from app.models.crm import Client
from app.schemas.crm import ClientCreate, ClientUpdate

async def get_clients(db: AsyncSession, company_id: int, skip: int = 0, limit: int = 100, search: str = None) -> List[Client]:
    query = select(Client).where(Client.company_id == company_id)
    if search:
        query = query.where(or_(
            Client.name.ilike(f"%{search}%"),
            Client.ice.ilike(f"%{search}%"),
            Client.tax_id.ilike(f"%{search}%"),
            Client.city.ilike(f"%{search}%"),
            Client.email.ilike(f"%{search}%"),
        ))
    result = await db.execute(query.offset(skip).limit(limit))
    return result.scalars().all()

async def get_client(db: AsyncSession, client_id: int, company_id: int) -> Client:
    result = await db.execute(select(Client).where(Client.id == client_id, Client.company_id == company_id))
    client = result.scalars().first()
    if not client:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    return client

async def create_client(db: AsyncSession, obj_in: ClientCreate, company_id: int) -> Client:
    db_obj = Client(**obj_in.model_dump(), company_id=company_id)
    db.add(db_obj)
    await db.commit()
    await db.refresh(db_obj)
    return db_obj

async def update_client(db: AsyncSession, client_id: int, obj_in: ClientUpdate, company_id: int) -> Client:
    db_obj = await get_client(db, client_id, company_id)
    update_data = obj_in.model_dump(exclude_none=False, exclude_unset=False)
    for field, value in update_data.items():
        setattr(db_obj, field, value)
    await db.commit()
    await db.refresh(db_obj)
    return db_obj

async def delete_client(db: AsyncSession, client_id: int, company_id: int):
    db_obj = await get_client(db, client_id, company_id)
    await db.delete(db_obj)
    await db.commit()
    return {"message": "Client deleted successfully"}
