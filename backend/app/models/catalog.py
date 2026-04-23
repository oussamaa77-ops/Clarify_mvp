import enum
from sqlalchemy import Column, String, Integer, Float, ForeignKey, DateTime, Enum, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.models.base import Base

class ProductType(str, enum.Enum):
    PRODUCT = "PRODUCT"
    SERVICE = "SERVICE"

class Product(Base):
    __tablename__ = "products"
    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text)
    price = Column(Float, nullable=False)
    vat_rate = Column(Float, nullable=False) # e.g. 20.0, 14.0, 10.0, 7.0
    sku = Column(String)
    type = Column(Enum(ProductType), default=ProductType.PRODUCT)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company = relationship("Company", back_populates="products")
