import asyncio
from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.identity import User, Company, CompanyUser, RoleEnum
from app.utils.security import get_password_hash

async def main():
    async with AsyncSessionLocal() as db:
        # check if already exists
        result = await db.execute(select(User).where(User.email == "admin@hissabi.ma"))
        user = result.scalars().first()
        if user:
            print("User already exists")
            return
            
        company = Company(name="Hissabi Demo")
        db.add(company)
        await db.flush()
        
        user = User(
            email="admin@hissabi.ma",
            hashed_password=get_password_hash("password123"),
            is_active=True
        )
        db.add(user)
        await db.flush()
        
        company_user = CompanyUser(
            user_id=user.id,
            company_id=company.id,
            role=RoleEnum.ADMIN
        )
        db.add(company_user)
        await db.commit()
        print("User created successfully!")

if __name__ == "__main__":
    asyncio.run(main())
