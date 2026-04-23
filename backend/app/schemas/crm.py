from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime

class ClientBase(BaseModel):
    name: str
    ice: Optional[str] = None
    tax_id: Optional[str] = None
    address: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    city: Optional[str] = None

class ClientCreate(ClientBase):
    pass

class ClientUpdate(ClientBase):
    name: Optional[str] = None

class ClientResponse(ClientBase):
    id: int
    company_id: int
    created_at: datetime

    class Config:
        from_attributes = True

class SupplierBase(BaseModel):
    name: str
    ice: Optional[str] = None
    tax_id: Optional[str] = None
    address: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    city: Optional[str] = None

class SupplierCreate(SupplierBase):
    pass

class SupplierUpdate(SupplierBase):
    name: Optional[str] = None

class SupplierResponse(SupplierBase):
    id: int
    company_id: int
    created_at: datetime

    class Config:
        from_attributes = True
