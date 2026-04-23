from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List
from app.database import get_db
from app.models.identity import User
from app.models.system import Document
from app.schemas.system import DocumentCreate, DocumentResponse
from app.utils.security import get_current_user, get_current_company_id

router = APIRouter()

@router.get("/", response_model=List[DocumentResponse])
async def read_documents(
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    result = await db.execute(
        select(Document)
        .where(Document.company_id == company_id)
        .order_by(Document.created_at.desc())
    )
    return result.scalars().all()

@router.post("/", response_model=DocumentResponse)
async def upload_document(
    doc_in: DocumentCreate,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    db_doc = Document(
        company_id=company_id,
        name=doc_in.name,
        file_type=doc_in.file_type,
        file_url=doc_in.file_url 
    )
    db.add(db_doc)
    await db.commit()
    await db.refresh(db_doc)
    return db_doc

@router.delete("/{document_id}")
async def delete_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user)
):
    result = await db.execute(
        select(Document)
        .where(Document.id == document_id, Document.company_id == company_id)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
        
    await db.delete(doc)
    await db.commit()
    return {"message": "Document deleted"}
