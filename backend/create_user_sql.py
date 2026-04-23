import asyncio
from sqlalchemy import text
from passlib.context import CryptContext
from app.database import AsyncSessionLocal

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

async def main():
    async with AsyncSessionLocal() as db:
        try:
            pwd = pwd_context.hash("password123")
            
            # Create company
            res = await db.execute(text("INSERT INTO companies (name) VALUES ('Hissabi Demo') RETURNING id"))
            company_id = res.scalar()
            
            # Create user
            res = await db.execute(text(f"INSERT INTO users (email, hashed_password, is_active) VALUES ('admin@hissabi.ma', '{pwd}', true) RETURNING id"))
            user_id = res.scalar()
            
            # Link user and company
            await db.execute(text(f"INSERT INTO company_users (user_id, company_id, role) VALUES ({user_id}, {company_id}, 'ADMIN')"))
            
            await db.commit()
            print("Done DB Insert")
        except Exception as e:
            print("Error:", e)

if __name__ == "__main__":
    asyncio.run(main())
