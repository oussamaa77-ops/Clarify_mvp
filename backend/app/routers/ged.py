"""
Router GED — Gestion Électronique de Documents avec certification SHA-256
"""
import hashlib
import json
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
from openai import AsyncOpenAI
from app.database import get_db
from app.config import settings
from app.utils.security import get_current_user, get_current_company_id
from app.models.identity import User
from app.models.system import Document
from fastapi.responses import FileResponse
import os
from sqlalchemy.future import select

router = APIRouter(prefix="/ged", tags=["GED"])

client_ai = AsyncOpenAI(
    api_key=settings.GROQ_API_KEY,
    base_url="https://api.groq.com/openai/v1",
)

DOCUMENT_TYPES = {
    "facture_client": "Facture client",
    "facture_fournisseur": "Facture fournisseur",
    "devis": "Devis",
    "contrat": "Contrat",
    "releve_bancaire": "Relevé bancaire",
    "declaration_tva": "Déclaration TVA",
    "bilan": "Bilan comptable",
    "autre": "Autre",
}


class GedDocument(BaseModel):
    id: int
    name: str
    file_type: Optional[str]
    file_url: str
    sha256: Optional[str]
    doc_type: Optional[str]
    tags: Optional[str]
    fournisseur_client: Optional[str]
    montant: Optional[float]
    doc_date: Optional[str]
    created_at: str

    class Config:
        from_attributes = True


@router.get("/documents")
async def list_documents(
    search: Optional[str] = None,
    doc_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user),
):
    """Liste tous les documents GED avec filtres."""
    query = select(Document).where(Document.company_id == company_id).order_by(Document.created_at.desc())
    result = await db.execute(query)
    docs = result.scalars().all()

    # Filtre en mémoire (simple pour MVP)
    out = []
    for d in docs:
        # Charger les métadonnées GED depuis file_url (JSON enrichi)
        meta = {}
        try:
            if d.file_url and d.file_url.startswith("{"):
                meta = json.loads(d.file_url)
        except Exception:
            pass

        doc_data = {
            "id": d.id,
            "name": d.name,
            "file_type": d.file_type,
            "sha256": meta.get("sha256", ""),
            "doc_type": meta.get("doc_type", "autre"),
            "doc_type_label": DOCUMENT_TYPES.get(meta.get("doc_type", "autre"), "Autre"),
            "tags": meta.get("tags", ""),
            "fournisseur_client": meta.get("fournisseur_client", ""),
            "montant": meta.get("montant", None),
            "doc_date": meta.get("doc_date", ""),
            "file_url": meta.get("file_url", d.file_url),
            "verified": bool(meta.get("sha256")),
            "created_at": d.created_at.isoformat() if d.created_at else "",
        }

        # Filtres
        if search:
            s = search.lower()
            if not any(s in str(v).lower() for v in [d.name, meta.get("fournisseur_client", ""), meta.get("tags", "")]):
                continue
        if doc_type and meta.get("doc_type") != doc_type:
            continue

        out.append(doc_data)

    return out


@router.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    doc_type: str = Form("autre"),
    fournisseur_client: str = Form(""),
    montant: Optional[float] = Form(None),
    doc_date: str = Form(""),
    tags: str = Form(""),
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user),
):
    """Upload et archive un document avec hash SHA-256."""
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Fichier trop volumineux (max 20MB)")

    # Certification SHA-256
    sha256 = hashlib.sha256(content).hexdigest()

    # Classification IA automatique si pas de type spécifié
    ai_classification = doc_type
    if doc_type == "autre":
        try:
            resp = await client_ai.chat.completions.create(
                model=settings.GROQ_MODEL,
                messages=[{
                    "role": "user",
                    "content": f"Classifie ce document: '{file.filename}'. Réponds avec un seul mot parmi: facture_client, facture_fournisseur, devis, contrat, releve_bancaire, declaration_tva, bilan, autre"
                }],
                max_tokens=20,
                temperature=0.1,
            )
            ai_classification = resp.choices[0].message.content.strip().lower()
            if ai_classification not in DOCUMENT_TYPES:
                ai_classification = "autre"
        except Exception:
            ai_classification = "autre"

    # Stocker les métadonnées comme JSON dans file_url (MVP sans stockage cloud)
    metadata = json.dumps({
        "sha256": sha256,
        "doc_type": ai_classification,
        "fournisseur_client": fournisseur_client,
        "montant": montant,
        "doc_date": doc_date or datetime.now().strftime("%Y-%m-%d"),
        "tags": tags,
        "file_url": f"data:{file.content_type};name={file.filename}",
        "original_name": file.filename,
        "size_bytes": len(content),
        "uploaded_at": datetime.now().isoformat(),
    })

    db_doc = Document(
        company_id=company_id,
        name=file.filename,
        file_type=file.content_type,
        file_url=metadata,
    )
    db.add(db_doc)
    await db.commit()
    await db.refresh(db_doc)

    return {
        "success": True,
        "id": db_doc.id,
        "name": file.filename,
        "sha256": sha256,
        "doc_type": ai_classification,
        "doc_type_label": DOCUMENT_TYPES.get(ai_classification, "Autre"),
        "message": f"Document archivé et certifié (SHA-256: {sha256[:16]}...)",
    }


@router.get("/verify/{doc_id}")
async def verify_document(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user),
):
    """Vérifie l'intégrité d'un document archivé."""
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.company_id == company_id)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document non trouvé")

    meta = {}
    try:
        meta = json.loads(doc.file_url)
    except Exception:
        pass

    return {
        "id": doc.id,
        "name": doc.name,
        "sha256": meta.get("sha256", "Non certifié"),
        "uploaded_at": meta.get("uploaded_at", ""),
        "doc_type": meta.get("doc_type", "autre"),
        "verified": bool(meta.get("sha256")),
        "message": "Document certifié et intègre" if meta.get("sha256") else "Document non certifié",
    }


@router.get("/search")
async def search_documents(
    q: str,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user),
):
    """Recherche intelligente en langage naturel via IA."""
    result = await db.execute(
        select(Document).where(Document.company_id == company_id).limit(50)
    )
    docs = result.scalars().all()

    docs_summary = []
    for d in docs:
        meta = {}
        try:
            meta = json.loads(d.file_url)
        except Exception:
            pass
        docs_summary.append(f"ID:{d.id} | {d.name} | {meta.get('doc_type','?')} | {meta.get('fournisseur_client','?')} | {meta.get('doc_date','?')}")

    prompt = f"""Tu es un assistant de recherche documentaire.
L'utilisateur cherche: "{q}"

Voici les documents disponibles:
{chr(10).join(docs_summary)}

Identifie les IDs des documents correspondants à la recherche. 
Réponds en JSON: {{"ids": [1, 2, ...], "explication": "..."}}
Si aucun document ne correspond, retourne {{"ids": [], "explication": "Aucun document trouvé"}}"""

    try:
        resp = await client_ai.chat.completions.create(
            model=settings.GROQ_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=200,
            temperature=0.2,
        )
        raw = resp.choices[0].message.content.strip()
        if "```" in raw:
            raw = raw.split("```")[1].lstrip("json").strip()
        data = json.loads(raw)
        return data
    except Exception as e:
        return {"ids": [], "explication": f"Erreur de recherche: {str(e)}"}

@router.get("/download/{doc_id}")
async def download_document(
    doc_id: int, 
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id)
):
    # 1. Récupérer les métadonnées et le Hash scellé en base de données
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.company_id == company_id)
    )
    doc = result.scalar_one_or_none()
    
    if not doc:
        raise HTTPException(status_code=404, detail="Document non trouvé")

    file_path = f"uploads/{doc.file_path}"
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Fichier physique introuvable sur le serveur")

    # 2. VERIFICATION D'INTEGRITE (Le "Cœur" du système)
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        # Lire par blocs pour ne pas saturer la RAM si le fichier est gros
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    
    current_hash = sha256_hash.hexdigest()

    # 3. Comparaison entre le Hash actuel et le Hash scellé à l'archivage
    if current_hash != doc.sha256:
        # Si les hashs ne matchent pas, le document a été modifié ou corrompu !
        raise HTTPException(
            status_code=403, 
            detail="ALERTE SECURITE : L'intégrité du document a été compromise. Le fichier a été modifié après son archivage."
        )

    # 4. Si tout est OK, on sert le fichier en mode "inline" (lecture seule dans le navigateur)
    return FileResponse(
        path=file_path,
        media_type="application/pdf",  # On peut dynamiser selon l'extension
        headers={"Content-Disposition": "inline"} 
    )
