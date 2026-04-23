from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.database import engine  # On garde l'engine pour la connexion
from app.models.identity import Base, User, Company, CompanyUser # On prend Base et les modèles ici

# Import Routers
from app.routers import auth, crm, catalog, billing, reports, accounting, ai, settings as site_settings, documents, ocr, ged, alertes, dossiers

app = FastAPI(title=settings.PROJECT_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"], 
    allow_headers=["*"], # On autorise TOUT pour le debug
    expose_headers=["*"]
)

# Register Routers
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(crm.router, prefix="/api", tags=["crm"])
app.include_router(catalog.router, prefix="/api", tags=["catalog"])
app.include_router(billing.router, prefix="/api", tags=["billing"])
app.include_router(reports.router, prefix="/api/reports", tags=["reports"])
app.include_router(accounting.router, prefix="/api/accounting", tags=["accounting"])
app.include_router(site_settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(documents.router, prefix="/api/documents", tags=["documents"])
app.include_router(ai.router, prefix="/api", tags=["assistant-ia"])
app.include_router(ocr.router, prefix="/api", tags=["ocr"])
app.include_router(ged.router, prefix="/api", tags=["ged"])
app.include_router(alertes.router, prefix="/api", tags=["alertes"])
app.include_router(dossiers.router, prefix="/api", tags=["dossiers"])






@app.on_event("startup")
async def startup():
    async with engine.begin() as conn:
        # On importe le fichier identity qui contient User, Company, etc.
        from app.models.identity import User, Company, CompanyUser
        
        # Maintenant SQLAlchemy "voit" les tables et peut les créer
        await conn.run_sync(Base.metadata.create_all)
    print("🚀 Tables créées avec succès dans accounting_saas !")


@app.get("/")
def read_root():
    return {"message": "Welcome to the Moroccan Accounting SaaS API"}

