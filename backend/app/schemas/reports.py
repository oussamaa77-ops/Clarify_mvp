from pydantic import BaseModel
from typing import List, Optional
from datetime import date

# --- Reporting Schemas ---

class DashboardKPis(BaseModel):
    monthly_revenue: float
    unpaid_invoices_count: int
    unpaid_invoices_total: float
    total_expenses: float
    vat_due: float
    supplier_debt: float = 0.0      # Ce que tu dois aux fournisseurs
    cash_position: float = 0.0      # Ta trésorerie théorique

class ChartDataPoint(BaseModel):
    label: str
    value: float

class DashboardResponse(BaseModel):
    kpis: DashboardKPis
    revenue_chart: List[ChartDataPoint]
    expense_chart: List[ChartDataPoint]

class VatReportResponse(BaseModel):
    period: str
    collected_vat: float
    deductible_vat: float
    net_vat_due: float
