from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List

from app.database import get_db
from app.models.identity import User
from app.schemas.crm import ClientCreate, ClientUpdate, ClientResponse
from app.services.crm import get_clients, get_client, create_client, update_client, delete_client
from app.utils.security import get_current_user, require_role, get_current_company_id
from app.models.identity import RoleEnum

router = APIRouter()

# Just for clients for now, we can add suppliers following the same pattern

@router.get("/clients", response_model=List[ClientResponse])
async def read_clients(
    skip: int = 0,
    limit: int = 100,
    search: str = None,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_clients(db, company_id=company_id, skip=skip, limit=limit, search=search)

@router.post("/clients", response_model=ClientResponse)
async def create_new_client(
    client_in: ClientCreate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await create_client(db, client_in, company_id=company_id)

@router.get("/clients/{client_id}", response_model=ClientResponse)
async def read_client(
    client_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_client(db, client_id, company_id=company_id)

@router.put("/clients/{client_id}", response_model=ClientResponse)
async def update_existing_client(
    client_id: int,
    client_in: ClientUpdate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await update_client(db, client_id, client_in, company_id=company_id)

@router.delete("/clients/{client_id}")
async def delete_existing_client(
    client_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    # Only Admin or Accountant can delete
    current_user: User = Depends(require_role([RoleEnum.ADMIN, RoleEnum.ACCOUNTANT])) 
):
    return await delete_client(db, client_id, company_id=company_id)
