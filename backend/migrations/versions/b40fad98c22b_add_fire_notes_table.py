"""add fire_notes table

Revision ID: b40fad98c22b
Revises: 5e6f2ea48eea
Create Date: 2026-08-02 00:00:00.000000

Free-text analyst commentary per fire, independent of the acquisition
workflow - a real timestamped trail (own table, own rows), not a single
editable field on `fires`, so a later observation never silently
overwrites an earlier one. lat/lon are optional and unused for now -
reserved for a future "pin this note to a map point" feature.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b40fad98c22b'
down_revision: Union[str, Sequence[str], None] = '5e6f2ea48eea'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'fire_notes',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('fire_id', sa.String(), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.Column('lat', sa.Numeric(), nullable=True),
        sa.Column('lon', sa.Numeric(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['fire_id'], ['fires.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('fire_notes')
