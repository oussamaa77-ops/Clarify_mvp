from pydantic import BaseModel
from typing import Optional, List
from datetime import date, datetime
from app.models.billing import InvoiceStatus, PaymentMethod, SupplierBillStatus, InvoiceType, QuoteStatus

class ClientSimple(BaseModel):
    id: int
    name: str
    ice: Optional[str] = None
    class Config:
        from_attributes = True

class QuoteItemBase(BaseModel):
    product_id: Optional[int] = None
    description: Optional[str] = None
    quantity: float
    unit_price: float
    vat_rate: float
class QuoteItemCreate(QuoteItemBase):
    pass
class QuoteItemResponse(QuoteItemBase):
    id: int
    quote_id: int
    class Config:
        from_attributes = True

class QuoteBase(BaseModel):
    client_id: int
    date: date
    valid_until: Optional[date] = None
class QuoteCreate(QuoteBase):
    items: List[QuoteItemCreate]
class QuoteResponse(QuoteBase):
    id: int
    company_id: int
    number: str
    status: QuoteStatus
    total_excl_tax: float
    vat_amount: float
    total_incl_tax: float
    created_at: datetime
    items: List[QuoteItemResponse]
    client: Optional[ClientSimple] = None
    class Config:
        from_attributes = True

class InvoiceItemBase(BaseModel):
    product_id: Optional[int] = None
    description: Optional[str] = None
    quantity: float
    unit_price: float
    vat_rate: float
class InvoiceItemCreate(InvoiceItemBase):
    pass
class InvoiceItemResponse(InvoiceItemBase):
    id: int
    invoice_id: int
    class Config:
        from_attributes = True

class InvoiceBase(BaseModel):
    client_id: int
    date: date
    due_date: Optional[date] = None
class InvoiceCreate(InvoiceBase):
    items: List[InvoiceItemCreate]
class InvoiceResponse(InvoiceBase):
    id: int
    company_id: int
    number: str
    type: InvoiceType
    parent_id: Optional[int] = None
    status: InvoiceStatus
    total_excl_tax: float
    vat_amount: float
    total_incl_tax: float
    created_at: datetime
    items: List[InvoiceItemResponse]
    client: Optional[ClientSimple] = None
    class Config:
        from_attributes = True

class PaymentBase(BaseModel):
    invoice_id: int
    date: date
    amount: float
    method: PaymentMethod
class PaymentCreate(PaymentBase):
    pass
class PaymentResponse(PaymentBase):
    id: int
    company_id: int
    created_at: datetime
    class Config:
        from_attributes = True

class SupplierBillItemBase(BaseModel):
    product_name: str
    quantity: float
    unit_price: float
    vat_rate: float
class SupplierBillItemCreate(SupplierBillItemBase):
    pass
class SupplierBillItemResponse(SupplierBillItemBase):
    id: int
    bill_id: int
    class Config:
        from_attributes = True

class SupplierBillBase(BaseModel):
    supplier_id: int
    date: date
class SupplierBillCreate(SupplierBillBase):
    items: List[SupplierBillItemCreate]
class SupplierBillResponse(SupplierBillBase):
    id: int
    company_id: int
    number: str
    status: SupplierBillStatus
    total_excl_tax: float
    vat_amount: float
    total_incl_tax: float
    created_at: datetime
    items: List[SupplierBillItemResponse]
    class Config:
        from_attributes = True
