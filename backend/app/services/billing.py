from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func as sql_func
from sqlalchemy.orm import selectinload
from fastapi import HTTPException, status
from typing import List
from datetime import datetime
from app.models.billing import Invoice, InvoiceItem, InvoiceStatus, Payment, SupplierBill, SupplierBillItem, SupplierBillStatus, InvoiceType, Quote, QuoteItem, QuoteStatus
from app.schemas.billing import InvoiceCreate, PaymentCreate, SupplierBillCreate
from app.services.accounting import generate_accounting_entries_for_invoice, generate_accounting_entries_for_payment, generate_accounting_entries_for_supplier_bill

async def generate_invoice_number(db: AsyncSession, company_id: int) -> str:
    current_year = datetime.now().year
    result = await db.execute(
        select(sql_func.count(Invoice.id))
        .where(Invoice.company_id == company_id)
        .where(sql_func.extract('year', Invoice.date) == current_year)
    )
    count = result.scalar() or 0
    next_number = count + 1
    return f"FAC-{current_year}-{next_number:04d}"

async def create_invoice(db: AsyncSession, obj_in: InvoiceCreate, company_id: int) -> Invoice:
    total_excl_tax = 0.0
    vat_amount = 0.0
    for item in obj_in.items:
        line_total_excl = item.quantity * item.unit_price
        line_vat = line_total_excl * (item.vat_rate / 100.0)
        total_excl_tax += line_total_excl
        vat_amount += line_vat
    total_incl_tax = total_excl_tax + vat_amount
    invoice_number = await generate_invoice_number(db, company_id)
    db_invoice = Invoice(
        company_id=company_id,
        client_id=obj_in.client_id,
        number=invoice_number,
        date=obj_in.date,
        due_date=obj_in.due_date,
        total_excl_tax=total_excl_tax,
        vat_amount=vat_amount,
        total_incl_tax=total_incl_tax,
        status=InvoiceStatus.SENT
    )
    db.add(db_invoice)
    await db.flush()
    await db.refresh(db_invoice)
    for item in obj_in.items:
        db_item = InvoiceItem(
            invoice_id=db_invoice.id,
            product_id=item.product_id,
            description=getattr(item, "description", None),
            quantity=item.quantity,
            unit_price=item.unit_price,
            vat_rate=item.vat_rate
        )
        db.add(db_item)
    await db.commit()
    await generate_accounting_entries_for_invoice(db, db_invoice)
    await db.commit()
    result = await db.execute(
        select(Invoice)
        .options(selectinload(Invoice.items), selectinload(Invoice.client))
        .where(Invoice.id == db_invoice.id)
    )
    return result.scalars().first()

async def get_invoices(db: AsyncSession, company_id: int, skip: int = 0, limit: int = 100, search: str = None, status: str = None) -> List[Invoice]:
    from sqlalchemy import or_
    from app.models.crm import Client
    query = select(Invoice).options(selectinload(Invoice.items), selectinload(Invoice.client)).where(Invoice.company_id == company_id)
    if search:
        query = query.join(Client, Invoice.client_id == Client.id).where(
            or_(Invoice.number.ilike(f"%{search}%"), Client.name.ilike(f"%{search}%"))
        )
    if status:
        query = query.where(Invoice.status == status)
    result = await db.execute(query.offset(skip).limit(limit))
    return result.scalars().all()

async def get_invoice(db: AsyncSession, invoice_id: int, company_id: int) -> Invoice:
    result = await db.execute(
        select(Invoice)
        .options(selectinload(Invoice.items), selectinload(Invoice.client))
        .where(Invoice.id == invoice_id, Invoice.company_id == company_id)
    )
    invoice = result.scalars().first()
    if not invoice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found")
    return invoice

async def generate_credit_note(db: AsyncSession, invoice_id: int, company_id: int) -> Invoice:
    original = await get_invoice(db, invoice_id, company_id)
    if original.type == InvoiceType.CREDIT_NOTE:
        raise HTTPException(status_code=400, detail="Cannot create credit note from a credit note")
    year = datetime.now().year
    count_result = await db.execute(select(sql_func.count(Invoice.id)).where(Invoice.company_id == company_id))
    count = count_result.scalar() or 0
    credit_note = Invoice(
        company_id=company_id,
        client_id=original.client_id,
        number=f"AV-{year}-{(count+1):04d}",
        date=original.date,
        due_date=original.due_date,
        type=InvoiceType.CREDIT_NOTE,
        parent_id=original.id,
        status=InvoiceStatus.SENT,
        total_excl_tax=-original.total_excl_tax,
        vat_amount=-original.vat_amount,
        total_incl_tax=-original.total_incl_tax
    )
    db.add(credit_note)
    await db.commit()
    await db.refresh(credit_note)
    return credit_note

async def register_payment(db: AsyncSession, obj_in: PaymentCreate, company_id: int) -> Payment:
    invoice = await get_invoice(db, obj_in.invoice_id, company_id)
    payment = Payment(
        company_id=company_id,
        invoice_id=obj_in.invoice_id,
        date=obj_in.date,
        amount=obj_in.amount,
        method=obj_in.method
    )
    db.add(payment)
    invoice.status = InvoiceStatus.PAID
    await db.commit()
    await db.refresh(payment)
    await generate_accounting_entries_for_payment(db, payment)
    await db.commit()
    return payment

async def get_payments(db: AsyncSession, company_id: int, skip: int = 0, limit: int = 100) -> List[Payment]:
    result = await db.execute(
        select(Payment)
        .where(Payment.company_id == company_id)
        .offset(skip)
        .limit(limit)
    )
    return result.scalars().all()

async def create_supplier_bill(db: AsyncSession, obj_in: SupplierBillCreate, company_id: int) -> SupplierBill:
    total_excl_tax = 0.0
    vat_amount = 0.0
    for item in obj_in.items:
        line_total = item.quantity * item.unit_price
        line_vat = line_total * (item.vat_rate / 100.0)
        total_excl_tax += line_total
        vat_amount += line_vat
    total_incl_tax = total_excl_tax + vat_amount
    year = datetime.now().year
    count_result = await db.execute(select(sql_func.count(SupplierBill.id)).where(SupplierBill.company_id == company_id))
    count = count_result.scalar() or 0
    bill = SupplierBill(
        company_id=company_id,
        supplier_id=obj_in.supplier_id,
        number=f"ACH-{year}-{(count+1):04d}",
        date=obj_in.date,
        total_excl_tax=total_excl_tax,
        vat_amount=vat_amount,
        total_incl_tax=total_incl_tax
    )
    db.add(bill)
    await db.flush()
    for item in obj_in.items:
        db_item = SupplierBillItem(
            bill_id=bill.id,
            product_name=item.product_name,
            quantity=item.quantity,
            unit_price=item.unit_price,
            vat_rate=item.vat_rate
        )
        db.add(db_item)
    await db.commit()
    await db.refresh(bill)
    await generate_accounting_entries_for_supplier_bill(db, bill)
    await db.commit()
    return bill

async def get_supplier_bills(db: AsyncSession, company_id: int, skip: int = 0, limit: int = 100) -> List[SupplierBill]:
    result = await db.execute(
        select(SupplierBill)
        .options(selectinload(SupplierBill.items))
        .where(SupplierBill.company_id == company_id)
        .offset(skip).limit(limit)
    )
    return result.scalars().all()

async def get_supplier_bill(db: AsyncSession, bill_id: int, company_id: int) -> SupplierBill:
    result = await db.execute(
        select(SupplierBill)
        .options(selectinload(SupplierBill.items))
        .where(SupplierBill.id == bill_id, SupplierBill.company_id == company_id)
    )
    bill = result.scalars().first()
    if not bill:
        raise HTTPException(status_code=404, detail="Supplier bill not found")
    return bill

async def create_quote(db: AsyncSession, obj_in, company_id: int) -> Quote:
    total_excl_tax = 0.0
    vat_amount = 0.0
    for item in obj_in.items:
        line_total = item.quantity * item.unit_price
        line_vat = line_total * (item.vat_rate / 100.0)
        total_excl_tax += line_total
        vat_amount += line_vat
    total_incl_tax = total_excl_tax + vat_amount
    year = datetime.now().year
    count_result = await db.execute(select(sql_func.count(Quote.id)).where(Quote.company_id == company_id))
    count = count_result.scalar() or 0
    quote = Quote(
        company_id=company_id,
        client_id=obj_in.client_id,
        number=f"DEV-{year}-{(count+1):04d}",
        date=obj_in.date,
        valid_until=obj_in.valid_until,
        total_excl_tax=total_excl_tax,
        vat_amount=vat_amount,
        total_incl_tax=total_incl_tax
    )
    db.add(quote)
    await db.flush()
    for item in obj_in.items:
        db_item = QuoteItem(
            quote_id=quote.id,
            product_id=item.product_id,
            description=getattr(item, "description", None),
            quantity=item.quantity,
            unit_price=item.unit_price,
            vat_rate=item.vat_rate
        )
        db.add(db_item)
    await db.commit()
    await db.refresh(quote)
    return quote

async def get_quotes(db: AsyncSession, company_id: int, skip: int = 0, limit: int = 100) -> List[Quote]:
    result = await db.execute(
        select(Quote)
        .options(selectinload(Quote.items), selectinload(Quote.client))
        .where(Quote.company_id == company_id)
        .offset(skip).limit(limit)
    )
    return result.scalars().all()

async def get_quote(db: AsyncSession, quote_id: int, company_id: int):
    result = await db.execute(
        select(Quote)
        .options(selectinload(Quote.items), selectinload(Quote.client))
        .where(Quote.id == quote_id, Quote.company_id == company_id)
    )
    return result.scalars().first()
