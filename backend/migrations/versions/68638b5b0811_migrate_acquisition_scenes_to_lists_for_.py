"""migrate acquisition scenes to lists for composite mode

Revision ID: 68638b5b0811
Revises: 5ccba1386d1d
Create Date: 2026-07-30 16:52:54.392480

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '68638b5b0811'
down_revision: Union[str, Sequence[str], None] = '5ccba1386d1d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'fires', sa.Column('acquisition_before_scenes', postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )
    op.add_column(
        'fires', sa.Column('acquisition_after_scenes', postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )

    # Preserve any existing single-scene selections as single-element
    # lists rather than silently dropping them.
    op.execute(
        "UPDATE fires SET acquisition_before_scenes = jsonb_build_array(acquisition_before_scene) "
        "WHERE acquisition_before_scene IS NOT NULL"
    )
    op.execute(
        "UPDATE fires SET acquisition_after_scenes = jsonb_build_array(acquisition_after_scene) "
        "WHERE acquisition_after_scene IS NOT NULL"
    )

    op.drop_column('fires', 'acquisition_before_scene')
    op.drop_column('fires', 'acquisition_after_scene')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('fires', sa.Column('acquisition_before_scene', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('fires', sa.Column('acquisition_after_scene', postgresql.JSONB(astext_type=sa.Text()), nullable=True))

    # Best-effort: takes the first scene of the list back into a single object.
    op.execute(
        "UPDATE fires SET acquisition_before_scene = acquisition_before_scenes->0 "
        "WHERE acquisition_before_scenes IS NOT NULL"
    )
    op.execute(
        "UPDATE fires SET acquisition_after_scene = acquisition_after_scenes->0 "
        "WHERE acquisition_after_scenes IS NOT NULL"
    )

    op.drop_column('fires', 'acquisition_before_scenes')
    op.drop_column('fires', 'acquisition_after_scenes')
