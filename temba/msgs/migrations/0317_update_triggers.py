from django.db import migrations, models

# archived is no longer a message visibility - mailroom and courier stopped writing it, and 0316 cleared it from the
# messages that predate that - so the value goes, and with it the visibility half of the guard against archiving
# outgoing messages. The folder half is all that's needed now that the folder is the only record of being archived.
SQL = """
----------------------------------------------------------------------
-- Trigger procedure to update user and system labels on column changes
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION temba_msg_on_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    -- prevent illegal message states
    IF NEW.direction = 'I' AND NEW.status NOT IN ('P', 'H') THEN
      RAISE EXCEPTION 'Incoming messages can only be PENDING or HANDLED';
    END IF;
    IF NEW.direction = 'O' AND NEW.folder = 'A' THEN
      RAISE EXCEPTION 'Outgoing messages cannot be archived';
    END IF;
  END IF;

  -- existing message updated
  IF TG_OP = 'UPDATE' THEN
    -- restrict changes
    IF NEW.direction <> OLD.direction THEN RAISE EXCEPTION 'Cannot change direction on messages'; END IF;
    IF NEW.created_on <> OLD.created_on THEN RAISE EXCEPTION 'Cannot change created_on on messages'; END IF;
    IF NEW.msg_type <> OLD.msg_type THEN RAISE EXCEPTION 'Cannot change msg_type on messages'; END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
"""

# the previous definition, which also checked visibility, so that this can be unapplied
REVERSE_SQL = """
----------------------------------------------------------------------
-- Trigger procedure to update user and system labels on column changes
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION temba_msg_on_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    -- prevent illegal message states
    IF NEW.direction = 'I' AND NEW.status NOT IN ('P', 'H') THEN
      RAISE EXCEPTION 'Incoming messages can only be PENDING or HANDLED';
    END IF;
    IF NEW.direction = 'O' AND (NEW.visibility = 'A' OR NEW.folder = 'A') THEN
      RAISE EXCEPTION 'Outgoing messages cannot be archived';
    END IF;
  END IF;

  -- existing message updated
  IF TG_OP = 'UPDATE' THEN
    -- restrict changes
    IF NEW.direction <> OLD.direction THEN RAISE EXCEPTION 'Cannot change direction on messages'; END IF;
    IF NEW.created_on <> OLD.created_on THEN RAISE EXCEPTION 'Cannot change created_on on messages'; END IF;
    IF NEW.msg_type <> OLD.msg_type THEN RAISE EXCEPTION 'Cannot change msg_type on messages'; END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("msgs", "0316_backfill_msg_visibility"),
    ]

    operations = [
        migrations.AlterField(
            model_name="msg",
            name="visibility",
            field=models.CharField(
                choices=[("V", "Visible"), ("D", "Deleted by user"), ("X", "Deleted by sender")],
                default="V",
                max_length=1,
            ),
        ),
        migrations.RunSQL(SQL, REVERSE_SQL),
    ]
