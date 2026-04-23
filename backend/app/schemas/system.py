from pydantic import BaseModel
from typing import Optional
from datetime import datetime

class CompanyUpdate(BaseModel):
    name: Optional[str] = None
    ice: Optional[str] = None
    tax_id: Optional[str] = None
    rc: Optional[str] = None
    address: Optional[str] = None

class CompanyResponse(BaseModel):
    id: int
    name: str
    ice: Optional[str] = None
    tax_id: Optional[str] = None
    rc: Optional[str] = None
    address: Optional[str] = None
    logo_url: Optional[str] = None

    class Config:
        from_attributes = True

class DocumentBase(BaseModel):
    name: str
    file_type: Optional[str] = None
    file_url: str

class DocumentCreate(DocumentBase):
    pass

class DocumentResponse(DocumentBase):
    id: int
    company_id: int
    created_at: datetime

    class Config:
        from_attributes = True
