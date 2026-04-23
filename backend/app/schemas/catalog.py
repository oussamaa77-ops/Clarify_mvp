from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from app.models.catalog import ProductType

class ProductBase(BaseModel):
    name: str
    description: Optional[str] = None
    price: float
    vat_rate: float
    sku: Optional[str] = None
    type: ProductType = ProductType.PRODUCT

class ProductCreate(ProductBase):
    pass

class ProductUpdate(ProductBase):
    name: Optional[str] = None
    price: Optional[float] = None
    vat_rate: Optional[float] = None

class ProductResponse(ProductBase):
    id: int
    company_id: int
    created_at: datetime

    class Config:
        from_attributes = True
