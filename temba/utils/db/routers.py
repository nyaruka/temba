REPLICA_POOL = {"default", "readonly"}


class ReadonlyRouter:
    """
    Treats the readonly connection as a replica of default, so instances read from it can be related to instances from
    default. Saving an instance read from it still writes through it, and so fails, rather than overwriting the primary
    with what may be stale values.
    """

    def allow_relation(self, obj1, obj2, **hints):
        return obj1._state.db in REPLICA_POOL and obj2._state.db in REPLICA_POOL
