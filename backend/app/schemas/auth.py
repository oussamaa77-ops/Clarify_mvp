from pydantic import BaseModel, EmailStr
from typing import Optional, List

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    company_name: str
    company_ice: Optional[str] = None
    company_if: Optional[str] = None
    dossier_role: str = "CABINET"  # CABINET ou CE

class DossierSummary(BaseModel):
    id: int
    name: str
    my_role: str
    is_archived: bool
    class Config:
        from_attributes = True

class UserResponse(BaseModel):
    id: int
    email: EmailStr
    full_name: Optional[str] = None
    is_active: bool
    dossier_role: Optional[str] = None
    dossiers: List[DossierSummary] = []
    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str