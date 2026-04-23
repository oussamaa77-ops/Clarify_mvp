from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PROJECT_NAME: str = "Moroccan Accounting SaaS"
    
    # Base de données
    DATABASE_URL: str = "postgresql+asyncpg://postgres:password@localhost:5432/accounting_saas"
    
    # Sécurité
    SECRET_KEY: str = "supersecretkey-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440
    
    # IA - Moteur Gemini (Nouveau standard de ton app)
    GROQ_API_KEY: str = ""
    GROQ_MODEL: str = "llama-3.3-70b-versatile"

    class Config:
        env_file = ".env"

settings = Settings()
