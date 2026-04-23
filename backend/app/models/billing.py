import enum
from sqlalchemy import Column, String, Integer, Float, ForeignKey, DateTime, Enum, Date
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.models.base import Base

class QuoteStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    SENT = "SENT"
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"

class InvoiceType(str, enum.Enum):
    STANDARD = "STANDARD"
    CREDIT_NOTE = "CREDIT_NOTE"

class InvoiceStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    SENT = "SENT"
    PAID = "PAID"
    OVERDUE = "OVERDUE"
    CANCELLED = "CANCELLED"

class PaymentMethod(str, enum.Enum):
    CASH = "CASH"
    BANK_TRANSFER = "BANK_TRANSFER"
    CHEQUE = "CHEQUE"
    CARD = "CARD"

class Quote(Base):
    __tablename__ = "quotes"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    number = Column(String, nullable=False)
    date = Column(Date, nullable=False)
    valid_until = Column(Date)
    status = Column(Enum(QuoteStatus), default=QuoteStatus.DRAFT)
    total_excl_tax = Column(Float, default=0.0)
    vat_amount = Column(Float, default=0.0)
    total_incl_tax = Column(Float, default=0.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company = relationship("Company", back_populates="quotes")
    client = relationship("Client", back_populates="quotes")
    items = relationship("QuoteItem", back_populates="quote", cascade="all, delete-orphan")

class QuoteItem(Base):
    __tablename__ = "quote_items"
    id = Column(Integer, primary_key=True, index=True)
    quote_id = Column(Integer, ForeignKey("quotes.id"), nullable=False)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=True)
    quantity = Column(Float, nullable=False, default=1.0)
    unit_price = Column(Float, nullable=False)
    vat_rate = Column(Float, nullable=False)

    quote = relationship("Quote", back_populates="items")
    product = relationship("Product")

class Invoice(Base):
    __tablename__ = "invoices"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    number = Column(String, nullable=False) # e.g., FAC-YYYY-XXXX
    date = Column(Date, nullable=False)
    due_date = Column(Date)
    type = Column(Enum(InvoiceType), default=InvoiceType.STANDARD, nullable=False)
    parent_id = Column(Integer, ForeignKey("invoices.id"), nullable=True)
    status = Column(Enum(InvoiceStatus), default=InvoiceStatus.DRAFT)
    total_excl_tax = Column(Float, default=0.0)
    vat_amount = Column(Float, default=0.0)
    total_incl_tax = Column(Float, default=0.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company = relationship("Company", back_populates="invoices")
    client = relationship("Client", back_populates="invoices")
    items = relationship("InvoiceItem", back_populates="invoice", cascade="all, delete-orphan")
    payments = relationship("Payment", back_populates="invoice")

class InvoiceItem(Base):
    __tablename__ = "invoice_items"
    id = Column(Integer, primary_key=True, index=True)
    invoice_id = Column(Integer, ForeignKey("invoices.id"), nullable=False)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=True)
    quantity = Column(Float, nullable=False, default=1.0)
    unit_price = Column(Float, nullable=False)
    vat_rate = Column(Float, nullable=False)

    invoice = relationship("Invoice", back_populates="items")
    product = relationship("Product")

class Payment(Base):
    __tablename__ = "payments"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    
    # Indispensable : permettre le NULL pour l'un ou l'autre pour éviter l'IntegrityError
    invoice_id = Column(Integer, ForeignKey("invoices.id"), nullable=True) 
    supplier_bill_id = Column(Integer, ForeignKey("supplier_bills.id"), nullable=True)
    
    date = Column(Date, nullable=False)
    amount = Column(Float, nullable=False)
    method = Column(Enum(PaymentMethod), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    invoice = relationship("Invoice", back_populates="payments")
    supplier_bill = relationship("SupplierBill")

class SupplierBillStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    PAID = "PAID"
    CANCELLED = "CANCELLED"

class SupplierBill(Base):
    __tablename__ = "supplier_bills"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    supplier_id = Column(Integer, ForeignKey("suppliers.id"), nullable=False)
    number = Column(String, nullable=False) # e.g. ACH-YYYY-XXXX
    date = Column(Date, nullable=False)
    status = Column(Enum(SupplierBillStatus), default=SupplierBillStatus.DRAFT)
    total_excl_tax = Column(Float, default=0.0)
    vat_amount = Column(Float, default=0.0)
    total_incl_tax = Column(Float, default=0.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company = relationship("Company")
    supplier = relationship("Supplier")
    items = relationship("SupplierBillItem", back_populates="bill", cascade="all, delete-orphan")

class SupplierBillItem(Base):
    __tablename__ = "supplier_bill_items"
    id = Column(Integer, primary_key=True, index=True)
    bill_id = Column(Integer, ForeignKey("supplier_bills.id"), nullable=False)
    product_name = Column(String, nullable=False)
    quantity = Column(Float, nullable=False, default=1.0)
    unit_price = Column(Float, nullable=False)
    vat_rate = Column(Float, nullable=False)

    bill = relationship("SupplierBill", back_populates="items")
