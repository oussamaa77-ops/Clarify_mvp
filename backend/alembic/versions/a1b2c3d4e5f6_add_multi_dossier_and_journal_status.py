"""add_multi_dossier_and_journal_status

Revision ID: a1b2c3d4e5f6
Revises: 2946eb65c362
Create Date: 2025-04-19
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ENUM


revision = 'a1b2c3d4e5f6'
down_revision = '2946eb65c362'
branch_labels = None
depends_on = None

# Définition des enums réutilisables
dossierrole = ENUM('CABINET', 'CE', 'COLLABORATEUR', name='dossierrole', create_type=False)
journalentrystatus = ENUM('DRAFT', 'POSTED', name='journalentrystatus', create_type=False)
invitationstatus = ENUM('PENDING', 'ACCEPTED', 'EXPIRED', name='invitationstatus', create_type=False)


def upgrade() -> None:
    # ── Créer les ENUMs manuellement via SQL pur ──────────────────────────────
    conn = op.get_bind()
    conn.execute(sa.text("CREATE TYPE dossierrole AS ENUM ('CABINET', 'CE', 'COLLABORATEUR')"))
    conn.execute(sa.text("CREATE TYPE journalentrystatus AS ENUM ('DRAFT', 'POSTED')"))
    conn.execute(sa.text("CREATE TYPE invitationstatus AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED')"))

    # ── users ─────────────────────────────────────────────────────────────────
    op.add_column('users',
        sa.Column('full_name', sa.String(), nullable=True)
    )

    # ── companies ─────────────────────────────────────────────────────────────
    op.add_column('companies',
        sa.Column('cabinet_user_id', sa.Integer(),
                  sa.ForeignKey('users.id'), nullable=True)
    )
    op.add_column('companies',
        sa.Column('fiscal_year_start_month', sa.Integer(), server_default='1', nullable=False)
    )
    op.add_column('companies',
        sa.Column('is_archived', sa.Boolean(), server_default='false', nullable=False)
    )

    # ── company_users ─────────────────────────────────────────────────────────
    op.add_column('company_users',
        sa.Column('dossier_role', dossierrole, server_default='CE', nullable=False)
    )
    op.add_column('company_users',
        sa.Column('can_validate_journal', sa.Boolean(), server_default='false', nullable=False)
    )
    op.add_column('company_users',
        sa.Column('can_view_bank', sa.Boolean(), server_default='true', nullable=False)
    )
    op.add_column('company_users',
        sa.Column('can_invite_members', sa.Boolean(), server_default='false', nullable=False)
    )
    op.add_column('company_users',
        sa.Column('joined_at', sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=True)
    )

    # ── journal_entries ───────────────────────────────────────────────────────
    op.add_column('journal_entries',
        sa.Column('status', journalentrystatus, server_default='DRAFT', nullable=False)
    )
    op.add_column('journal_entries',
        sa.Column('validated_by', sa.Integer(),
                  sa.ForeignKey('users.id'), nullable=True)
    )
    op.add_column('journal_entries',
        sa.Column('validated_at', sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column('journal_entries',
        sa.Column('source', sa.String(), nullable=True)
    )

    # ── bank_transactions ─────────────────────────────────────────────────────
    op.add_column('bank_transactions',
        sa.Column('is_reconciled', sa.Boolean(), server_default='false', nullable=False)
    )
    op.add_column('bank_transactions',
        sa.Column('journal_entry_id', sa.Integer(),
                  sa.ForeignKey('journal_entries.id'), nullable=True)
    )

    # ── dossier_invitations ───────────────────────────────────────────────────
    op.create_table(
        'dossier_invitations',
        sa.Column('id',          sa.Integer(), primary_key=True),
        sa.Column('company_id',  sa.Integer(), sa.ForeignKey('companies.id'),  nullable=False),
        sa.Column('invited_by',  sa.Integer(), sa.ForeignKey('users.id'),      nullable=False),
        sa.Column('email',       sa.String(),  nullable=False),
        sa.Column('dossier_role', dossierrole, nullable=False, server_default='CE'),
        sa.Column('can_validate_journal', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('token',       sa.String(),  unique=True, nullable=False),
        sa.Column('status',      invitationstatus, nullable=False, server_default='PENDING'),
        sa.Column('expires_at',  sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at',  sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('dossier_invitations')

    op.drop_column('bank_transactions', 'journal_entry_id')
    op.drop_column('bank_transactions', 'is_reconciled')

    op.drop_column('journal_entries', 'source')
    op.drop_column('journal_entries', 'validated_at')
    op.drop_column('journal_entries', 'validated_by')
    op.drop_column('journal_entries', 'status')

    op.drop_column('company_users', 'joined_at')
    op.drop_column('company_users', 'can_invite_members')
    op.drop_column('company_users', 'can_view_bank')
    op.drop_column('company_users', 'can_validate_journal')
    op.drop_column('company_users', 'dossier_role')

    op.drop_column('companies', 'is_archived')
    op.drop_column('companies', 'fiscal_year_start_month')
    op.drop_column('companies', 'cabinet_user_id')

    op.drop_column('users', 'full_name')

    conn = op.get_bind()
    conn.execute(sa.text("DROP TYPE IF EXISTS invitationstatus"))
    conn.execute(sa.text("DROP TYPE IF EXISTS journalentrystatus"))
    conn.execute(sa.text("DROP TYPE IF EXISTS dossierrole"))