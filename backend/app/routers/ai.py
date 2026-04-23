from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.services.ai import get_ai_response
from app.utils.security import get_current_user
from app.models.identity import User

router = APIRouter(prefix="/ai", tags=["Assistant IA"])

class ChatRequest(BaseModel):
    message: str

@router.post("/chat")
async def chat_with_ia(
    request: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    try:
        result = await db.execute(
            select(User)
            .options(selectinload(User.company_associations))
            .where(User.id == current_user.id)
        )
        user_with_data = result.scalar_one()

        company_id = 1
        if user_with_data.company_associations:
            assoc = user_with_data.company_associations[0]
            company_id = getattr(assoc, 'company_id', 1)

        response = await get_ai_response(
            company_id=company_id,
            user_id=user_with_data.id,
            message=request.message,
            db=db
        )

        return {"reply": response}

    except Exception as e:
        print(f"Erreur Router AI: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
