import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("knowledge", "0017_drop_articlecount"),
        ("orgs", "0215_drop_redundant_fk_indexes"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "knowledge_article_knowledge_id_48c2fb9b"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "knowledge_article_knowledge_id_48c2fb9b"'
                ' ON "knowledge_article" ("source_id")'
            ),
            state_operations=[
                migrations.AlterField(
                    model_name="article",
                    name="source",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="articles",
                        to="knowledge.knowledgesource",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "knowledge_helpdeskimport_knowledge_id_916643bf"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "knowledge_helpdeskimport_knowledge_id_916643bf"'
                ' ON "knowledge_helpdeskimport" ("source_id")'
            ),
            state_operations=[
                migrations.AlterField(
                    model_name="helpdeskimport",
                    name="source",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="imports",
                        to="knowledge.knowledgesource",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "knowledge_knowledgechunk_knowledge_id_820e8e9f"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "knowledge_knowledgechunk_knowledge_id_820e8e9f"'
                ' ON "knowledge_knowledgechunk" ("source_id")'
            ),
            state_operations=[
                migrations.AlterField(
                    model_name="knowledgechunk",
                    name="source",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="chunks",
                        to="knowledge.knowledgesource",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "knowledge_knowledgeitem_knowledge_id_9f3ce431"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "knowledge_knowledgeitem_knowledge_id_9f3ce431"'
                ' ON "knowledge_knowledgeitem" ("source_id")'
            ),
            state_operations=[
                migrations.AlterField(
                    model_name="knowledgeitem",
                    name="source",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="items",
                        to="knowledge.knowledgesource",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "knowledge_knowledge_org_id_d6471729"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "knowledge_knowledge_org_id_d6471729"'
                ' ON "knowledge_knowledgesource" ("org_id")'
            ),
            state_operations=[
                migrations.AlterField(
                    model_name="knowledgesource",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="sources",
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
