from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0213_drop_dailycount"),
    ]

    operations = [
        migrations.RemoveConstraint(model_name="org", name="orgs_org_status_consistent"),
        # staff restrictions no longer lead to suspension
        migrations.RunSQL(
            "UPDATE orgs_org SET suspends_on = NULL WHERE status = 'R' AND status_reason = 'S';", migrations.RunSQL.noop
        ),
        migrations.AddConstraint(
            model_name="org",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(("status", "A"), ("status_reason__isnull", True), ("suspends_on__isnull", True)),
                    models.Q(("status", "R"), ("status_changed_on__isnull", False), ("status_reason__isnull", False)),
                    models.Q(("status", "S"), ("status_changed_on__isnull", False), ("suspends_on__isnull", True)),
                    _connector="OR",
                ),
                name="orgs_org_status_consistent",
            ),
        ),
    ]
