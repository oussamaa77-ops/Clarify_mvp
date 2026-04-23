FROM python:3.11-slim-bullseye

WORKDIR /app

# Installation des dépendances système
# On ajoute poppler-utils à la liste pour permettre à pdf2image de fonctionner
RUN apt-get update && apt-get install -y \
    build-essential \
    libpq-dev \
    wkhtmltopdf \
    poppler-utils \
    # Tesseract pour extraire le texte des images (OCR)
    tesseract-ocr \
    # Pack de langue française pour Tesseract
    tesseract-ocr-fra \
    && rm -rf /var/lib/apt/lists/*

# Copie et installation des dépendances Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copie du reste du code source
COPY . .

# Port exposé par le conteneur
EXPOSE 8000

# Commande de lancement de l'application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
