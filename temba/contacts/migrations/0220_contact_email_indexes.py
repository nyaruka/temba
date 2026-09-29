from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models
from django.db.migrations.operations.models import AddIndex


class AddIndexConcurrentlyPlainReverse(AddIndexConcurrently):
    """
    Adds the index concurrently but reverses with a plain drop, so that migration tests - which roll the graph
    backwards inside a transaction - can unapply it.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        AddIndex.database_backwards(self, app_label, schema_editor, from_state, to_state)


class Migration(migrations.Migration):
    # index builds on the contacts table can't hold ACCESS EXCLUSIVE for their duration, so both are created
    # concurrently. Django has no concurrent AddConstraint so the unique index behind the constraint is created by
    # hand with the constraint recorded in migration state. Installations large enough to care can build them ahead
    # of the deploy and fake this migration:
    #
    #   CREATE INDEX CONCURRENTLY contacts_by_email ON contacts_contact (org_id, email) WHERE email IS NOT NULL;
    #   CREATE UNIQUE INDEX CONCURRENTLY unique_verified_contact_emails ON contacts_contact (org_id, email)
    #   WHERE email_verified_on IS NOT NULL;
    #
    atomic = False

    dependencies = [
        ("contacts", "0219_contact_email"),
    ]

    operations = [
        AddIndexConcurrentlyPlainReverse(
            model_name="contact",
            index=models.Index(
                condition=models.Q(("email__isnull", False)),
                fields=["org", "email"],
                name="contacts_by_email",
            ),
        ),
        migrations.RunSQL(
            sql="""
            CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "unique_verified_contact_emails"
            ON "contacts_contact" ("org_id", "email") WHERE "email_verified_on" IS NOT NULL
            """,
            reverse_sql='DROP INDEX IF EXISTS "unique_verified_contact_emails"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="contact",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("email_verified_on__isnull", False)),
                        fields=("org", "email"),
                        name="unique_verified_contact_emails",
                    ),
                ),
            ],
        ),
    ]
