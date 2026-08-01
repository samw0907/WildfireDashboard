"""add acquisitions table for multi-acquisition support

Revision ID: 5e6f2ea48eea
Revises: 4db8bdcf5248
Create Date: 2026-08-01 00:00:00.000000

Replaces the single-slot acquisition_* columns on `fires` (only ever room
for one acquisition attempt per fire, ever) with a real one-to-many
`acquisitions` table, so a fire can be re-acquired multiple times as it
evolves. Any existing single acquisition per fire is preserved as
sequence=1.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '5e6f2ea48eea'
down_revision: Union[str, Sequence[str], None] = '4db8bdcf5248'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'acquisitions',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('fire_id', sa.String(), nullable=False),
        sa.Column('sequence', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(), nullable=False),
        sa.Column('before_scenes', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('after_scenes', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('batch_job_id', sa.String(), nullable=True),
        sa.Column('result', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('burn_perimeter', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('building_damage', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('error', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['fire_id'], ['fires.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('fire_id', 'sequence', name='uq_acquisitions_fire_sequence'),
    )

    # Preserve any existing single acquisition per fire as sequence=1,
    # rather than silently dropping real history/in-flight jobs.
    op.execute(
        """
        INSERT INTO acquisitions (
            fire_id, sequence, status, before_scenes, after_scenes,
            confirmed_at, batch_job_id, result, burn_perimeter,
            building_damage, error, created_at
        )
        SELECT
            id, 1, acquisition_status, acquisition_before_scenes, acquisition_after_scenes,
            acquisition_confirmed_at, acquisition_batch_job_id, acquisition_result,
            acquisition_burn_perimeter, acquisition_building_damage, acquisition_error,
            COALESCE(acquisition_confirmed_at, ingested_at)
        FROM fires
        WHERE acquisition_status IS NOT NULL
        """
    )

    op.drop_column('fires', 'acquisition_status')
    op.drop_column('fires', 'acquisition_before_scenes')
    op.drop_column('fires', 'acquisition_after_scenes')
    op.drop_column('fires', 'acquisition_confirmed_at')
    op.drop_column('fires', 'acquisition_batch_job_id')
    op.drop_column('fires', 'acquisition_result')
    op.drop_column('fires', 'acquisition_burn_perimeter')
    op.drop_column('fires', 'acquisition_building_damage')
    op.drop_column('fires', 'acquisition_error')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('fires', sa.Column('acquisition_status', sa.String(), nullable=True))
    op.add_column('fires', sa.Column('acquisition_before_scenes', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('fires', sa.Column('acquisition_after_scenes', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('fires', sa.Column('acquisition_confirmed_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('fires', sa.Column('acquisition_batch_job_id', sa.String(), nullable=True))
    op.add_column('fires', sa.Column('acquisition_result', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('fires', sa.Column('acquisition_burn_perimeter', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('fires', sa.Column('acquisition_building_damage', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('fires', sa.Column('acquisition_error', sa.String(), nullable=True))

    # Best-effort: only the latest acquisition per fire survives a
    # downgrade, since the old schema only ever had room for one.
    op.execute(
        """
        UPDATE fires SET
            acquisition_status = a.status,
            acquisition_before_scenes = a.before_scenes,
            acquisition_after_scenes = a.after_scenes,
            acquisition_confirmed_at = a.confirmed_at,
            acquisition_batch_job_id = a.batch_job_id,
            acquisition_result = a.result,
            acquisition_burn_perimeter = a.burn_perimeter,
            acquisition_building_damage = a.building_damage,
            acquisition_error = a.error
        FROM (
            SELECT DISTINCT ON (fire_id) *
            FROM acquisitions
            ORDER BY fire_id, sequence DESC
        ) a
        WHERE fires.id = a.fire_id
        """
    )

    op.drop_table('acquisitions')
