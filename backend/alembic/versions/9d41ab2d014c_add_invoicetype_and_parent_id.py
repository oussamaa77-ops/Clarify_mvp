"""Add InvoiceType and parent_id

Revision ID: 9d41ab2d014c
Revises: 002bcfa19dc4
Create Date: 2026-03-20 19:57:07.706002

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9d41ab2d014c'
down_revision: Union[str, Sequence[str], None] = '002bcfa19dc4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    invoicetype = sa.Enum('STANDARD', 'CREDIT_NOTE', name='invoicetype')
    invoicetype.create(op.get_bind(), checkfirst=True)
    
    op.add_column('invoices', sa.Column('type', invoicetype, nullable=False, server_default='STANDARD'))
    op.add_column('invoices', sa.Column('parent_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_invoice_parent_id', 'invoices', 'invoices', ['parent_id'], ['id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_invoice_parent_id', 'invoices', type_='foreignkey')
    op.drop_column('invoices', 'parent_id')
    op.drop_column('invoices', 'type')
    
    invoicetype = sa.Enum('STANDARD', 'CREDIT_NOTE', name='invoicetype')
    invoicetype.drop(op.get_bind(), checkfirst=True)
