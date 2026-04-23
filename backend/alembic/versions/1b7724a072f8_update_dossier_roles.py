"""update_dossier_roles

Revision ID: 1b7724a072f8
Revises: a1b2c3d4e5f6
Create Date: 2026-04-21 10:15:17.586406

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1b7724a072f8'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE dossierrole ADD VALUE IF NOT EXISTS 'COLLABORATEUR_CABINET'")
    op.execute("ALTER TYPE dossierrole ADD VALUE IF NOT EXISTS 'ASSISTANT_CABINET'")
    op.execute("ALTER TYPE dossierrole ADD VALUE IF NOT EXISTS 'COLLABORATEUR_CE'")

def downgrade() -> None:
    pass
