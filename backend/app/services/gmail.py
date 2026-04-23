# backend/app/services/gmail.py
import base64
from email.mime.text import MIMEText
from datetime import datetime

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.identity import GmailIntegration
from app.services.ai import get_ai_response   # On va créer ce fichier plus tard si besoin


async def get_gmail_service(db: AsyncSession, company_id: int, user_id: int):
    """Retourne le service Gmail et l'intégration"""
    result = await db.execute(
        select(GmailIntegration).where(
            GmailIntegration.company_id == company_id,
            GmailIntegration.user_id == user_id
        )
    )
    integration = result.scalar_one_or_none()
    if not integration:
        return None, None

    creds = Credentials(
        token=None,
        refresh_token=integration.refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id="TON_CLIENT_ID_GOOGLE",           # ← À remplir plus tard
        client_secret="TON_CLIENT_SECRET_GOOGLE"    # ← À remplir plus tard
    )

    service = build('gmail', 'v1', credentials=creds)
    return service, integration


async def send_gmail_reply(service, to_email: str, subject: str, body: str):
    """Envoie une réponse par Gmail"""
    message = MIMEText(body)
    message['to'] = to_email
    message['subject'] = f"Re: {subject}"

    raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode()
    service.users().messages().send(userId="me", body={"raw": raw_message}).execute()


async def check_new_emails_and_reply(db: AsyncSession, company_id: int, user_id: int):
    """Vérifie les nouveaux emails non lus et demande à l'IA de répondre"""
    service, integration = await get_gmail_service(db, company_id, user_id)
    if not service or not integration:
        return

    try:
        # Récupérer les emails non lus (max 5 pour ne pas surcharger)
        results = service.users().messages().list(
            userId='me',
            q='is:unread',
            maxResults=5
        ).execute()

        messages = results.get('messages', [])

        for msg in messages:
            msg_data = service.users().messages().get(
                userId='me', 
                id=msg['id'], 
                format='full'
            ).execute()

            # Extraire en-têtes
            headers = {h['name'].lower(): h['value'] for h in msg_data.get('payload', {}).get('headers', [])}
            subject = headers.get('subject', '(sans sujet)')
            from_email = headers.get('from', '')

            # Extraire le corps texte
            body_text = ""
            payload = msg_data.get('payload', {})
            if 'parts' in payload:
                for part in payload['parts']:
                    if part.get('mimeType') == 'text/plain':
                        data = part.get('body', {}).get('data', '')
                        if data:
                            body_text = base64.urlsafe_b64decode(data).decode('utf-8')
                        break

            if not body_text.strip():
                continue

            # Prompt pour l'assistant IA Grok
            ai_prompt = f"""Un client t'a envoyé cet email via Gmail :

De : {from_email}
Sujet : {subject}

Contenu du message :
{body_text}

Tu es un assistant comptable IA professionnel pour une entreprise marocaine.
Réponds de manière courtoise, claire et professionnelle en français.
Utilise tes tools si nécessaire (factures, clients, produits, TVA, etc.).
Propose des actions concrètes si pertinent (créer une facture, un devis, etc.)."""

            # Appeler l'IA
            ai_response = await get_ai_response(
                company_id=company_id,
                user_id=user_id,
                message=ai_prompt
            )

            # Envoyer la réponse
            await send_gmail_reply(service, from_email, subject, ai_response)

            # Marquer l'email comme lu
            service.users().messages().modify(
                userId='me',
                id=msg['id'],
                body={'removeLabelIds': ['UNREAD']}
            ).execute()

            print(f"✅ Email traité et réponse envoyée à {from_email}")

    except Exception as e:
        print(f"❌ Erreur lors de la vérification des emails Gmail : {e}")