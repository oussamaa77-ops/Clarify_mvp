from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List

from app.database import get_db
from app.models.identity import User, RoleEnum
from app.models.billing import Quote
from app.schemas.billing import InvoiceCreate, InvoiceResponse, InvoiceStatus, PaymentCreate, PaymentResponse, SupplierBillCreate, SupplierBillResponse, QuoteCreate, QuoteResponse
from app.services.billing import create_invoice, get_invoices, get_invoice, register_payment, get_payments, create_supplier_bill, get_supplier_bills, get_supplier_bill, generate_credit_note, create_quote, get_quotes, get_quote
from app.utils.security import get_current_user, require_role, get_current_company_id

router = APIRouter()

@router.get("/invoices", response_model=List[InvoiceResponse])
async def read_invoices(
    skip: int = 0,
    limit: int = 100,
    search: str = None,
    status: str = None,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_invoices(db, company_id=company_id, skip=skip, limit=limit, search=search, status=status)

@router.post("/invoices", response_model=InvoiceResponse)
async def create_new_invoice(
    invoice_in: InvoiceCreate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(require_role([RoleEnum.ADMIN, RoleEnum.ACCOUNTANT]))
):
    return await create_invoice(db, invoice_in, company_id=company_id)

@router.get("/invoices/{invoice_id}", response_model=InvoiceResponse)
async def read_invoice(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_invoice(db, invoice_id, company_id=company_id)

@router.post("/invoices/{invoice_id}/credit-note", response_model=InvoiceResponse)
async def create_credit_note(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(require_role([RoleEnum.ADMIN, RoleEnum.ACCOUNTANT]))
):
    return await generate_credit_note(db, invoice_id, company_id=company_id)

from fastapi.responses import Response
from app.utils.pdf import generate_invoice_pdf
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.models.identity import Company
from app.models.crm import Client
from app.models.billing import Invoice

@router.get("/invoices/{invoice_id}/pdf")
async def download_invoice_pdf(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    # Explicitly load relationships for the PDF
    result = await db.execute(
        select(Invoice)
        .options(selectinload(Invoice.items), selectinload(Invoice.company), selectinload(Invoice.client))
        .where(Invoice.id == invoice_id, Invoice.company_id == company_id)
    )
    invoice = result.scalars().first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
        
    pdf_bytes = generate_invoice_pdf(invoice, invoice.items, invoice.company, invoice.client)
    
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={invoice.number}.pdf"}
    )

@router.post("/payments", response_model=PaymentResponse)
async def create_new_payment(
    payment_in: PaymentCreate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(require_role([RoleEnum.ADMIN, RoleEnum.ACCOUNTANT]))
):
    return await register_payment(db, payment_in, company_id=company_id)

@router.get("/payments", response_model=List[PaymentResponse])
async def read_payments(
    skip: int = 0, 
    limit: int = 100, 
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_payments(db, company_id=company_id, skip=skip, limit=limit)

@router.post("/supplier-bills", response_model=SupplierBillResponse)
async def create_new_supplier_bill(
    bill_in: SupplierBillCreate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(require_role([RoleEnum.ADMIN, RoleEnum.ACCOUNTANT]))
):
    return await create_supplier_bill(db, bill_in, company_id=company_id)

@router.get("/supplier-bills", response_model=List[SupplierBillResponse])
async def read_supplier_bills(
    skip: int = 0, 
    limit: int = 100, 
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_supplier_bills(db, company_id=company_id, skip=skip, limit=limit)

@router.get("/supplier-bills/{bill_id}", response_model=SupplierBillResponse)
async def read_supplier_bill(
    bill_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_supplier_bill(db, bill_id, company_id=company_id)

# --- Quotes ---

@router.post("/quotes", response_model=QuoteResponse)
async def create_new_quote(
    quote_in: QuoteCreate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await create_quote(db, quote_in, company_id)

@router.get("/quotes", response_model=List[QuoteResponse])
async def read_quotes(
    skip: int = 0, limit: int = 100,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    return await get_quotes(db, company_id, skip, limit)

@router.get("/quotes/{quote_id}", response_model=QuoteResponse)
async def read_quote(
    quote_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    quote = await get_quote(db, quote_id, company_id)
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote

@router.get("/quotes/{quote_id}/pdf")
async def generate_quote_pdf(
    quote_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    from sqlalchemy.orm import selectinload
    import io
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    from fastapi.responses import StreamingResponse

    result = await db.execute(
        select(Quote)
        .options(selectinload(Quote.company), selectinload(Quote.client), selectinload(Quote.items))
        .where(Quote.id == quote_id, Quote.company_id == company_id)
    )
    quote = result.scalar_one_or_none()
    
    if not quote:
         raise HTTPException(status_code=404, detail="Quote not found")
         
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    
    c.setFont("Helvetica-Bold", 16)
    c.drawString(50, height - 50, "DEVIS")
    c.setFont("Helvetica", 12)
    c.drawString(50, height - 70, f"Numéro: {quote.number}")
    c.drawString(50, height - 90, f"Date: {quote.date}")
    
    if quote.valid_until:
        c.drawString(50, height - 110, f"Valable jusqu'au: {quote.valid_until}")
        
    c.drawString(50, height - 140, "Émetteur:")
    c.drawString(50, height - 160, quote.company.name)
    
    c.drawString(300, height - 140, "Client (Prospect):")
    c.drawString(300, height - 160, quote.client.name)
    if quote.client.address:
        c.drawString(300, height - 180, quote.client.address)
    
    y = height - 250
    c.setFont("Helvetica-Bold", 10)
    c.drawString(50, y, "Description")
    c.drawString(300, y, "Qté")
    c.drawString(380, y, "PU (HT)")
    c.drawString(480, y, "Total (HT)")
    
    y -= 20
    c.setFont("Helvetica", 10)
    for item in quote.items:
        c.drawString(50, y, f"Produit ID {item.product_id}" if item.product_id else "Article")
        c.drawString(300, y, str(item.quantity))
        c.drawString(380, y, f"{item.unit_price:.2f}")
        c.drawString(480, y, f"{(item.quantity * item.unit_price):.2f}")
        y -= 20
        
    y -= 20
    c.setFont("Helvetica-Bold", 12)
    c.drawString(350, y, "Total HT:")
    c.drawString(450, y, f"{quote.total_excl_tax:.2f} MAD")
    y -= 20
    c.drawString(350, y, "TVA:")
    c.drawString(450, y, f"{quote.vat_amount:.2f} MAD")
    y -= 20
    c.drawString(350, y, "Total TTC:")
    c.drawString(450, y, f"{quote.total_incl_tax:.2f} MAD")
    
    c.save()
    buffer.seek(0)
    
    headers = {
        'Content-Disposition': f'attachment; filename="devis_{quote.number}.pdf"'
    }
    return StreamingResponse(buffer, media_type="application/pdf", headers=headers)

@router.post("/invoices/{doc_id}/pay")
async def pay_invoice_manually(
    doc_id: int, 
    db: AsyncSession = Depends(get_db), 
    company_id: int = Depends(get_current_company_id)
):
    # Récupérer la facture
    res = await db.execute(select(Invoice).where(Invoice.id == doc_id, Invoice.company_id == company_id))
    invoice = res.scalar_one_or_none()
    
    if not invoice: raise HTTPException(status_code=404, detail="Facture non trouvée")
    
    # Créer le paiement via la logique OCR (réutilisable)
    from app.routers.ocr import _record_payment
    await _record_payment(db, {"montant_ttc": invoice.total_incl_tax}, company_id, invoice_id=doc_id)
    
    invoice.status = InvoiceStatus.PAID
    await db.commit()
    return {"message": "Facture marquée comme payée"}
@router.post("/supplier-bills/{doc_id}/pay")
async def pay_bill_manually(
    doc_id: int, 
    db: AsyncSession = Depends(get_db), 
    company_id: int = Depends(get_current_company_id)
):
    # Récupérer l'achat
    res = await db.execute(select(SupplierBill).where(SupplierBill.id == doc_id, SupplierBill.company_id == company_id))
    bill = res.scalar_one_or_none()
    
    if not bill: raise HTTPException(status_code=404, detail="Facture fournisseur non trouvée")
    
    from app.routers.ocr import _record_payment
    await _record_payment(db, {"montant_ttc": bill.total_incl_tax}, company_id, bill_id=doc_id)
    
    bill.status = SupplierBillStatus.PAID
    await db.commit()
    return {"message": "Achat marqué comme payé"}