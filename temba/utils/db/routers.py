REPLICA_POOL = {"default", "readonly"}


class ReadonlyRouter:
    """
    Treats the readonly connection as a replica of default. Reads only go to it when a queryset asks for it explicitly,
    but instances read from it can be related to instances from default, and saving them writes to default.
    """

    def db_for_write(self, model, **hints):
        return "default"

    def allow_relation(self, obj1, obj2, **hints):
        if obj1._state.db in REPLICA_POOL and obj2._state.db in REPLICA_POOL:
            return True
        return None
