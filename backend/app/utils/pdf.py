from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_RIGHT, TA_CENTER, TA_LEFT
import io

def generate_invoice_pdf(invoice, items, company, client) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4,
        rightMargin=1.5*cm, leftMargin=1.5*cm,
        topMargin=1.5*cm, bottomMargin=1.5*cm)

    styles = getSampleStyleSheet()
    story = []

    # Styles
    title_style = ParagraphStyle("title", fontSize=22, textColor=colors.HexColor("#1e3a5f"), spaceAfter=4)
    bold_style = ParagraphStyle("bold", fontSize=10, fontName="Helvetica-Bold")
    normal_style = ParagraphStyle("normal", fontSize=9, fontName="Helvetica", leading=14)
    right_style = ParagraphStyle("right", fontSize=9, alignment=TA_RIGHT)
    small_gray = ParagraphStyle("small", fontSize=8, textColor=colors.gray)

    # Header table: company info left, invoice title right
    company_name = getattr(company, "name", "")
    company_ice = getattr(company, "ice", "") or ""
    company_if = getattr(company, "tax_id", "") or ""
    company_rc = getattr(company, "rc", "") or ""
    company_addr = getattr(company, "address", "") or ""

    header_data = [[
        Paragraph(f"<b>{company_name}</b>", ParagraphStyle("cn", fontSize=14, fontName="Helvetica-Bold")),
        Paragraph("<b>FACTURE</b>", ParagraphStyle("ft", fontSize=24, fontName="Helvetica-Bold", alignment=TA_RIGHT, textColor=colors.HexColor("#1e3a5f")))
    ],[
        Paragraph(f"ICE: {company_ice} | IF: {company_if}<br/>RC: {company_rc}<br/>{company_addr}", small_gray),
        Paragraph(f"<b>N° {invoice.number}</b>", ParagraphStyle("fn", fontSize=12, alignment=TA_RIGHT, fontName="Helvetica-Bold"))
    ]]
    header_table = Table(header_data, colWidths=[10*cm, 8*cm])
    header_table.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
    ]))
    story.append(header_table)
    story.append(Spacer(1, 0.5*cm))

    # Divider
    story.append(Table([[""]], colWidths=[18*cm], rowHeights=[1]))
    story.append(Spacer(1, 0.3*cm))

    # Client info + invoice dates
    client_name = getattr(client, "name", "")
    client_ice = getattr(client, "ice", "") or ""
    client_addr = getattr(client, "address", "") or ""
    due_date = invoice.due_date if invoice.due_date else "A reception"

    details_data = [[
        Paragraph(f"<b>Facture a:</b><br/>{client_name}<br/>ICE: {client_ice}<br/>{client_addr}", normal_style),
        Paragraph(f"<b>Date:</b> {invoice.date}<br/><b>Echeance:</b> {due_date}", ParagraphStyle("rd", fontSize=9, alignment=TA_RIGHT, leading=16))
    ]]
    details_table = Table(details_data, colWidths=[10*cm, 8*cm])
    details_table.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "TOP")]))
    story.append(details_table)
    story.append(Spacer(1, 0.6*cm))

    # Items table
    table_data = [["Description", "Qte", "P.U (HT)", "TVA", "Total HT"]]
    for item in items:
        # Priorité : description libre → nom du produit → fallback générique
        if getattr(item, "description", None):
            product_name = item.description
        elif hasattr(item, "product") and item.product:
            product_name = item.product.name
        else:
            product_name = f"Produit #{item.product_id or ''}"
        line_total = item.quantity * item.unit_price
        table_data.append([
            product_name,
            str(item.quantity),
            f"{item.unit_price:,.2f} MAD",
            f"{item.vat_rate}%",
            f"{line_total:,.2f} MAD"
        ])

    items_table = Table(table_data, colWidths=[7*cm, 2*cm, 3.5*cm, 2*cm, 3.5*cm])
    items_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1e3a5f")),
        ("TEXTCOLOR", (0,0), (-1,0), colors.white),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE", (0,0), (-1,-1), 9),
        ("ALIGN", (1,0), (-1,-1), "RIGHT"),
        ("ALIGN", (0,0), (0,-1), "LEFT"),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#f5f5f5")]),
        ("GRID", (0,0), (-1,-1), 0.5, colors.HexColor("#dddddd")),
        ("PADDING", (0,0), (-1,-1), 6),
    ]))
    story.append(items_table)
    story.append(Spacer(1, 0.5*cm))

    # Totals
    totals_data = [
        ["", "Total HT:", f"{invoice.total_excl_tax:,.2f} MAD"],
        ["", "Total TVA:", f"{invoice.vat_amount:,.2f} MAD"],
        ["", "TOTAL TTC:", f"{invoice.total_incl_tax:,.2f} MAD"],
    ]
    totals_table = Table(totals_data, colWidths=[9*cm, 5*cm, 4*cm])
    totals_table.setStyle(TableStyle([
        ("ALIGN", (1,0), (-1,-1), "RIGHT"),
        ("FONTNAME", (0,0), (-1,-1), "Helvetica"),
        ("FONTNAME", (1,2), (-1,2), "Helvetica-Bold"),
        ("FONTSIZE", (0,0), (-1,-1), 9),
        ("FONTSIZE", (1,2), (-1,2), 11),
        ("TEXTCOLOR", (1,2), (-1,2), colors.HexColor("#1e3a5f")),
        ("LINEABOVE", (1,2), (-1,2), 1, colors.HexColor("#1e3a5f")),
        ("PADDING", (0,0), (-1,-1), 4),
    ]))
    story.append(totals_table)
    story.append(Spacer(1, 1*cm))

    # Footer
    footer = Paragraph(
        f"{company_name} - ICE: {company_ice} - IF: {company_if} | {company_addr}",
        ParagraphStyle("footer", fontSize=7, textColor=colors.gray, alignment=TA_CENTER)
    )
    story.append(footer)

    doc.build(story)
    buffer.seek(0)
    return buffer.read()
