from sqlalchemy import Column, String, Integer, Float, ForeignKey, DateTime, Date
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.models.base import Base

class TaxRate(Base):
    __tablename__ = "tax_rates"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    name = Column(String, nullable=False) # e.g. "TVA 20%"
    rate = Column(Float, nullable=False) # e.g. 20.0
    is_default = Column(Integer, default=0) # 1 for default, 0 for false (SQLite interop)

class TaxReport(Base):
    __tablename__ = "tax_reports"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    total_sales_tax = Column(Float, default=0.0) # VAT collected on sales
    total_purchase_tax = Column(Float, default=0.0) # VAT paid on purchases
    net_tax_due = Column(Float, default=0.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Document(Base):
    __tablename__ = "documents"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    name = Column(String, nullable=False)
    file_url = Column(String, nullable=False)
    file_type = Column(String)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Subscription(Base):
    __tablename__ = "subscriptions"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    plan_name = Column(String, nullable=False)
    valid_until = Column(DateTime(timezone=True))
    is_active = Column(Integer, default=1)

class Notification(Base):
    __tablename__ = "notifications"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    title = Column(String, nullable=False)
    content = Column(String, nullable=False)
    is_read = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
